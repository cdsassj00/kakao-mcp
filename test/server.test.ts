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

describe("MCP Streamable HTTP server", () => {
  let httpServer: Server;
  let client: Client;

  beforeAll(async () => {
    const app = createApp(new MemoryStore(":memory:"), "https://remember.example.com");
    httpServer = app.listen(0);
    const address = httpServer.address();
    if (typeof address !== "object" || !address) throw new Error("no address");
    const url = new URL(`http://127.0.0.1:${address.port}/mcp`);

    client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(new StreamableHTTPClientTransport(url));
  });

  afterAll(async () => {
    await client.close();
    httpServer.close();
  });

  it("lists all tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "chat_context",
      "create_memory_box",
      "delete_chat_room",
      "delete_memory_box",
      "export_memories",
      "forget",
      "import_kakao_export",
      "list_chat_rooms",
      "list_people",
      "list_promises",
      "memory_stats",
      "person_summary",
      "recall",
      "remember",
      "search_chat",
      "upload_page_link",
    ]);
  });

  it("serves the upload page and hands out its link via tool", async () => {
    const address = httpServer.address();
    if (typeof address !== "object" || !address) throw new Error("no address");
    const page = await fetch(`http://127.0.0.1:${address.port}/upload`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("대화 가져오기");

    const link = await client.callTool({ name: "upload_page_link", arguments: {} });
    expect(textOf(link)).toContain("https://remember.example.com/upload");
  });

  it("imports a KakaoTalk export and searches it", async () => {
    const created = await client.callTool({
      name: "create_memory_box",
      arguments: { name: "임포트테스트" },
    });
    const boxKey = textOf(created).match(/box_key: ([0-9a-f-]{36})/)?.[1];

    const imported = await client.callTool({
      name: "import_kakao_export",
      arguments: {
        box_key: boxKey,
        room: "철수",
        text: [
          "--------------- 2026년 7월 3일 금요일 ---------------",
          "[철수] [오후 2:30] 식당은 온기정으로 예약했어",
          "[나] [오후 2:31] 오 거기 좋지",
        ].join("\n"),
      },
    });
    expect(textOf(imported)).toContain("2건을 가져왔습니다");

    const found = await client.callTool({
      name: "search_chat",
      arguments: { box_key: boxKey, query: "식당 예약" },
    });
    expect(textOf(found)).toContain("온기정");
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
  });

  it("accepts uploads on /import and replaces re-uploaded rooms", async () => {
    const address = httpServer.address();
    if (typeof address !== "object" || !address) throw new Error("no address");
    const base = `http://127.0.0.1:${address.port}`;

    const created = await client.callTool({
      name: "create_memory_box",
      arguments: { name: "업로드테스트" },
    });
    const boxKey = textOf(created).match(/box_key: ([0-9a-f-]{36})/)?.[1];

    const exportText = [
      "영희 님과 카카오톡 대화",
      "저장한 날짜 : 2026-07-04 12:00:00",
      "",
      "--------------- 2026년 7월 3일 금요일 ---------------",
      "[영희] [오후 3:00] 계좌번호 보낼게 123-456",
      "[나] [오후 3:01] 고마워",
    ].join("\n");

    const first = await fetch(`${base}/import?box_key=${boxKey}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: exportText,
    });
    const firstResult = await first.json();
    expect(firstResult).toMatchObject({ ok: true, room: "영희", imported: 2, replaced: 0 });

    // 같은 방 재업로드 → 교체되어 중복이 생기지 않는다
    const second = await fetch(`${base}/import?box_key=${boxKey}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: exportText,
    });
    const secondResult = await second.json();
    expect(secondResult).toMatchObject({ ok: true, imported: 2, replaced: 2 });

    const found = await client.callTool({
      name: "search_chat",
      arguments: { box_key: boxKey, query: "계좌번호" },
    });
    expect(textOf(found)).toContain("1건");
    expect(textOf(found)).toContain("123-456");

    const unauthorized = await fetch(`${base}/import?box_key=00000000-0000-0000-0000-000000000000`, {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: exportText,
    });
    expect(unauthorized.status).toBe(401);
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

describe("PUBLIC_URL 미설정 시 Host 헤더로 업로드 링크 유추", () => {
  it("infers the upload link from the request host", async () => {
    const app = createApp(new MemoryStore(":memory:"), "");
    const httpServer = app.listen(0);
    const address = httpServer.address();
    if (typeof address !== "object" || !address) throw new Error("no address");

    const client = new Client({ name: "test-client-2", version: "0.0.1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`))
    );
    const link = await client.callTool({ name: "upload_page_link", arguments: {} });
    expect(textOf(link)).toContain(`http://127.0.0.1:${address.port}/upload`);
    await client.close();
    httpServer.close();
  });
});
