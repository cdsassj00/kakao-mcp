import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";
import { MemoryStore } from "../src/store.js";

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as { type: string; text?: string }[];
  return content.map((c) => c.text ?? "").join("\n");
}

describe("사람사전 MCP server", () => {
  let httpServer: Server;
  let client: Client;

  beforeAll(async () => {
    const app = createApp(new MemoryStore(":memory:"));
    httpServer = app.listen(0);
    const address = httpServer.address();
    if (typeof address !== "object" || !address) throw new Error("no address");
    client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
  });

  afterAll(async () => {
    await client.close();
    httpServer.close();
  });

  it("lists only chat-native tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "create_memory_box",
      "delete_memory_box",
      "export_memories",
      "forget",
      "list_people",
      "list_promises",
      "memory_stats",
      "person_summary",
      "recall",
      "remember",
    ]);
  });

  it("supports the full remember → recall flow", async () => {
    const created = await client.callTool({
      name: "create_memory_box",
      arguments: { name: "통합테스트" },
    });
    const boxKey = textOf(created).match(/box_key: ([0-9a-f-]{36})/)?.[1];
    expect(boxKey).toBeTruthy();

    const saved = await client.callTool({
      name: "remember",
      arguments: {
        box_key: boxKey,
        content: "철수와 다음주 화요일 점심 약속",
        person: "철수",
        kind: "promise",
        happened_at: "2026-07-07T12:00",
      },
    });
    expect(textOf(saved)).toContain("기억했습니다");

    const recalled = await client.callTool({
      name: "recall",
      arguments: { box_key: boxKey, query: "점심" },
    });
    expect(textOf(recalled)).toContain("철수");
    expect(textOf(recalled)).toContain("점심 약속");

    const promises = await client.callTool({
      name: "list_promises",
      arguments: { box_key: boxKey },
    });
    expect(textOf(promises)).toContain("약속 1건");

    const summary = await client.callTool({
      name: "person_summary",
      arguments: { box_key: boxKey, person: "철수" },
    });
    expect(textOf(summary)).toContain("「철수」에 대한 기억");
  });

  it("returns a friendly error for an unknown box", async () => {
    const result = await client.callTool({
      name: "recall",
      arguments: { box_key: "00000000-0000-0000-0000-000000000000", query: "테스트" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("기억상자를 찾을 수 없습니다");
  });
});
