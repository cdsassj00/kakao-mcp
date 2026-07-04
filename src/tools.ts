import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildGraph, egoRelationships, GraphEdge } from "./graph.js";
import { parseKakaoExport } from "./kakao-parser.js";
import { ChatMessage, Memory, MemoryStore, StoreError } from "./store.js";

const KIND_LABEL: Record<string, string> = {
  note: "메모",
  promise: "약속",
  preference: "취향",
};

const kindSchema = z
  .enum(["note", "promise", "preference"])
  .describe("기억 종류: note(일반 메모), promise(약속/할 일), preference(상대의 취향/선호)");

const boxKeySchema = z.string().uuid().describe("기억상자 키 (create_memory_box로 발급받은 UUID)");

export interface BuildOptions {
  /** 배포된 서버의 공개 URL (예: https://remember.example.com). 업로드 페이지 링크 안내에 사용 */
  publicUrl?: string;
}

export function buildServer(store: MemoryStore, options: BuildOptions = {}): McpServer {
  const server = new McpServer(
    {
      name: "saram-sajeon",
      version: "0.2.0",
    },
    {
      instructions: [
        "「사람사전」은 내 주변 사람들의 사전입니다. 사람과 나눈 대화·약속·취향을 사용자 동의 하에 기록해 두었다가, 사람 이름으로 찾아볼 수 있게 해주는 개인 인맥 기록 서버입니다.",
        "처음 사용하는 사용자에게는 create_memory_box로 나만의 사전(기억상자)을 만들어 주고, 발급된 box_key를 사용자가 꼭 보관하도록 안내하세요.",
        "사용자가 대화 내용을 기억해 달라고 하면 remember로 저장하고, 과거 대화를 물어보면 recall로 검색하세요.",
        "저장은 반드시 사용자가 명시적으로 요청했을 때만 하세요. 자동으로 대화를 수집하지 마세요.",
        "약속(promise)으로 저장된 기억은 list_promises로 모아볼 수 있습니다.",
        "카카오톡 '대화 내보내기'로 뽑은 텍스트를 사용자가 붙여넣으면 import_kakao_export로 통째로 보관하고, search_chat으로 과거 대화 원문을 검색할 수 있습니다. 파일이 길면 여러 번에 나눠 임포트하면 됩니다.",
        "내보내기 파일이 커서 붙여넣기 어렵다고 하면 upload_page_link로 업로드 페이지 주소를 안내하세요. 파일을 선택하면 자동으로 적재됩니다.",
        "search_chat 결과의 맥락이 더 필요하면 chat_context로 앞뒤 대화를 확인하세요.",
        "대화를 임포트해 두었다면 relationship_map으로 관계망 지도(누구와 얼마나 가까운지)를, relationship_strength로 특정 인물과의 강도를 보여줄 수 있습니다. 관계 강도는 대화 빈도·최근성·상호성의 결정론적 집계이므로 근거를 함께 설명하세요.",
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
    "import_kakao_export",
    {
      title: "카카오톡 대화 가져오기",
      description:
        "카카오톡 '대화 내보내기'(채팅방 설정 > 대화 내보내기)로 저장한 텍스트를 붙여넣으면 대화 원문을 통째로 보관합니다. PC/Android/iOS 내보내기 형식을 모두 지원합니다. 텍스트가 길면 잘라서 여러 번 호출하세요 (호출당 최대 약 400KB). 같은 채팅방을 다시 임포트하면 중복되므로, 다시 가져올 때는 먼저 delete_chat_room으로 비우라고 안내하세요.",
      inputSchema: {
        box_key: boxKeySchema,
        room: z.string().max(100).describe("채팅방 이름 (예: 철수, 가족 단톡방)"),
        text: z.string().max(400_000).describe("내보내기 파일의 텍스트 내용 (일부분씩 나눠도 됨)"),
      },
    },
    async ({ box_key, room, text: exportText }) => {
      const box = store.getBox(box_key);
      if (!box) return boxNotFound();
      const parsed = parseKakaoExport(exportText);
      if (parsed.length === 0) {
        return text(
          "메시지를 하나도 인식하지 못했습니다. 카카오톡 '대화 내보내기' 원본 텍스트인지 확인해 주세요. (지원 형식: [이름] [오후 2:30] 내용 / 2026년 7월 4일 오후 2:30, 이름 : 내용 / 2026. 7. 4. 오후 2:30, 이름 : 내용)",
          true
        );
      }
      try {
        const result = store.importChatMessages(box_key, room, parsed);
        const first = parsed[0].sentAt ?? "?";
        const last = parsed[parsed.length - 1].sentAt ?? "?";
        return text(
          `「${room}」 대화 ${result.imported}건을 가져왔습니다 (기간: ${first} ~ ${last}).\n기억상자 전체 보관 대화: ${result.total}건.\n이어지는 부분이 있으면 같은 방 이름으로 계속 임포트하세요.`
        );
      } catch (error) {
        if (error instanceof StoreError) return text(error.message, true);
        throw error;
      }
    }
  );

  server.registerTool(
    "upload_page_link",
    {
      title: "대화 파일 업로드 페이지 안내",
      description:
        "카카오톡 '대화 내보내기' 파일을 붙여넣기 대신 파일 그대로 올릴 수 있는 업로드 페이지 주소를 알려줍니다. 파일이 크거나 모바일 사용자일 때 이 링크를 안내하세요.",
      inputSchema: {
        box_key: boxKeySchema.optional().describe("키를 넘기면 페이지에 미리 채워진 링크를 만들어 줍니다"),
      },
    },
    async ({ box_key }) => {
      if (!options.publicUrl) {
        return text(
          "업로드 페이지 주소가 설정되지 않았습니다 (서버 환경변수 PUBLIC_URL 필요). 대신 내보내기 텍스트를 채팅에 나눠 붙여넣으면 import_kakao_export로 가져올 수 있습니다.",
          true
        );
      }
      const url = box_key
        ? `${options.publicUrl}/upload?box_key=${box_key}`
        : `${options.publicUrl}/upload`;
      return text(
        `업로드 페이지: ${url}\n\n사용법을 함께 안내하세요:\n① 카카오톡 채팅방 ⚙️ 설정 → 대화 내용 내보내기 (텍스트만)\n② 위 링크를 열어 .txt 파일 선택\n③ 완료되면 이 채팅에서 바로 검색 가능 (search_chat)`
      );
    }
  );

  server.registerTool(
    "search_chat",
    {
      title: "카카오톡 대화 검색",
      description:
        "임포트해 둔 카카오톡 대화 원문에서 키워드로 검색합니다. '철수가 식당 이름 뭐라고 했지?', '단톡방에서 계좌번호 얘기 찾아줘' 같은 질문에 사용하세요. 키워드는 공백으로 구분하면 모두 포함된 메시지를 찾습니다.",
      inputSchema: {
        box_key: boxKeySchema,
        query: z.string().max(200).describe("검색 키워드 (공백 구분)"),
        room: z.string().max(100).optional().describe("특정 채팅방으로 필터"),
        sender: z.string().max(50).optional().describe("특정 발신자로 필터"),
        limit: z.number().int().min(1).max(50).optional().describe("최대 결과 수 (기본 10)"),
      },
    },
    async ({ box_key, query, room, sender, limit }) => {
      const box = store.getBox(box_key);
      if (!box) return boxNotFound();
      const results = store.searchChat({ boxId: box_key, query, room, sender, limit });
      if (results.length === 0) {
        return text("검색 결과가 없습니다. 다른 키워드를 쓰거나 list_chat_rooms로 임포트된 채팅방을 확인해 보세요.");
      }
      return text(
        `${results.length}건을 찾았습니다. (앞뒤 대화가 필요하면 chat_context에 메시지 번호를 넘기세요)\n\n${results
          .map(formatChat)
          .join("\n")}`
      );
    }
  );

  server.registerTool(
    "chat_context",
    {
      title: "대화 맥락 보기",
      description: "search_chat으로 찾은 메시지의 앞뒤 대화 흐름을 보여줍니다.",
      inputSchema: {
        box_key: boxKeySchema,
        message_id: z.number().int().describe("기준 메시지 번호 (#id)"),
        around: z.number().int().min(1).max(20).optional().describe("앞뒤로 몇 개씩 볼지 (기본 5)"),
      },
    },
    async ({ box_key, message_id, around }) => {
      const box = store.getBox(box_key);
      if (!box) return boxNotFound();
      const messages = store.chatContext(box_key, message_id, around ?? 5);
      if (messages.length === 0) return text(`메시지 #${message_id}를 찾을 수 없습니다.`, true);
      return text(messages.map((m) => (m.id === message_id ? `▶ ${formatChat(m)}` : formatChat(m))).join("\n"));
    }
  );

  server.registerTool(
    "list_chat_rooms",
    {
      title: "임포트된 채팅방 목록",
      description: "가져온 카카오톡 채팅방 목록과 각 방의 메시지 수, 대화 기간을 보여줍니다.",
      inputSchema: { box_key: boxKeySchema },
    },
    async ({ box_key }) => {
      const box = store.getBox(box_key);
      if (!box) return boxNotFound();
      const rooms = store.listRooms(box_key);
      if (rooms.length === 0) {
        return text("아직 가져온 대화가 없습니다. 카카오톡 채팅방 설정 > 대화 내보내기로 텍스트를 뽑아 import_kakao_export로 가져올 수 있습니다.");
      }
      return text(
        rooms
          .map((r) => `- ${r.room}: ${r.count}건 (${r.first_at?.slice(0, 10) ?? "?"} ~ ${r.last_at?.slice(0, 10) ?? "?"})`)
          .join("\n")
      );
    }
  );

  server.registerTool(
    "delete_chat_room",
    {
      title: "채팅방 대화 삭제",
      description: "임포트한 특정 채팅방의 대화를 전부 삭제합니다. 다시 임포트하기 전이나 더 이상 보관하고 싶지 않을 때 사용하세요. 삭제 전 사용자에게 확인받으세요.",
      inputSchema: {
        box_key: boxKeySchema,
        room: z.string().max(100).describe("삭제할 채팅방 이름 (list_chat_rooms에 표시된 이름과 정확히 일치해야 함)"),
      },
    },
    async ({ box_key, room }) => {
      const box = store.getBox(box_key);
      if (!box) return boxNotFound();
      const deleted = store.deleteRoom(box_key, room);
      return deleted > 0
        ? text(`「${room}」 대화 ${deleted}건을 삭제했습니다.`)
        : text(`「${room}」 채팅방을 찾을 수 없습니다. list_chat_rooms로 정확한 이름을 확인해 주세요.`, true);
    }
  );

  server.registerTool(
    "relationship_map",
    {
      title: "관계망 지도",
      description:
        "임포트된 대화에서 관계망을 계산해 가까운 사람 순위와 지도 이미지(SVG) 링크를 보여줍니다. '내 관계망 보여줘', '나 누구랑 제일 친해?' 같은 질문에 사용하세요. me에 사용자 본인의 카톡 표시 이름을 넣으면 본인 중심 지도가 됩니다.",
      inputSchema: {
        box_key: boxKeySchema,
        me: z.string().max(50).optional().describe("사용자 본인의 카카오톡 표시 이름 (예: 홍길동)"),
      },
    },
    async ({ box_key, me }) => {
      const box = store.getBox(box_key);
      if (!box) return boxNotFound();
      const messages = store.exportChat(box_key);
      if (messages.length === 0) {
        return text("임포트된 대화가 없습니다. 카카오톡 '대화 내보내기' 텍스트를 먼저 넣어주세요 (import_kakao_export 또는 upload_page_link).");
      }
      const graph = buildGraph(messages);
      const ranked = me ? egoRelationships(graph, me) : graph.edges;
      if (me && ranked.length === 0) {
        return text(
          `「${me}」라는 이름의 발화자를 찾지 못했습니다. 등장인물: ${graph.nodes
            .slice(0, 15)
            .map((n) => n.name)
            .join(", ")}\n이 중 본인 이름을 골라 다시 시도해 주세요.`,
          true
        );
      }
      const mapUrl = options.publicUrl
        ? `${options.publicUrl}/map?box_key=${box_key}${me ? `&me=${encodeURIComponent(me)}` : ""}`
        : null;
      return text(
        [
          me
            ? `「${me}」 중심 관계망 (인물 ${graph.nodes.length}명, 관계 ${graph.edges.length}쌍)`
            : `관계망 (인물 ${graph.nodes.length}명, 관계 ${graph.edges.length}쌍)`,
          ``,
          ...ranked.slice(0, 10).map((e, i) => formatEdge(e, i + 1, me)),
          ``,
          mapUrl ? `🗺️ 관계망 지도 보기: ${mapUrl}` : "",
          `* 강도는 대화 빈도 × 최근성 × 상호성의 결정론적 집계입니다 (최대 100).`,
        ]
          .filter(Boolean)
          .join("\n")
      );
    }
  );

  server.registerTool(
    "relationship_strength",
    {
      title: "관계 강도 분석",
      description: "임포트된 대화를 바탕으로 특정 인물과의 관계 강도를 상세 분석합니다. '나랑 철수 얼마나 친해?' 같은 질문에 사용하세요.",
      inputSchema: {
        box_key: boxKeySchema,
        person: z.string().max(50).describe("분석할 인물 이름"),
        me: z.string().max(50).optional().describe("사용자 본인의 카톡 표시 이름"),
      },
    },
    async ({ box_key, person, me }) => {
      const box = store.getBox(box_key);
      if (!box) return boxNotFound();
      const graph = buildGraph(store.exportChat(box_key));
      const edges = egoRelationships(graph, person).filter((e) => !me || e.a === me || e.b === me);
      if (edges.length === 0) {
        return text(`「${person}」와의 관계 데이터가 없습니다. 함께 있는 채팅방을 임포트했는지 확인해 주세요.`);
      }
      const node = graph.nodes.find((n) => n.name === person);
      return text(
        [
          `「${person}」 관계 분석`,
          `- 총 발화: ${node?.messageCount ?? 0}건, 함께한 방: ${node?.rooms.join(", ") ?? "-"}`,
          ...edges.slice(0, 5).map((e) => {
            const other = e.a === person ? e.b : e.a;
            return `- ${other}와(과): 강도 ${e.score}/100, 상호작용 ${e.interactions}회, 마지막 ${e.lastAt?.slice(0, 10) ?? "?"} (${e.rooms.join(", ")})`;
          }),
        ].join("\n")
      );
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
          `- 임포트된 카카오톡 대화: ${store.chatCount(box_key)}건`,
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

function formatChat(message: ChatMessage): string {
  const when = message.sent_at ? formatDate(message.sent_at) : "시각 미상";
  return `#${message.id} [${message.room}] ${when} ${message.sender}: ${message.content}`;
}

function formatEdge(edge: GraphEdge, rank: number, me?: string): string {
  const label = me ? (edge.a === me ? edge.b : edge.a) : `${edge.a} ↔ ${edge.b}`;
  const filled = Math.max(1, Math.round(edge.score / 20));
  const bar = "●".repeat(filled) + "○".repeat(Math.max(0, 5 - filled));
  return `${rank}. ${label} ${bar} ${edge.score}/100 (상호작용 ${edge.interactions}회, 마지막 ${edge.lastAt?.slice(0, 10) ?? "?"})`;
}
