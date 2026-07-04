import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Memory, MemoryStore, StoreError } from "./store.js";

const KIND_LABEL: Record<string, string> = {
  note: "메모",
  promise: "약속",
  preference: "취향",
};

const kindSchema = z
  .enum(["note", "promise", "preference"])
  .describe("기억 종류: note(일반 메모), promise(약속/할 일), preference(상대의 취향/선호)");

const boxKeySchema = z.string().uuid().describe("기억상자 키 (create_memory_box로 발급받은 UUID)");

export function buildServer(store: MemoryStore): McpServer {
  const server = new McpServer(
    {
      name: "remember-talk",
      version: "0.1.0",
    },
    {
      instructions: [
        "「그때 뭐랬지?」는 사용자의 대화 내용을 사용자 동의 하에 기억해 두었다가 다시 찾아주는 개인 기억 서버입니다.",
        "처음 사용하는 사용자에게는 create_memory_box로 기억상자를 만들어 주고, 발급된 box_key를 사용자가 꼭 보관하도록 안내하세요.",
        "사용자가 대화 내용을 기억해 달라고 하면 remember로 저장하고, 과거 대화를 물어보면 recall로 검색하세요.",
        "저장은 반드시 사용자가 명시적으로 요청했을 때만 하세요. 자동으로 대화를 수집하지 마세요.",
        "약속(promise)으로 저장된 기억은 list_promises로 모아볼 수 있습니다.",
      ].join("\n"),
    }
  );

  server.registerTool(
    "create_memory_box",
    {
      title: "기억상자 만들기",
      description:
        "새 기억상자를 만들고 고유 키(box_key)를 발급합니다. 이 키가 있어야 기억을 저장/조회할 수 있으니, 사용자에게 키를 안전하게 보관하라고 안내하세요. 키를 잃어버리면 기억을 복구할 수 없습니다.",
      inputSchema: {
        name: z.string().max(50).optional().describe("기억상자 이름 (예: 내 기억상자)"),
      },
    },
    async ({ name }) => {
      const box = store.createBox(name?.trim() || "내 기억상자");
      return text(
        [
          `새 기억상자 「${box.name}」를 만들었습니다.`,
          ``,
          `box_key: ${box.id}`,
          ``,
          `⚠️ 이 키는 다시 발급되지 않습니다. 사용자에게 키를 복사해 안전한 곳(예: 나에게 보내기)에 보관하도록 꼭 안내해 주세요.`,
          `앞으로 기억을 저장/조회할 때마다 이 키를 함께 전달하면 됩니다.`,
        ].join("\n")
      );
    }
  );

  server.registerTool(
    "remember",
    {
      title: "기억 저장",
      description:
        "사용자가 기억해 달라고 요청한 대화 내용을 저장합니다. 사람 이름(person)과 종류(kind)를 함께 저장하면 나중에 찾기 쉽습니다. 사용자가 명시적으로 요청한 내용만 저장하세요.",
      inputSchema: {
        box_key: boxKeySchema,
        content: z.string().max(4000).describe("기억할 내용 (대화 요약이나 핵심 문장)"),
        person: z.string().max(50).optional().describe("관련된 사람 이름 (예: 철수, 김부장님)"),
        kind: kindSchema.optional(),
        tags: z.array(z.string().max(20)).max(10).optional().describe("분류 태그 (예: ['회사', '점심'])"),
        happened_at: z
          .string()
          .optional()
          .describe("대화/약속이 있었던(있을) 날짜, ISO 형식 (예: 2026-07-10 또는 2026-07-10T12:00)"),
      },
    },
    async ({ box_key, content, person, kind, tags, happened_at }) => {
      const box = store.getBox(box_key);
      if (!box) return boxNotFound();
      try {
        const memory = store.addMemory({
          boxId: box_key,
          content,
          person,
          kind,
          tags,
          happenedAt: happened_at,
        });
        return text(`기억했습니다. (#${memory.id})\n\n${formatMemory(memory)}`);
      } catch (error) {
        if (error instanceof StoreError) return text(error.message, true);
        throw error;
      }
    }
  );

  server.registerTool(
    "recall",
    {
      title: "기억 검색",
      description:
        "저장된 기억을 검색합니다. '철수랑 마지막에 무슨 얘기했지?', '지난달에 약속한 게 뭐였지?' 같은 질문에 사용하세요. 키워드는 공백으로 구분하면 모두 포함된 기억을 찾습니다.",
      inputSchema: {
        box_key: boxKeySchema,
        query: z.string().max(200).optional().describe("검색 키워드 (공백 구분, 예: '점심 약속')"),
        person: z.string().max(50).optional().describe("특정 사람으로 필터"),
        kind: kindSchema.optional(),
        limit: z.number().int().min(1).max(50).optional().describe("최대 결과 수 (기본 10)"),
      },
    },
    async ({ box_key, query, person, kind, limit }) => {
      const box = store.getBox(box_key);
      if (!box) return boxNotFound();
      const results = store.search({ boxId: box_key, query, person, kind, limit });
      if (results.length === 0) {
        return text("조건에 맞는 기억이 없습니다. 다른 키워드로 검색하거나, 저장된 사람 목록을 list_people로 확인해 보세요.");
      }
      return text(`${results.length}건의 기억을 찾았습니다.\n\n${results.map(formatMemory).join("\n\n")}`);
    }
  );

  server.registerTool(
    "list_people",
    {
      title: "사람 목록",
      description: "기억에 등장하는 사람들과 각 사람별 기억 수, 마지막 기억 시점을 보여줍니다.",
      inputSchema: { box_key: boxKeySchema },
    },
    async ({ box_key }) => {
      const box = store.getBox(box_key);
      if (!box) return boxNotFound();
      const people = store.listPeople(box_key);
      if (people.length === 0) return text("아직 사람이 연결된 기억이 없습니다.");
      return text(
        people
          .map((p) => `- ${p.person}: ${p.count}건 (마지막: ${formatDate(p.last_at)})`)
          .join("\n")
      );
    }
  );

  server.registerTool(
    "person_summary",
    {
      title: "사람별 요약",
      description:
        "특정 사람과 관련된 기억을 모아 보여줍니다. '철수에 대해 내가 뭘 기억하고 있지?' 같은 질문에 사용하세요. 취향, 약속, 최근 대화가 종류별로 정리됩니다.",
      inputSchema: {
        box_key: boxKeySchema,
        person: z.string().max(50).describe("사람 이름"),
      },
    },
    async ({ box_key, person }) => {
      const box = store.getBox(box_key);
      if (!box) return boxNotFound();
      const memories = store.listByPerson(box_key, person);
      if (memories.length === 0) return text(`「${person}」와 관련된 기억이 없습니다.`);
      const byKind = new Map<string, Memory[]>();
      for (const memory of memories) {
        const list = byKind.get(memory.kind) ?? [];
        list.push(memory);
        byKind.set(memory.kind, list);
      }
      const sections: string[] = [`「${person}」에 대한 기억 ${memories.length}건`];
      for (const kind of ["preference", "promise", "note"]) {
        const list = byKind.get(kind);
        if (!list?.length) continue;
        sections.push(`\n[${KIND_LABEL[kind]}]\n${list.map(formatMemory).join("\n")}`);
      }
      return text(sections.join("\n"));
    }
  );

  server.registerTool(
    "list_promises",
    {
      title: "약속 목록",
      description: "promise로 저장된 약속/할 일을 날짜순으로 보여줍니다. '나 약속 뭐 있었지?' 같은 질문에 사용하세요.",
      inputSchema: {
        box_key: boxKeySchema,
        person: z.string().max(50).optional().describe("특정 사람과의 약속만 보기"),
      },
    },
    async ({ box_key, person }) => {
      const box = store.getBox(box_key);
      if (!box) return boxNotFound();
      const promises = store.listPromises(box_key, person);
      if (promises.length === 0) return text("저장된 약속이 없습니다.");
      return text(`약속 ${promises.length}건:\n\n${promises.map(formatMemory).join("\n")}`);
    }
  );

  server.registerTool(
    "forget",
    {
      title: "기억 삭제",
      description: "특정 기억 하나를 완전히 삭제합니다. 삭제 전 사용자에게 어떤 기억인지 확인받으세요.",
      inputSchema: {
        box_key: boxKeySchema,
        memory_id: z.number().int().describe("삭제할 기억의 번호 (#id)"),
      },
    },
    async ({ box_key, memory_id }) => {
      const box = store.getBox(box_key);
      if (!box) return boxNotFound();
      const deleted = store.deleteMemory(box_key, memory_id);
      return deleted
        ? text(`기억 #${memory_id}를 삭제했습니다.`)
        : text(`기억 #${memory_id}를 찾을 수 없습니다.`, true);
    }
  );

  server.registerTool(
    "delete_memory_box",
    {
      title: "기억상자 전체 삭제",
      description:
        "기억상자와 그 안의 모든 기억을 영구 삭제합니다. 되돌릴 수 없으므로 반드시 사용자에게 재확인한 뒤 confirm을 true로 호출하세요.",
      inputSchema: {
        box_key: boxKeySchema,
        confirm: z.boolean().describe("사용자가 영구 삭제에 동의했으면 true"),
      },
    },
    async ({ box_key, confirm }) => {
      if (!confirm) return text("삭제하려면 사용자 동의 후 confirm을 true로 호출해 주세요.", true);
      const deleted = store.deleteBox(box_key);
      return deleted
        ? text("기억상자와 모든 기억을 영구 삭제했습니다.")
        : boxNotFound();
    }
  );

  server.registerTool(
    "export_memories",
    {
      title: "기억 내보내기",
      description: "기억상자의 모든 기억을 JSON으로 내보냅니다. 백업하거나 다른 곳으로 옮길 때 사용하세요.",
      inputSchema: { box_key: boxKeySchema },
    },
    async ({ box_key }) => {
      const data = store.exportAll(box_key);
      if (!data) return boxNotFound();
      return text(JSON.stringify(data, null, 2));
    }
  );

  server.registerTool(
    "memory_stats",
    {
      title: "기억상자 현황",
      description: "기억상자에 저장된 기억 수, 종류별 분포, 등장 인물 수를 보여줍니다.",
      inputSchema: { box_key: boxKeySchema },
    },
    async ({ box_key }) => {
      const box = store.getBox(box_key);
      if (!box) return boxNotFound();
      const stats = store.stats(box_key);
      return text(
        [
          `「${box.name}」 현황`,
          `- 전체 기억: ${stats.total}건`,
          ...Object.entries(stats.byKind).map(([kind, count]) => `- ${KIND_LABEL[kind] ?? kind}: ${count}건`),
          `- 등장 인물: ${stats.people}명`,
        ].join("\n")
      );
    }
  );

  return server;
}

function text(message: string, isError = false) {
  return { content: [{ type: "text" as const, text: message }], isError };
}

function boxNotFound() {
  return text("기억상자를 찾을 수 없습니다. box_key를 확인하거나 create_memory_box로 새로 만들어 주세요.", true);
}

function formatMemory(memory: Memory): string {
  const parts = [`#${memory.id} [${KIND_LABEL[memory.kind]}]`];
  if (memory.person) parts.push(`(${memory.person})`);
  const when = memory.happened_at ?? memory.created_at;
  parts.push(formatDate(when));
  const tags = memory.tags.length ? ` ${memory.tags.map((t) => `#${t}`).join(" ")}` : "";
  return `${parts.join(" ")}${tags}\n${memory.content}`;
}

function formatDate(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}
