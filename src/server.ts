import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { detectRoomName, parseKakaoExport } from "./kakao-parser.js";
import { MemoryStore, StoreError } from "./store.js";
import { buildServer } from "./tools.js";
import { renderUploadPage } from "./upload-page.js";

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? "data/memories.db";
const PUBLIC_URL = (
  process.env.PUBLIC_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "")
).replace(/\/$/, "");

// K8s 등 실행 환경에 따라 DB_PATH가 쓰기 불가일 수 있으므로 /tmp로 폴백한다.
function openStore(path: string): MemoryStore {
  if (path === ":memory:") return new MemoryStore(path);
  try {
    mkdirSync(dirname(path), { recursive: true });
    return new MemoryStore(path);
  } catch (error) {
    const fallback = "/tmp/memories.db";
    console.warn(`DB 경로(${path})를 열 수 없어 ${fallback}로 폴백합니다:`, error);
    return new MemoryStore(fallback);
  }
}
const store = openStore(DB_PATH);

export function createApp(sharedStore: MemoryStore = store, publicUrl: string = PUBLIC_URL) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: "remember-talk-mcp" });
  });

  // 대화 내보내기 파일 업로드 페이지 (모바일/PC 공용). AI 챗의 upload_page_link
  // 도구가 이 주소를 사용자에게 안내한다.
  app.get("/upload", (req, res) => {
    res.type("html").send(renderUploadPage(String(req.query.box_key ?? "")));
  });

  // 업로드 페이지와 감시 폴더 스크립트(scripts/watch-uploads.mjs)가 사용하는
  // 대화 파일 업로드 엔드포인트. '대화 내보내기' 텍스트를 통째로 받아 파싱·적재한다.
  app.post("/import", express.text({ type: "*/*", limit: "30mb" }), (req, res) => {
    const boxKey = String(req.query.box_key ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(boxKey) || !sharedStore.getBox(boxKey)) {
      res.status(401).json({ ok: false, error: "유효한 box_key가 필요합니다." });
      return;
    }
    const body = typeof req.body === "string" ? req.body : "";
    const room = String(req.query.room ?? "").trim() || detectRoomName(body);
    if (!room) {
      res.status(400).json({ ok: false, error: "채팅방 이름을 인식하지 못했습니다. ?room= 파라미터로 지정해 주세요." });
      return;
    }
    const parsed = parseKakaoExport(body);
    if (parsed.length === 0) {
      res.status(400).json({ ok: false, error: "카카오톡 내보내기 형식의 메시지를 찾지 못했습니다." });
      return;
    }
    try {
      // 같은 방을 다시 업로드하면 전체를 갈아끼워 중복을 방지한다 (재내보내기 = 최신 전체본).
      const replaced = sharedStore.deleteRoom(boxKey, room);
      const result = sharedStore.importChatMessages(boxKey, room, parsed);
      res.json({ ok: true, room, imported: result.imported, replaced, total: result.total });
    } catch (error) {
      if (error instanceof StoreError) {
        res.status(422).json({ ok: false, error: error.message });
        return;
      }
      throw error;
    }
  });

  // Stateless Streamable HTTP: 요청마다 서버/트랜스포트를 생성해
  // 세션 상태 없이 수평 확장이 가능하도록 한다.
  app.post("/mcp", async (req, res) => {
    const server = buildServer(sharedStore, { publicUrl: publicUrl || inferPublicUrl(req) });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP request error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const methodNotAllowed = (_req: express.Request, res: express.Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null,
    });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  return app;
}

// PUBLIC_URL 미설정 환경(PlayMCP in KC 등)에서는 요청 Host로 공개 주소를 유추한다.
// 로컬 접속만 http로 취급하고, 외부 도메인은 인그레스 뒤에 있어도 https로 안내한다.
function inferPublicUrl(req: express.Request): string {
  const host = req.get("host");
  if (!host) return "";
  const isLocal = host.startsWith("localhost") || host.startsWith("127.");
  return `${isLocal ? "http" : "https"}://${host}`;
}

const isDirectRun = process.argv[1]?.endsWith("server.js") || process.argv[1]?.endsWith("server.ts");
if (isDirectRun) {
  createApp().listen(PORT, () => {
    console.log(`remember-talk MCP server listening on :${PORT} (db: ${DB_PATH})`);
  });
}
