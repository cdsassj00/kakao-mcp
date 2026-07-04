import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOntologyApp } from "../src/ontology-server.js";
import { MemoryStore } from "../src/store.js";

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as { type: string; text?: string }[];
  return content.map((c) => c.text ?? "").join("\n");
}

describe("인맥 온톨로지 MCP server", () => {
  let httpServer: Server;
  let client: Client;
  let base: string;

  beforeAll(async () => {
    const app = createOntologyApp(new MemoryStore(":memory:"), "");
    httpServer = app.listen(0);
    const address = httpServer.address();
    if (typeof address !== "object" || !address) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
    client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  });

  afterAll(async () => {
    await client.close();
    httpServer.close();
  });

  it("lists ontology tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "create_network",
      "delete_chat_room",
      "delete_network",
      "import_kakao_export",
      "list_chat_rooms",
      "relationship_map",
      "relationship_strength",
    ]);
  });

  it("supports the import → relationship_map → map SVG flow", async () => {
    const created = await client.callTool({ name: "create_network", arguments: {} });
    const boxKey = textOf(created).match(/box_key: ([0-9a-f-]{36})/)?.[1];
    expect(boxKey).toBeTruthy();

    const imported = await client.callTool({
      name: "import_kakao_export",
      arguments: {
        box_key: boxKey,
        room: "동창회",
        text: [
          "--------------- 2026년 7월 1일 수요일 ---------------",
          "[홍길동] [오후 2:30] 이번 주말 모임 콜?",
          "[철수] [오후 2:31] 콜",
          "[홍길동] [오후 2:32] 영희는?",
          "[영희] [오후 2:33] 나도 갈게",
          "[철수] [오후 2:34] 좋다",
        ].join("\n"),
      },
    });
    expect(textOf(imported)).toContain("5건");
    expect(textOf(imported)).toContain("등장인물 3명");

    const map = await client.callTool({
      name: "relationship_map",
      arguments: { box_key: boxKey, me: "홍길동" },
    });
    const mapText = textOf(map);
    expect(mapText).toContain("「홍길동」 중심 관계망");
    expect(mapText).toContain("철수");
    expect(mapText).toContain("/100");
    expect(mapText).toContain(`/map?box_key=${boxKey}`);

    const strength = await client.callTool({
      name: "relationship_strength",
      arguments: { box_key: boxKey, person: "철수", me: "홍길동" },
    });
    expect(textOf(strength)).toContain("「철수」 관계 분석");
    expect(textOf(strength)).toContain("홍길동");

    const svg = await fetch(`${base}/map?box_key=${boxKey}&me=${encodeURIComponent("홍길동")}`);
    expect(svg.status).toBe(200);
    expect(svg.headers.get("content-type")).toContain("image/svg+xml");
    const svgBody = await svg.text();
    expect(svgBody).toContain("<svg");
    expect(svgBody).toContain("철수");
  });

  it("suggests candidate names when me is not found", async () => {
    const created = await client.callTool({ name: "create_network", arguments: {} });
    const boxKey = textOf(created).match(/box_key: ([0-9a-f-]{36})/)?.[1];
    await client.callTool({
      name: "import_kakao_export",
      arguments: {
        box_key: boxKey,
        room: "방",
        text: "2026년 7월 1일 오후 2:30, 철수 : 안녕\n2026년 7월 1일 오후 2:31, 영희 : 하이",
      },
    });
    const map = await client.callTool({
      name: "relationship_map",
      arguments: { box_key: boxKey, me: "없는사람" },
    });
    expect(map.isError).toBe(true);
    expect(textOf(map)).toContain("철수");
  });

  it("rejects the map endpoint for unknown box keys", async () => {
    const response = await fetch(`${base}/map?box_key=00000000-0000-0000-0000-000000000000`);
    expect(response.status).toBe(404);
  });
});
