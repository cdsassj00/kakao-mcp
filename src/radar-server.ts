import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fetchLhNotices } from "./lh-client.js";
import { RadarStore } from "./radar-store.js";
import { buildRadarServer } from "./radar-tools.js";

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? "data/radar.db";
const REFRESH_INTERVAL_MS = 6 * 3600_000;

function openStore(path: string): RadarStore {
  if (path === ":memory:") return new RadarStore(path);
  try {
    mkdirSync(dirname(path), { recursive: true });
    return new RadarStore(path);
  } catch (error) {
    const fallback = "/tmp/radar.db";
    console.warn(`DB 경로(${path})를 열 수 없어 ${fallback}로 폴백합니다:`, error);
    return new RadarStore(fallback);
  }
}
const store = openStore(DB_PATH);

/** 서비스키: 환경변수(LH_SERVICE_KEY)가 있으면 우선, 없으면 /setup으로 저장된 값 */
function resolveServiceKey(target: RadarStore): string | null {
  return process.env.LH_SERVICE_KEY?.trim() || target.getConfig("lh_service_key");
}

/** LH 공고를 수집해 DB에 반영. 키가 없으면 조용히 건너뛴다 */
export async function refreshNotices(target: RadarStore = store): Promise<{ fetched: number; added: number } | null> {
  const serviceKey = resolveServiceKey(target);
  if (!serviceKey) return null;
  const { notices } = await fetchLhNotices(serviceKey);
  let added = 0;
  for (const notice of notices) {
    if (target.upsertNotice(notice).isNew) added += 1;
  }
  target.setConfig("last_refresh", new Date().toISOString());
  console.log(`공고 수집 완료: ${notices.length}건 확인, 신규 ${added}건`);
  return { fetched: notices.length, added };
}

export function createRadarApp(sharedStore: RadarStore = store) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: "home-radar-mcp", notices: sharedStore.noticeStats().total });
  });

  // 배포 후 1회 실행하는 설정 엔드포인트 (KC 환경변수 미지원 대응):
  //   curl -X POST "https://<주소>/setup" -d '{"service_key":"..."}' -H 'Content-Type: application/json'
  // 최초 설정 시 admin_token을 반환하며, 이후 교체는 그 토큰이 있어야 가능하다.
  app.post("/setup", async (req, res) => {
    const serviceKey = String(req.body?.service_key ?? "").trim();
    const adminToken = req.body?.admin_token ? String(req.body.admin_token) : undefined;
    if (!serviceKey || serviceKey.length < 10) {
      res.status(400).json({ ok: false, error: "service_key(공공데이터포털 인증키)가 필요합니다." });
      return;
    }
    const result = sharedStore.configureServiceKey(serviceKey, adminToken);
    if (!result.ok) {
      res.status(403).json({ ok: false, error: result.error });
      return;
    }
    try {
      const refreshed = await refreshNotices(sharedStore);
      res.json({ ok: true, admin_token: result.adminToken, refreshed });
    } catch (error) {
      res.json({
        ok: true,
        admin_token: result.adminToken,
        refreshed: null,
        warning: `키는 저장했지만 첫 수집에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

  app.post("/mcp", async (req, res) => {
    const server = buildRadarServer(sharedStore);
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

const isDirectRun = process.argv[1]?.endsWith("radar-server.js") || process.argv[1]?.endsWith("radar-server.ts");
if (isDirectRun) {
  createRadarApp().listen(PORT, () => {
    console.log(`home-radar MCP server listening on :${PORT} (db: ${DB_PATH})`);
  });
  void refreshNotices().catch((error) => console.error("초기 수집 실패:", error));
  setInterval(() => {
    void refreshNotices().catch((error) => console.error("주기 수집 실패:", error));
  }, REFRESH_INTERVAL_MS);
}
