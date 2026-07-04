import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LedgerError, LedgerStore } from "./ledger-store.js";

const boxKeySchema = z.string().uuid().describe("가계부 키 (create_ledger로 발급받은 UUID)");

const CATEGORY_GUIDE =
  "카테고리는 다음 중에서 고르되 마땅한 게 없으면 자유롭게: 식비, 카페, 술/모임, 교통, 쇼핑, 생활용품, 구독, 통신, 주거, 의료, 문화/여가, 경조사, 교육, 기타";

/** 서버 기준 오늘 날짜 (KST) */
function todayKst(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

function currentMonthKst(): string {
  return todayKst().slice(0, 7);
}

function won(amount: number): string {
  return `${amount.toLocaleString("ko-KR")}원`;
}

export function buildLedgerServer(store: LedgerStore): McpServer {
  const server = new McpServer(
    {
      name: "mal-gagyebu",
      version: "0.1.0",
    },
    {
      instructions: [
        "「말로 쓰는 가계부」는 사용자가 말한 지출/수입을 기록하고 결정론적으로 집계해주는 가계부 서버입니다.",
        "처음 사용하는 사용자에게는 create_ledger로 가계부를 만들어 주고, 발급된 box_key를 꼭 보관하도록 안내하세요.",
        "사용자가 '아아 4500원' 처럼 말하면 금액·카테고리·메모를 추출해 add_entries로 기록하세요. 날짜를 말하지 않으면 오늘로 기록됩니다.",
        "'이번 달 얼마 썼어?' 같은 질문에는 monthly_report를, '커피에 얼마 썼지?'에는 category 필터를 쓰세요.",
        "모든 합계는 서버가 SQL로 계산한 값이므로 직접 암산하지 말고 도구 결과의 숫자를 그대로 전달하세요.",
      ].join("\n"),
    }
  );

  server.registerTool(
    "create_ledger",
    {
      title: "가계부 만들기",
      description:
        "새 가계부를 만들고 고유 키(box_key)를 발급합니다. 키를 잃어버리면 복구할 수 없으니 사용자에게 안전한 보관(예: 나에게 보내기)을 안내하세요.",
      inputSchema: {
        name: z.string().max(50).optional().describe("가계부 이름 (예: 내 가계부)"),
      },
    },
    async ({ name }) => {
      const ledger = store.createLedger(name?.trim() || "내 가계부");
      return text(
        [
          `새 가계부 「${ledger.name}」를 만들었습니다.`,
          ``,
          `box_key: ${ledger.id}`,
          ``,
          `⚠️ 이 키는 다시 발급되지 않으니 안전한 곳에 보관하세요.`,
          `이제 "아아 4,500원", "어제 택시 12,000원"처럼 말만 하면 기록됩니다.`,
        ].join("\n")
      );
    }
  );

  server.registerTool(
    "add_entries",
    {
      title: "지출/수입 기록",
      description: `사용자가 말한 지출이나 수입을 기록합니다. 한 문장에 여러 건이 있으면 배열로 한 번에 기록하세요. ${CATEGORY_GUIDE}. 날짜 언급이 없으면 spent_on을 생략하세요(오늘로 기록).`,
      inputSchema: {
        box_key: boxKeySchema,
        entries: z
          .array(
            z.object({
              amount: z.number().int().positive().describe("금액 (원)"),
              category: z.string().max(20).describe("카테고리"),
              memo: z.string().max(100).optional().describe("메모 (예: 스타벅스 아아)"),
              spent_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("날짜 YYYY-MM-DD (생략 시 오늘)"),
              kind: z.enum(["expense", "income"]).optional().describe("expense(지출, 기본) 또는 income(수입)"),
            })
          )
          .min(1)
          .max(20),
      },
    },
    async ({ box_key, entries }) => {
      if (!store.getLedger(box_key)) return ledgerNotFound();
      try {
        const month = currentMonthKst();
        const saved = entries.map((e) =>
          store.addEntry({
            boxId: box_key,
            amount: e.amount,
            category: e.category,
            memo: e.memo,
            spentOn: e.spent_on ?? todayKst(),
            kind: e.kind,
          })
        );
        const summary = store.monthlySummary(box_key, month);
        const lines = saved.map(
          (s) => `✅ #${s.id} [${s.category}] ${won(s.amount)}${s.memo ? ` — ${s.memo}` : ""} (${s.spent_on})${s.kind === "income" ? " [수입]" : ""}`
        );
        lines.push("", `이번 달 지출 누계: ${won(summary.expenseTotal)}`);
        lines.push(...budgetWarnings(store, box_key, month));
        return text(lines.join("\n"));
      } catch (error) {
        if (error instanceof LedgerError) return text(error.message, true);
        throw error;
      }
    }
  );

  server.registerTool(
    "monthly_report",
    {
      title: "월간 리포트",
      description:
        "월간 지출/수입 합계와 카테고리별 내역, 예산 대비 현황을 보여줍니다. '이번 달 얼마 썼어?', '지난달 소비 정리해줘' 같은 질문에 사용하세요.",
      inputSchema: {
        box_key: boxKeySchema,
        month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("YYYY-MM (생략 시 이번 달)"),
      },
    },
    async ({ box_key, month }) => {
      if (!store.getLedger(box_key)) return ledgerNotFound();
      const target = month ?? currentMonthKst();
      const summary = store.monthlySummary(box_key, target);
      if (summary.count === 0) return text(`${target}에 기록된 내역이 없습니다.`);
      const maxTotal = summary.byCategory[0]?.total ?? 1;
      const lines = [
        `📒 ${target} 리포트`,
        `- 지출 합계: ${won(summary.expenseTotal)} (${summary.count}건)`,
        summary.incomeTotal > 0 ? `- 수입 합계: ${won(summary.incomeTotal)}` : "",
        ``,
        ...summary.byCategory.map((c) => {
          const bar = "▓".repeat(Math.max(1, Math.round((c.total / maxTotal) * 10)));
          return `${bar} ${c.category} ${won(c.total)} (${c.count}건)`;
        }),
        ...budgetWarnings(store, box_key, target, true),
      ];
      return text(lines.filter(Boolean).join("\n"));
    }
  );

  server.registerTool(
    "list_entries",
    {
      title: "내역 조회",
      description: "기록된 내역을 최신순으로 보여줍니다. '어제 뭐 샀지?', '이번 달 카페 내역 보여줘' 같은 질문에 사용하세요.",
      inputSchema: {
        box_key: boxKeySchema,
        month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("YYYY-MM 필터"),
        category: z.string().max(20).optional().describe("카테고리 필터"),
        limit: z.number().int().min(1).max(100).optional().describe("최대 건수 (기본 20)"),
      },
    },
    async ({ box_key, month, category, limit }) => {
      if (!store.getLedger(box_key)) return ledgerNotFound();
      const entries = store.listEntries(box_key, month, category, limit ?? 20);
      if (entries.length === 0) return text("조건에 맞는 내역이 없습니다.");
      return text(
        entries
          .map((e) => `#${e.id} ${e.spent_on} [${e.category}] ${won(e.amount)}${e.memo ? ` — ${e.memo}` : ""}${e.kind === "income" ? " [수입]" : ""}`)
          .join("\n")
      );
    }
  );

  server.registerTool(
    "set_budget",
    {
      title: "예산 설정",
      description:
        "월 예산을 설정합니다. category 없이 호출하면 전체 예산, category를 주면 해당 카테고리 예산입니다. 이후 기록 시 예산 초과를 자동 경고합니다.",
      inputSchema: {
        box_key: boxKeySchema,
        monthly_amount: z.number().int().positive().describe("월 예산 (원)"),
        category: z.string().max(20).optional().describe("카테고리 (생략 시 전체 예산)"),
      },
    },
    async ({ box_key, monthly_amount, category }) => {
      if (!store.getLedger(box_key)) return ledgerNotFound();
      try {
        store.setBudget(box_key, monthly_amount, category);
        return text(`${category ? `[${category}] ` : "전체 "}월 예산을 ${won(monthly_amount)}으로 설정했습니다.`);
      } catch (error) {
        if (error instanceof LedgerError) return text(error.message, true);
        throw error;
      }
    }
  );

  server.registerTool(
    "delete_entry",
    {
      title: "내역 삭제",
      description: "잘못 기록한 내역 하나를 삭제합니다. 삭제 전 어떤 내역인지 사용자에게 확인받으세요.",
      inputSchema: {
        box_key: boxKeySchema,
        entry_id: z.number().int().describe("삭제할 내역 번호 (#id)"),
      },
    },
    async ({ box_key, entry_id }) => {
      if (!store.getLedger(box_key)) return ledgerNotFound();
      return store.deleteEntry(box_key, entry_id)
        ? text(`내역 #${entry_id}를 삭제했습니다.`)
        : text(`내역 #${entry_id}를 찾을 수 없습니다.`, true);
    }
  );

  server.registerTool(
    "export_ledger",
    {
      title: "가계부 내보내기",
      description: "전체 내역과 예산을 JSON으로 내보냅니다. 백업이나 이동용입니다.",
      inputSchema: { box_key: boxKeySchema },
    },
    async ({ box_key }) => {
      if (!store.getLedger(box_key)) return ledgerNotFound();
      return text(JSON.stringify(store.exportAll(box_key), null, 2));
    }
  );

  server.registerTool(
    "delete_ledger",
    {
      title: "가계부 전체 삭제",
      description: "가계부와 모든 내역을 영구 삭제합니다. 되돌릴 수 없으므로 사용자 재확인 후 confirm을 true로 호출하세요.",
      inputSchema: {
        box_key: boxKeySchema,
        confirm: z.boolean().describe("사용자가 영구 삭제에 동의했으면 true"),
      },
    },
    async ({ box_key, confirm }) => {
      if (!confirm) return text("삭제하려면 사용자 동의 후 confirm을 true로 호출해 주세요.", true);
      return store.deleteLedger(box_key)
        ? text("가계부와 모든 내역을 영구 삭제했습니다.")
        : ledgerNotFound();
    }
  );

  return server;
}

/** 예산 대비 현황/경고 라인. verbose=true면 초과 전에도 항상 표시 */
function budgetWarnings(store: LedgerStore, boxId: string, month: string, verbose = false): string[] {
  const lines: string[] = [];
  for (const budget of store.budgets(boxId)) {
    const spent = budget.category
      ? store.categoryMonthTotal(boxId, month, budget.category)
      : store.monthlySummary(boxId, month).expenseTotal;
    const ratio = spent / budget.monthly_amount;
    const label = budget.category ? `[${budget.category}]` : "전체";
    if (ratio >= 1) {
      lines.push(`🚨 ${label} 예산 초과! ${won(spent)} / ${won(budget.monthly_amount)} (${Math.round(ratio * 100)}%)`);
    } else if (ratio >= 0.8) {
      lines.push(`⚠️ ${label} 예산 ${Math.round(ratio * 100)}% 사용: ${won(spent)} / ${won(budget.monthly_amount)}`);
    } else if (verbose) {
      lines.push(`💰 ${label} 예산: ${won(spent)} / ${won(budget.monthly_amount)} (${Math.round(ratio * 100)}%)`);
    }
  }
  return lines.length ? ["", ...lines] : [];
}

function text(message: string, isError = false) {
  return { content: [{ type: "text" as const, text: message }], isError };
}

function ledgerNotFound() {
  return text("가계부를 찾을 수 없습니다. box_key를 확인하거나 create_ledger로 새로 만들어 주세요.", true);
}
