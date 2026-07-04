import { NoticeInput } from "./radar-store.js";

/**
 * 한국토지주택공사 분양임대공고문 조회 서비스 어댑터
 * https://www.data.go.kr/data/15058530/openapi.do
 * (apis.data.go.kr/B552555/lhLeaseNoticeInfo1)
 *
 * 응답 필드명은 배포 후 실데이터로 검증한다. 필드명이 다를 가능성에
 * 대비해 후보 키를 순서대로 찾는 tolerant 매핑을 쓴다.
 */

const ENDPOINT = "https://apis.data.go.kr/B552555/lhLeaseNoticeInfo1/lhLeaseNoticeInfo1";

/** 공고 유형 상위코드 (LH 공고 API 문서 기준) — 임대주택 / 분양주택 */
export const LH_TYPE_CODES = ["05", "06"];

function pick(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

/** 20260704 / 2026-07-04 / 2026.07.04 → 2026-07-04 */
export function normalizeDate(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 8) return null;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

/** API 응답(JSON)에서 공고 행 배열을 찾아낸다 */
export function extractRows(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    // 형태: [{resHeader:[...]}, {dsList:[...]}]
    for (const part of payload) {
      if (part && typeof part === "object") {
        for (const value of Object.values(part as Record<string, unknown>)) {
          if (Array.isArray(value) && value.length > 0 && typeof value[0] === "object" && "PAN_ID" in (value[0] as object)) {
            return value as Record<string, unknown>[];
          }
        }
      }
    }
    // dsList가 비어있을 수도 있으므로 이름으로 한 번 더
    for (const part of payload) {
      if (part && typeof part === "object" && Array.isArray((part as Record<string, unknown>).dsList)) {
        return (part as Record<string, unknown>).dsList as Record<string, unknown>[];
      }
    }
    return [];
  }
  if (payload && typeof payload === "object") {
    const object = payload as Record<string, unknown>;
    if (Array.isArray(object.dsList)) return object.dsList as Record<string, unknown>[];
  }
  return [];
}

export function toNoticeInput(row: Record<string, unknown>): NoticeInput | null {
  const externalId = pick(row, ["PAN_ID", "panId"]);
  const title = pick(row, ["PAN_NM", "panNm", "PAN_NM1"]);
  if (!externalId || !title) return null;
  return {
    source: "LH",
    externalId,
    title,
    typeName: pick(row, ["AIS_TP_CD_NM", "UPP_AIS_TP_NM", "aisTpCdNm"]),
    region: pick(row, ["CNP_CD_NM", "cnpCdNm"]),
    status: pick(row, ["PAN_SS", "panSs"]),
    postedOn: normalizeDate(pick(row, ["PAN_NT_ST_DT", "panNtStDt"])),
    closeOn: normalizeDate(pick(row, ["CLSG_DT", "clsgDt", "PAN_ED_DT"])),
    detailUrl: pick(row, ["DTL_URL", "dtlUrl", "DTL_URL_MOB"]) || null,
  };
}

export interface LhFetchResult {
  notices: NoticeInput[];
  pages: number;
}

/** 유형코드별로 최근 공고를 페이지 단위로 수집 */
function yyyymmdd(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

export async function fetchLhNotices(
  serviceKey: string,
  options: { pageSize?: number; maxPages?: number; fetchFn?: typeof fetch; now?: Date } = {}
): Promise<LhFetchResult> {
  const pageSize = options.pageSize ?? 100;
  const maxPages = options.maxPages ?? 5;
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? new Date();
  const notices: NoticeInput[] = [];
  let pages = 0;

  // 실응답(dsSch 에코) 기준 실제 게시일 범위 파라미터는 PAN_ST_DT/PAN_ED_DT다
  // (문서에는 PAN_NT_ST_DT/CLSG_DT로 적혀 있으나 서버가 무시하고 기본값 최근 2개월을 쓴다).
  // 최근 120일 게시분을 조회한다.
  const postedFrom = yyyymmdd(new Date(now.getTime() - 120 * 86_400_000));
  const postedTo = yyyymmdd(now);

  for (const typeCode of LH_TYPE_CODES) {
    for (let page = 1; page <= maxPages; page++) {
      const url = `${ENDPOINT}?serviceKey=${encodeURIComponent(serviceKey)}&PG_SZ=${pageSize}&PAGE=${page}&UPP_AIS_TP_CD=${typeCode}&PAN_ST_DT=${postedFrom}&PAN_ED_DT=${postedTo}`;
      const response = await fetchFn(url, { headers: { Accept: "application/json" } });
      if (!response.ok) {
        throw new Error(`LH API 응답 오류: HTTP ${response.status}`);
      }
      const body = await response.text();
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        throw new Error(`LH API가 JSON이 아닌 응답을 반환했습니다: ${body.slice(0, 120)}`);
      }
      pages += 1;
      const rows = extractRows(payload);
      const mapped = rows.map(toNoticeInput).filter((n): n is NoticeInput => n !== null);
      notices.push(...mapped);
      if (rows.length < pageSize) break; // 마지막 페이지
    }
  }
  return { notices, pages };
}
