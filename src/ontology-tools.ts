import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildGraph, egoRelationships, GraphEdge } from "./graph.js";
import { parseKakaoExport } from "./kakao-parser.js";
import { MemoryStore, StoreError } from "./store.js";

const boxKeySchema = z.string().uuid().describe("관계망 키 (create_network으로 발급받은 UUID)");

export interface OntologyBuildOptions {
  publicUrl?: string;
}

export function buildOntologyServer(store: MemoryStore, options: OntologyBuildOptions = {}): McpServer {
  const server = new McpServer(
    {
      name: "inmaek-ontology",
      version: "0.1.0",
    },
    {
      instructions: [
        "「인맥 온톨로지」는 사용자의 카카오톡 대화 기록(공식 '대화 내보내기')에서 관계망을 계산해, 누구와 얼마나 가깝게 지내는지를 그래프와 강도 점수로 보여주는 서버입니다.",
        "처음 사용하는 사용자에게는 create_network으로 관계망을 만들어 주고, 발급된 box_key를 꼭 보관하도록 안내하세요.",
        "사용자가 대화 내보내기 텍스트를 붙여넣으면 import_kakao_export로 적재하고, relationship_map으로 관계망 지도를, relationship_strength로 특정 인물과의 강도를 보여주세요.",
        "관계 강도는 LLM의 추측이 아니라 대화 빈도·최근성·상호성의 결정론적 집계입니다. 결과를 전할 때 이 근거를 함께 설명하세요.",
        "분석은 사용자가 스스로 제공한 대화만 대상으로 하며, 자동 수집은 없습니다.",
      ].join("\n"),
    }
  );

  server.registerTool(
    "create_network",
    {
      title: "관계망 만들기",
      description:
        "새 관계망 저장소를 만들고 고유 키(box_key)를 발급합니다. 키를 잃어버리면 복구할 수 없으니 사용자에게 안전한 보관을 안내하세요.",
      inputSchema: {
        name: z.string().max(50).optional().describe("관계망 이름 (예: 내 관계망)"),
      },
    },
    async ({ name }) => {
      const box = store.createBox(name?.trim() || "내 관계망");
      return text(
        [
          `새 관계망 「${box.name}」를 만들었습니다.`,
          ``,
          `box_key: ${box.id}`,
          ``,
          `⚠️ 이 키는 다시 발급되지 않으니 안전한 곳에 보관하세요.`,
          `카카오톡 채팅방 ⚙️ 설정 → '대화 내용 내보내기'로 뽑은 텍스트를 붙여넣으면 관계망 분석이 시작됩니다.`,
        ].join("\n")
      );
    }
  );

  server.registerTool(
    "import_kakao_export",
    {
      title: "카카오톡 대화 가져오기",
      description:
        "카카오톡 '대화 내보내기' 텍스트를 관계망 분석용으로 적재합니다. PC/Android/iOS 형식 지원, 길면 나눠서 여러 번 호출하세요. 단톡방을 넣을수록 관계망이 풍부해집니다.",
      inputSchema: {
        box_key: boxKeySchema,
        room: z.string().max(100).describe("채팅방 이름"),
        text: z.string().max(400_000).describe("내보내기 텍스트"),
      },
    },
    async ({ box_key, room, text: exportText }) => {
      const box = store.getBox(box_key);
      if (!box) return boxNotFound();
      const parsed = parseKakaoExport(exportText);
      if (parsed.length === 0) {
        return text("메시지를 인식하지 못했습니다. 카카오톡 '대화 내보내기' 원본 텍스트인지 확인해 주세요.", true);
      }
      try {
        const result = store.importChatMessages(box_key, room, parsed);
        const senders = new Set(parsed.map((m) => m.sender));
        return text(
          `「${room}」 대화 ${result.imported}건을 가져왔습니다 (등장인물 ${senders.size}명).\n이제 relationship_map으로 관계망 지도를 볼 수 있습니다. 정확한 분석을 위해 사용자 본인의 카카오톡 표시 이름(me)을 물어봐 주세요.`
        );
      } catch (error) {
        if (error instanceof StoreError) return text(error.message, true);
        throw error;
      }
    }
  );

  server.registerTool(
    "relationship_map",
    {
      title: "관계망 지도",
      description:
        "적재된 대화에서 관계망을 계산해 지도 이미지(SVG) 링크와 가까운 사람 순위를 보여줍니다. me에 사용자 본인의 카톡 표시 이름을 넣으면 본인 중심 지도가 됩니다.",
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
        return text("적재된 대화가 없습니다. import_kakao_export로 대화 내보내기 텍스트를 먼저 넣어주세요.");
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
      const lines = ranked.slice(0, 10).map((e, i) => formatEdge(e, i + 1, me));
      return text(
        [
          me ? `「${me}」 중심 관계망 (인물 ${graph.nodes.length}명, 관계 ${graph.edges.length}쌍)` : `관계망 (인물 ${graph.nodes.length}명, 관계 ${graph.edges.length}쌍)`,
          ``,
          ...lines,
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
      description: "특정 인물과의 관계 강도를 상세 분석합니다. '나랑 철수 얼마나 친해?' 같은 질문에 사용하세요.",
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
    "list_chat_rooms",
    {
      title: "적재된 채팅방 목록",
      description: "관계망 분석에 사용 중인 채팅방 목록을 보여줍니다.",
      inputSchema: { box_key: boxKeySchema },
    },
    async ({ box_key }) => {
      const box = store.getBox(box_key);
      if (!box) return boxNotFound();
      const rooms = store.listRooms(box_key);
      if (rooms.length === 0) return text("아직 적재된 대화가 없습니다.");
      return text(rooms.map((r) => `- ${r.room}: ${r.count}건 (${r.first_at?.slice(0, 10) ?? "?"} ~ ${r.last_at?.slice(0, 10) ?? "?"})`).join("\n"));
    }
  );

  server.registerTool(
    "delete_chat_room",
    {
      title: "채팅방 삭제",
      description: "특정 채팅방 대화를 분석 대상에서 완전히 삭제합니다. 삭제 전 사용자에게 확인받으세요.",
      inputSchema: {
        box_key: boxKeySchema,
        room: z.string().max(100).describe("삭제할 채팅방 이름"),
      },
    },
    async ({ box_key, room }) => {
      const box = store.getBox(box_key);
      if (!box) return boxNotFound();
      const deleted = store.deleteRoom(box_key, room);
      return deleted > 0
        ? text(`「${room}」 대화 ${deleted}건을 삭제했습니다.`)
        : text(`「${room}」 채팅방을 찾을 수 없습니다.`, true);
    }
  );

  server.registerTool(
    "delete_network",
    {
      title: "관계망 전체 삭제",
      description: "관계망과 모든 대화 데이터를 영구 삭제합니다. 되돌릴 수 없으므로 사용자 재확인 후 confirm을 true로 호출하세요.",
      inputSchema: {
        box_key: boxKeySchema,
        confirm: z.boolean().describe("사용자가 영구 삭제에 동의했으면 true"),
      },
    },
    async ({ box_key, confirm }) => {
      if (!confirm) return text("삭제하려면 사용자 동의 후 confirm을 true로 호출해 주세요.", true);
      return store.deleteBox(box_key)
        ? text("관계망과 모든 데이터를 영구 삭제했습니다.")
        : boxNotFound();
    }
  );

  return server;
}

function formatEdge(edge: GraphEdge, rank: number, me?: string): string {
  const label = me ? (edge.a === me ? edge.b : edge.a) : `${edge.a} ↔ ${edge.b}`;
  const bar = "●".repeat(Math.max(1, Math.round(edge.score / 20))) + "○".repeat(Math.max(0, 5 - Math.round(edge.score / 20)));
  return `${rank}. ${label} ${bar} ${edge.score}/100 (상호작용 ${edge.interactions}회, 마지막 ${edge.lastAt?.slice(0, 10) ?? "?"})`;
}

function text(message: string, isError = false) {
  return { content: [{ type: "text" as const, text: message }], isError };
}

function boxNotFound() {
  return text("관계망을 찾을 수 없습니다. box_key를 확인하거나 create_network으로 새로 만들어 주세요.", true);
}
