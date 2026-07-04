import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { extractRows, fetchLhNotices, normalizeDate, toNoticeInput } from "../src/lh-client.js";
import { createRadarApp } from "../src/radar-server.js";
import { RadarStore } from "../src/radar-store.js";

// LH API 응답 형태 픽스처: [{resHeader}, {dsList}]
const LH_FIXTURE = [
  { resHeader: [{ SS_CODE: "Y" }] },
  {
    dsList: [
      {
        PAN_ID: "2026070401",
        PAN_NM: "서울 강서구 행복주택 입주자 모집공고",
        UPP_AIS_TP_NM: "임대주택",
        AIS_TP_CD_NM: "행복주택",
        CNP_CD_NM: "서울특별시",
        PAN_NT_ST_DT: "2026.07.01",
        CLSG_DT: "2026.07.15",
        PAN_SS: "접수중",
        DTL_URL: "https://apply.lh.or.kr/notice/2026070401",
      },
      {
        PAN_ID: "2026070402",
        PAN_NM: "경기 수원 국민임대 예비입주자 모집",
        UPP_AIS_TP_NM: "임대주택",
        AIS_TP_CD_NM: "국민임대",
        CNP_CD_NM: "경기도",
        PAN_NT_ST_DT: "20260628",
        CLSG_DT: "20260710",
        PAN_SS: "접수중",
        DTL_URL: "https://apply.lh.or.kr/notice/2026070402",
      },
    ],
  },
];

describe("lh-client", () => {
  it("normalizes various date formats", () => {
    expect(normalizeDate("2026.07.15")).toBe("2026-07-15");
    expect(normalizeDate("20260715")).toBe("2026-07-15");
    expect(normalizeDate("2026-07-15")).toBe("2026-07-15");
    expect(normalizeDate("")).toBeNull();
  });

  it("extracts rows from the [{resHeader},{dsList}] envelope", () => {
    const rows = extractRows(LH_FIXTURE);
    expect(rows).toHaveLength(2);
    expect(toNoticeInput(rows[0])).toMatchObject({
      source: "LH",
      externalId: "2026070401",
      typeName: "행복주택",
      region: "서울특별시",
      closeOn: "2026-07-15",
    });
  });

  it("fetches pages via injected fetch and stops at the last page", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify(LH_FIXTURE), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await fetchLhNotices("KEY", { pageSize: 100, maxPages: 3, fetchFn: fakeFetch });
    // dsList 2건 < pageSize → 유형코드당 1페이지에서 중단, 유형 2개 = 2페이지
    expect(result.pages).toBe(2);
    expect(result.notices).toHaveLength(4);
    expect(calls[0]).toContain("UPP_AIS_TP_CD=05");
    expect(calls[1]).toContain("UPP_AIS_TP_CD=06");
    expect(calls[0]).toMatch(/PAN_NT_ST_DT=\d{8}/);
    expect(calls[0]).toMatch(/CLSG_DT=\d{8}/);
  });
});

describe("RadarStore", () => {
  let store: RadarStore;

  beforeEach(() => {
    store = new RadarStore(":memory:");
  });

  it("upserts notices without duplicating and updates status", () => {
    const input = {
      source: "LH",
      externalId: "A1",
      title: "행복주택 공고",
      typeName: "행복주택",
      region: "서울",
      status: "공고중",
      closeOn: "2026-07-15",
    };
    expect(store.upsertNotice(input).isNew).toBe(true);
    expect(store.upsertNotice({ ...input, status: "접수중" }).isNew).toBe(false);
    const notices = store.searchNotices({});
    expect(notices).toHaveLength(1);
    expect(notices[0].status).toBe("접수중");
  });

  it("filters by region, type, keyword and orders by closing date", () => {
    store.upsertNotice({ source: "LH", externalId: "1", title: "서울 청년 행복주택", typeName: "행복주택", region: "서울특별시", closeOn: "2026-07-20" });
    store.upsertNotice({ source: "LH", externalId: "2", title: "부산 국민임대", typeName: "국민임대", region: "부산광역시", closeOn: "2026-07-10" });
    store.upsertNotice({ source: "LH", externalId: "3", title: "서울 신혼희망타운", typeName: "분양주택", region: "서울특별시", closeOn: null });

    expect(store.searchNotices({ regions: ["서울"] })).toHaveLength(2);
    expect(store.searchNotices({ types: ["행복주택"] })).toHaveLength(1);
    expect(store.searchNotices({ keywords: ["청년"] })).toHaveLength(1);

    const all = store.searchNotices({});
    expect(all[0].external_id).toBe("2"); // 마감 빠른 순
    expect(all[2].close_on).toBeNull(); // 마감 미상은 뒤로
  });

  it("filters closing-soon within N days", () => {
    store.upsertNotice({ source: "LH", externalId: "1", title: "임박", closeOn: "2026-07-06" });
    store.upsertNotice({ source: "LH", externalId: "2", title: "여유", closeOn: "2026-08-01" });
    store.upsertNotice({ source: "LH", externalId: "3", title: "지남", closeOn: "2026-07-01" });
    const soon = store.searchNotices({ closingWithinDays: 7, today: "2026-07-04" });
    expect(soon).toHaveLength(1);
    expect(soon[0].title).toBe("임박");
  });

  it("manages the service key with first-set-wins and admin token rotation", () => {
    const first = store.configureServiceKey("KEY-1");
    expect(first.ok).toBe(true);
    expect(first.adminToken).toBeTruthy();

    const stolen = store.configureServiceKey("KEY-EVIL");
    expect(stolen.ok).toBe(false);

    const rotated = store.configureServiceKey("KEY-2", first.adminToken);
    expect(rotated.ok).toBe(true);
    expect(store.getConfig("lh_service_key")).toBe("KEY-2");
  });
});

