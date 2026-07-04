import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MemoryStore } from "./store.js";
import { buildServer } from "./tools.js";

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? "data/memories.db";

if (DB_PATH !== ":memory:") {
  mkdirSync(dirname(DB_PATH), { recursive: true });
}
const store = new MemoryStore(DB_PATH);

export function createApp(sharedStore: MemoryStore = store) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: "remember-talk-mcp" });
  });

  // Stateless Streamable HTTP: 요청마다 서버/트랜스포트를 생성해
  // 세션 상태 없이 수평 확장이 가능하도록 한다.
  app.post("/mcp", async (req, res) => {
    const server = buildServer(sharedStore);
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

const isDirectRun = process.argv[1]?.endsWith("server.js") || process.argv[1]?.endsWith("server.ts");
if (isDirectRun) {
  createApp().listen(PORT, () => {
    console.log(`remember-talk MCP server listening on :${PORT} (db: ${DB_PATH})`);
  });
}
