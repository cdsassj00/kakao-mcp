import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { buildGraph, renderGraphSvg } from "./graph.js";
import { detectRoomName, parseKakaoExport } from "./kakao-parser.js";
import { buildOntologyServer } from "./ontology-tools.js";
import { MemoryStore, StoreError } from "./store.js";
import { renderUploadPage } from "./upload-page.js";

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? "data/ontology.db";
const PUBLIC_URL = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");

function openStore(path: string): MemoryStore {
  if (path === ":memory:") return new MemoryStore(path);
  try {
    mkdirSync(dirname(path), { recursive: true });
    return new MemoryStore(path);
  } catch (error) {
    const fallback = "/tmp/ontology.db";
    console.warn(`DB 경로(${path})를 열 수 없어 ${fallback}로 폴백합니다:`, error);
    return new MemoryStore(fallback);
  }
}
const store = openStore(DB_PATH);

function inferPublicUrl(req: express.Request): string {
  const host = req.get("host");
  if (!host) return "";
  const isLocal = host.startsWith("localhost") || host.startsWith("127.");
  return `${isLocal ? "http" : "https"}://${host}`;
}

export function createOntologyApp(sharedStore: MemoryStore = store, publicUrl: string = PUBLIC_URL) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: "inmaek-ontology-mcp" });
  });

  app.get("/upload", (req, res) => {
    res.type("html").send(renderUploadPage(String(req.query.box_key ?? ""), "인맥 온톨로지", "🕸️"));
  });

  // 관계망 지도 SVG — relationship_map 도구가 이 주소를 안내한다
  app.get("/map", (req, res) => {
    const boxKey = String(req.query.box_key ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(boxKey) || !sharedStore.getBox(boxKey)) {
      res.status(404).type("text").send("관계망을 찾을 수 없습니다. box_key를 확인해 주세요.");
      return;
    }
    const me = String(req.query.me ?? "").trim() || undefined;
    const graph = buildGraph(sharedStore.exportChat(boxKey));
    res.type("image/svg+xml").send(renderGraphSvg(graph, me));
  });

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

  app.post("/mcp", async (req, res) => {
    const server = buildOntologyServer(sharedStore, { publicUrl: publicUrl || inferPublicUrl(req) });
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

const isDirectRun = process.argv[1]?.endsWith("ontology-server.js") || process.argv[1]?.endsWith("ontology-server.ts");
if (isDirectRun) {
  createOntologyApp().listen(PORT, () => {
    console.log(`inmaek-ontology MCP server listening on :${PORT} (db: ${DB_PATH})`);
  });
}
