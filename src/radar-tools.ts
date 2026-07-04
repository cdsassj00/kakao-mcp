import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Notice, RadarStore } from "./radar-store.js";

const profileKeySchema = z.string().uuid().describe("내 조건 프로필 키 (save_profile로 발급받은 UUID)");

function todayKst(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

export function buildRadarServer(store: RadarStore): McpServer {
  const server = new McpServer(
    {
      name: "home-radar",
      version: "0.1.0",
    },
    {
      instructions: [
        "「내집레이더」는 LH 등 공공기관에 흩어진 임대주택·분양 공고를 서버가 대신 수집해 두었다가, 조건에 맞게 찾아주는 서버입니다.",
        "'서울 접수중인 행복주택 있어?' 같은 질문에는 search_notices를 바로 쓰세요 — 가입이나 키 없이 누구나 즉시 검색할 수 있습니다.",
        "'마감 임박한 것만' 이라고 하면 closing_soon을 쓰세요.",
        "사용자가 조건(지역·유형·키워드)을 저장하고 싶어 하면 save_profile로 프로필 키를 발급하고, 이후 '내 브리핑 보여줘'에는 my_briefing을 쓰세요.",
        "결과를 전할 때는 마감일이 가까운 공고부터, 마감일과 원문 링크를 꼭 함께 안내하세요. 신청 자격(소득·나이 등)은 공고 원문 확인이 필요하다는 점도 알려주세요.",
        "데이터가 언제 수집됐는지 물어보면 data_status를 쓰세요.",
      ].join("\n"),
    }
  );

  server.registerTool(
    "search_notices",
    {
      title: "공고 검색",
      description:
        "수집된 임대주택·분양 공고를 즉시 검색합니다. '서울 접수중인 행복주택 있어?', '경기도 국민임대 뭐 나왔어?' 같은 질문에 사용하세요. 가입 없이 누구나 바로 쓸 수 있습니다.",
      inputSchema: {
        region: z.string().max(20).optional().describe("지역 (예: 서울, 경기, 부산)"),
        type: z.string().max(20).optional().describe("공고 유형 (예: 행복주택, 국민임대, 분양)"),
        keyword: z.string().max(50).optional().describe("제목 키워드 (예: 청년, 신혼)"),
        status: z.string().max(10).optional().describe("공고 상태 필터 (예: 접수중, 공고중)"),
        limit: z.number().int().min(1).max(30).optional().describe("최대 결과 수 (기본 10)"),
      },
    },
    async ({ region, type, keyword, status, limit }) => {
      const notices = store.searchNotices({
        regions: region ? [region] : undefined,
        types: type ? [type] : undefined,
        keywords: keyword ? [keyword] : undefined,
        status,
        limit,
      });
      if (notices.length === 0) {
        return text(emptyMessage(store));
      }
      return text(
        `${notices.length}건의 공고 (마감 임박순):\n\n${notices.map((n) => formatNotice(n)).join("\n\n")}\n\n※ 신청 자격(나이·소득 등)은 공고 원문에서 꼭 확인하세요.`
      );
    }
  );

  server.registerTool(
    "closing_soon",
    {
      title: "마감 임박 공고",
      description: "신청 마감이 임박한 공고를 보여줍니다. '이번 주에 마감되는 거 있어?' 같은 질문에 사용하세요.",
      inputSchema: {
        region: z.string().max(20).optional().describe("지역 필터"),
        days: z.number().int().min(1).max(30).optional().describe("며칠 이내 마감 (기본 7일)"),
      },
    },
    async ({ region, days }) => {
      const notices = store.searchNotices({
        regions: region ? [region] : undefined,
        closingWithinDays: days ?? 7,
        today: todayKst(),
        limit: 20,
      });
      if (notices.length === 0) {
        return text(`${days ?? 7}일 이내 마감 예정인 공고가 없습니다.`);
      }
      return text(
        `⏰ ${days ?? 7}일 이내 마감 ${notices.length}건:\n\n${notices.map((n) => formatNotice(n, todayKst())).join("\n\n")}`
      );
    }
  );

  server.registerTool(
    "notice_detail",
    {
      title: "공고 상세",
      description: "특정 공고의 상세 정보와 원문 링크를 보여줍니다. 검색 결과의 공고 번호(#id)로 조회하세요.",
      inputSchema: {
        notice_id: z.number().int().describe("공고 번호 (#id)"),
      },
    },
    async ({ notice_id }) => {
      const notice = store.getNotice(notice_id);
      if (!notice) return text(`공고 #${notice_id}를 찾을 수 없습니다.`, true);
      return text(
        [
          `📋 ${notice.title}`,
          `- 유형: ${notice.type_name || "-"} / 지역: ${notice.region || "-"} / 상태: ${notice.status || "-"}`,
          `- 게시일: ${notice.posted_on ?? "-"} / 신청 마감: ${notice.close_on ?? "공고문 확인 필요"}`,
          notice.detail_url ? `- 원문 보기: ${notice.detail_url}` : "",
          ``,
          `신청 자격·임대 조건·필요 서류는 원문 공고문에서 확인해야 합니다. 사용자의 상황(나이, 소득, 무주택 여부)을 물어보고 해당 유형의 일반적인 자격 요건을 안내해 주세요.`,
        ]
          .filter(Boolean)
          .join("\n")
      );
    }
  );

  server.registerTool(
    "save_profile",
    {
      title: "내 조건 저장",
      description:
        "관심 지역·유형·키워드를 프로필로 저장하고 키를 발급합니다. 이후 '내 브리핑'으로 조건에 맞는 공고만 모아볼 수 있습니다. 키를 잃어버리면 복구할 수 없으니 보관을 안내하세요.",
      inputSchema: {
        name: z.string().max(30).optional().describe("프로필 이름 (예: 내 조건)"),
        regions: z.array(z.string().max(20)).max(5).optional().describe("관심 지역 (예: ['서울', '경기'])"),
        types: z.array(z.string().max(20)).max(5).optional().describe("관심 유형 (예: ['행복주택', '국민임대'])"),
        keywords: z.array(z.string().max(20)).max(5).optional().describe("키워드 (예: ['청년', '신혼'])"),
      },
    },
    async ({ name, regions, types, keywords }) => {
      const profile = store.createProfile(name?.trim() || "내 조건");
      store.updateProfile(profile.id, { regions: regions ?? [], types: types ?? [], keywords: keywords ?? [] });
      return text(
        [
          `프로필 「${profile.name}」을 저장했습니다.`,
          `- 지역: ${regions?.join(", ") || "전국"} / 유형: ${types?.join(", ") || "전체"} / 키워드: ${keywords?.join(", ") || "-"}`,
          ``,
          `profile_key: ${profile.id}`,
          ``,
          `⚠️ 키를 안전한 곳에 보관하세요. 다음부터 "내 브리핑 보여줘 (키: ...)"라고 하면 조건에 맞는 공고만 모아드립니다.`,
        ].join("\n")
      );
    }
  );

  server.registerTool(
    "my_briefing",
    {
      title: "내 브리핑",
      description: "저장된 프로필 조건에 맞는 공고를 마감 임박순으로 브리핑합니다. '내 브리핑 보여줘'에 사용하세요.",
      inputSchema: { profile_key: profileKeySchema },
    },
    async ({ profile_key }) => {
      const profile = store.getProfile(profile_key);
      if (!profile) return text("프로필을 찾을 수 없습니다. save_profile로 새로 만들어 주세요.", true);
      const notices = store.searchNotices({
        regions: profile.regions.length ? profile.regions : undefined,
        types: profile.types.length ? profile.types : undefined,
        keywords: profile.keywords.length ? profile.keywords : undefined,
        limit: 15,
      });
      if (notices.length === 0) return text(`「${profile.name}」 조건에 맞는 공고가 아직 없습니다. 조건을 넓혀보시겠어요?`);
      const today = todayKst();
      return text(
        [
          `📮 「${profile.name}」 브리핑 (지역: ${profile.regions.join(", ") || "전국"} / 유형: ${profile.types.join(", ") || "전체"})`,
          ``,
          ...notices.map((n) => formatNotice(n, today)),
          ``,
          `※ 신청 자격은 공고 원문에서 확인하세요.`,
        ].join("\n\n")
      );
    }
  );

  server.registerTool(
    "update_profile",
    {
      title: "내 조건 수정",
      description: "저장된 프로필의 지역·유형·키워드를 바꿉니다.",
      inputSchema: {
        profile_key: profileKeySchema,
        regions: z.array(z.string().max(20)).max(5).optional(),
        types: z.array(z.string().max(20)).max(5).optional(),
        keywords: z.array(z.string().max(20)).max(5).optional(),
      },
    },
    async ({ profile_key, regions, types, keywords }) => {
      const updated = store.updateProfile(profile_key, { regions, types, keywords });
      if (!updated) return text("프로필을 찾을 수 없습니다.", true);
      return text(
        `수정했습니다 — 지역: ${updated.regions.join(", ") || "전국"} / 유형: ${updated.types.join(", ") || "전체"} / 키워드: ${updated.keywords.join(", ") || "-"}`
      );
    }
  );

  server.registerTool(
    "delete_profile",
    {
      title: "프로필 삭제",
      description: "저장된 프로필을 영구 삭제합니다.",
      inputSchema: { profile_key: profileKeySchema },
    },
    async ({ profile_key }) => {
      return store.deleteProfile(profile_key)
        ? text("프로필을 삭제했습니다.")
        : text("프로필을 찾을 수 없습니다.", true);
    }
  );

  server.registerTool(
    "data_status",
    {
      title: "데이터 현황",
      description: "공고 데이터가 언제, 어디서, 몇 건 수집됐는지 보여줍니다. 데이터 신뢰성 질문에 사용하세요.",
      inputSchema: {},
    },
    async () => {
      const stats = store.noticeStats();
      if (stats.total === 0) return text(emptyMessage(store));
      return text(
        [
          `수집 현황: 총 ${stats.total}건`,
          ...stats.bySource.map(
            (s) => `- ${s.source}: ${s.count}건 (마지막 수집: ${s.lastFetched?.slice(0, 16).replace("T", " ") ?? "-"} UTC)`
          ),
          `출처: 한국토지주택공사 분양임대공고문 조회 서비스 (공공데이터포털)`,
        ].join("\n")
      );
    }
  );

  return server;
}

function formatNotice(notice: Notice, today?: string): string {
  const dday =
    today && notice.close_on
      ? Math.round((new Date(`${notice.close_on}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86_400_000)
      : null;
  const ddayLabel = dday === null ? "" : dday === 0 ? " (D-DAY!)" : dday > 0 ? ` (D-${dday})` : "";
  return [
    `#${notice.id} [${notice.type_name || notice.source}] ${notice.title}`,
    `   ${notice.region || "-"} · ${notice.status || "-"} · 마감 ${notice.close_on ?? "원문 확인"}${ddayLabel}`,
    notice.detail_url ? `   🔗 ${notice.detail_url}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function emptyMessage(store: RadarStore): string {
  const hasKey = process.env.LH_SERVICE_KEY?.trim() || store.getConfig("lh_service_key");
  return hasKey
    ? "조건에 맞는 공고가 없습니다. 지역이나 유형을 넓혀 다시 검색해 보세요."
    : "공고 데이터가 아직 준비되지 않았습니다 (서버 초기 설정 중). 잠시 후 다시 시도해 주세요.";
}

function text(message: string, isError = false) {
  return { content: [{ type: "text" as const, text: message }], isError };
}
