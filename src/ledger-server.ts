import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { LedgerStore } from "./ledger-store.js";
import { buildLedgerServer } from "./ledger-tools.js";

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? "data/ledger.db";

function openStore(path: string): LedgerStore {
  if (path === ":memory:") return new LedgerStore(path);
  try {
    mkdirSync(dirname(path), { recursive: true });
    return new LedgerStore(path);
  } catch (error) {
    const fallback = "/tmp/ledger.db";
    console.warn(`DB 경로(${path})를 열 수 없어 ${fallback}로 폴백합니다:`, error);
    return new LedgerStore(fallback);
  }
}
const store = openStore(DB_PATH);

export function createLedgerApp(sharedStore: LedgerStore = store) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: "mal-gagyebu-mcp" });
  });

  app.post("/mcp", async (req, res) => {
    const server = buildLedgerServer(sharedStore);
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

const isDirectRun = process.argv[1]?.endsWith("ledger-server.js") || process.argv[1]?.endsWith("ledger-server.ts");
if (isDirectRun) {
  createLedgerApp().listen(PORT, () => {
    console.log(`mal-gagyebu MCP server listening on :${PORT} (db: ${DB_PATH})`);
  });
}
