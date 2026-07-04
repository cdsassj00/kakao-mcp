import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LedgerError, LedgerStore } from "../src/ledger-store.js";
import { createLedgerApp } from "../src/ledger-server.js";

describe("LedgerStore", () => {
  let store: LedgerStore;
  let boxId: string;

  beforeEach(() => {
    store = new LedgerStore(":memory:");
    boxId = store.createLedger("테스트").id;
  });

  it("adds entries and computes a monthly summary deterministically", () => {
    store.addEntry({ boxId, amount: 4500, category: "카페", spentOn: "2026-07-01" });
    store.addEntry({ boxId, amount: 12000, category: "식비", spentOn: "2026-07-02" });
    store.addEntry({ boxId, amount: 8000, category: "카페", spentOn: "2026-07-03" });
    store.addEntry({ boxId, amount: 3000000, category: "월급", spentOn: "2026-07-25", kind: "income" });
    store.addEntry({ boxId, amount: 9999, category: "식비", spentOn: "2026-06-30" }); // 지난달

    const summary = store.monthlySummary(boxId, "2026-07");
    expect(summary.expenseTotal).toBe(24500);
    expect(summary.incomeTotal).toBe(3000000);
    expect(summary.byCategory[0]).toMatchObject({ category: "카페", total: 12500, count: 2 });
    expect(store.categoryMonthTotal(boxId, "2026-07", "카페")).toBe(12500);
  });

  it("rejects invalid amounts and dates", () => {
    expect(() => store.addEntry({ boxId, amount: 0, category: "x", spentOn: "2026-07-01" })).toThrow(LedgerError);
    expect(() => store.addEntry({ boxId, amount: 100.5, category: "x", spentOn: "2026-07-01" })).toThrow(LedgerError);
    expect(() => store.addEntry({ boxId, amount: 100, category: "x", spentOn: "7월 1일" })).toThrow(LedgerError);
  });

  it("upserts budgets including the whole-ledger budget", () => {
    store.setBudget(boxId, 500000);
    store.setBudget(boxId, 400000); // 갱신
    store.setBudget(boxId, 100000, "카페");
    const budgets = store.budgets(boxId);
    expect(budgets).toHaveLength(2);
    expect(budgets.find((b) => b.category === null)?.monthly_amount).toBe(400000);
    expect(budgets.find((b) => b.category === "카페")?.monthly_amount).toBe(100000);
  });

  it("filters entries by month and category", () => {
    store.addEntry({ boxId, amount: 1000, category: "카페", spentOn: "2026-07-01" });
    store.addEntry({ boxId, amount: 2000, category: "식비", spentOn: "2026-07-01" });
    expect(store.listEntries(boxId, "2026-07", "카페")).toHaveLength(1);
    expect(store.listEntries(boxId, "2026-06")).toHaveLength(0);
  });

  it("isolates ledgers and deletes with cascade", () => {
    const other = store.createLedger("남의 것").id;
    store.addEntry({ boxId: other, amount: 1000, category: "비밀", spentOn: "2026-07-01" });
    expect(store.listEntries(boxId)).toHaveLength(0);
    expect(store.deleteLedger(other)).toBe(true);
    expect(store.getLedger(other)).toBeNull();
  });
});

describe("말로 쓰는 가계부 MCP server", () => {
  let httpServer: Server;
  let client: Client;

  function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
    const content = result.content as { type: string; text?: string }[];
    return content.map((c) => c.text ?? "").join("\n");
  }

  beforeAll(async () => {
    const app = createLedgerApp(new LedgerStore(":memory:"));
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

  it("lists ledger tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "add_entries",
      "create_ledger",
      "delete_entry",
      "delete_ledger",
      "export_ledger",
      "list_entries",
      "monthly_report",
      "set_budget",
    ]);
  });

  it("supports record → report → budget warning flow", async () => {
    const created = await client.callTool({ name: "create_ledger", arguments: {} });
    const boxKey = textOf(created).match(/box_key: ([0-9a-f-]{36})/)?.[1];
    expect(boxKey).toBeTruthy();

    await client.callTool({
      name: "set_budget",
      arguments: { box_key: boxKey, monthly_amount: 10000 },
    });

    const added = await client.callTool({
      name: "add_entries",
      arguments: {
        box_key: boxKey,
        entries: [
          { amount: 4500, category: "카페", memo: "아아" },
          { amount: 12000, category: "식비", memo: "점심" },
        ],
      },
    });
    const addedText = textOf(added);
    expect(addedText).toContain("4,500원");
    expect(addedText).toContain("이번 달 지출 누계: 16,500원");
    expect(addedText).toContain("예산 초과");

    const report = await client.callTool({
      name: "monthly_report",
      arguments: { box_key: boxKey },
    });
    const reportText = textOf(report);
    expect(reportText).toContain("지출 합계: 16,500원 (2건)");
    expect(reportText).toContain("식비");

    const list = await client.callTool({
      name: "list_entries",
      arguments: { box_key: boxKey, category: "카페" },
    });
    expect(textOf(list)).toContain("아아");
  });

  it("returns a friendly error for an unknown ledger", async () => {
    const result = await client.callTool({
      name: "monthly_report",
      arguments: { box_key: "00000000-0000-0000-0000-000000000000" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("가계부를 찾을 수 없습니다");
  });
});