describe("내집레이더 MCP server", () => {
  let httpServer: Server;
  let client: Client;
  let store: RadarStore;
  let base: string;

  function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
    const content = result.content as { type: string; text?: string }[];
    return content.map((c) => c.text ?? "").join("\n");
  }

  beforeAll(async () => {
    store = new RadarStore(":memory:");
    store.upsertNotice({
      source: "LH",
      externalId: "SEOUL-1",
      title: "서울 강서구 행복주택 입주자 모집공고",
      typeName: "행복주택",
      region: "서울특별시",
      status: "접수중",
      postedOn: "2026-07-01",
      closeOn: "2099-07-15",
      detailUrl: "https://apply.lh.or.kr/notice/1",
    });
    store.upsertNotice({
      source: "LH",
      externalId: "GG-1",
      title: "경기 수원 국민임대 모집",
      typeName: "국민임대",
      region: "경기도",
      status: "접수중",
      closeOn: "2099-07-10",
    });
    const app = createRadarApp(store);
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

  it("lists radar tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "closing_soon",
      "data_status",
      "delete_profile",
      "my_briefing",
      "notice_detail",
      "save_profile",
      "search_notices",
      "update_profile",
    ]);
  });

  it("searches notices instantly without any key", async () => {
    const found = await client.callTool({
      name: "search_notices",
      arguments: { region: "서울", type: "행복주택" },
    });
    const foundText = textOf(found);
    expect(foundText).toContain("강서구 행복주택");
    expect(foundText).toContain("🔗");
    expect(foundText).not.toContain("국민임대");
  });

  it("supports profile save → briefing flow", async () => {
    const saved = await client.callTool({
      name: "save_profile",
      arguments: { regions: ["경기"], types: ["국민임대"] },
    });
    const profileKey = textOf(saved).match(/profile_key: ([0-9a-f-]{36})/)?.[1];
    expect(profileKey).toBeTruthy();

    const briefing = await client.callTool({
      name: "my_briefing",
      arguments: { profile_key: profileKey },
    });
    expect(textOf(briefing)).toContain("수원 국민임대");
    expect(textOf(briefing)).not.toContain("강서구");
  });

  it("shows data status and notice detail", async () => {
    const status = await client.callTool({ name: "data_status", arguments: {} });
    expect(textOf(status)).toContain("총 2건");

    const detail = await client.callTool({ name: "notice_detail", arguments: { notice_id: 1 } });
    expect(textOf(detail)).toContain("원문 보기");
  });

  it("guards /setup with first-set-wins", async () => {
    const first = await fetch(`${base}/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service_key: "TEST-SERVICE-KEY-123" }),
    });
    const firstBody = (await first.json()) as { ok: boolean; admin_token?: string };
    expect(firstBody.ok).toBe(true);
    expect(firstBody.admin_token).toBeTruthy();

    const second = await fetch(`${base}/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service_key: "EVIL-KEY-9999999" }),
    });
    expect(second.status).toBe(403);
  });
});
