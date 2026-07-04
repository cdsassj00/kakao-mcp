# 사람사전 📖 · 말로 쓰는 가계부 📒

> Kakao PlayMCP **AGENTIC PLAYER 10** 출품작 2종 (한 저장소, 별도 배포)
>
> 두 서버 모두 **AI 채팅 안에서 100% 완결**됩니다 — 외부 앱, 파일 업로드, 수동 단계 없음.

| | 사람사전 | 말로 쓰는 가계부 |
|---|---|---|
| 한 줄 | 내 주변 사람들의 사전 | "아아 4,500원" 한마디로 기록되는 가계부 |
| 엔트리 | `src/server.ts` | `src/ledger-server.ts` |
| Dockerfile | `Dockerfile` | `Dockerfile.ledger` |
| DB | `data/memories.db` | `data/ledger.db` |

## 사람사전 — 내 주변 사람들의 사전

"철수랑 마지막에 무슨 얘기했더라?", "지난달에 약속한 게 뭐였지?"
연락처에는 번호만 남고 관계의 맥락은 사라집니다. 사람사전에서 사람 이름을
찾아보면, 그 사람과의 약속·취향·기억이 표제어처럼 펼쳐집니다.

```
👤 "기억상자 만들어줘"                       → create_memory_box (열쇠 발급)
👤 "철수랑 화요일 점심 약속 기억해줘"          → remember(person: 철수, kind: promise)
👤 "나 철수랑 뭐 하기로 했었지?"              → recall
👤 "영희에 대해 내가 기억해둔 거 보여줘"       → person_summary (취향/약속/메모 정리)
👤 "나 약속 뭐 있지?"                        → list_promises
```

도구 10종: `create_memory_box` · `remember` · `recall` · `person_summary` · `list_people` · `list_promises` · `memory_stats` · `forget` · `delete_memory_box` · `export_memories`

## 말로 쓰는 가계부 — 기록은 한마디, 계산은 서버가

가계부 앱은 켜기 귀찮아서 끊깁니다. 여기서는 대화가 곧 기록입니다.

```
👤 "가계부 만들어줘"                          → create_ledger (열쇠 발급)
👤 "아아 4500원, 점심 12000원"               → add_entries (여러 건 한 번에)
👤 "이번 달 얼마 썼어?"                       → monthly_report (카테고리별 막대 + 예산 대비)
👤 "식비 예산 40만원으로 잡아줘"               → set_budget (초과 시 기록 때마다 자동 경고)
👤 "이번 달 카페 내역 보여줘"                  → list_entries
```

- 금액 합계·예산 비교는 **전부 서버가 SQL로 계산** — LLM 암산 오류 원천 차단 (심사 기준 '정확한 데이터')
- 도구 8종: `create_ledger` · `add_entries` · `monthly_report` · `list_entries` · `set_budget` · `delete_entry` · `export_ledger` · `delete_ledger`

## 공통 설계

- **Streamable HTTP (stateless)**: 요청마다 MCP 서버 인스턴스를 생성, 세션 관리 없이 수평 확장. PlayMCP가 요구하는 원격 endpoint 방식 그대로 (`POST /mcp`, `GET /healthz`)
- **열쇠(box_key) 기반 격리**: 로그인 없이 UUID 열쇠를 가진 본인만 접근. 상자/가계부 간 완전 격리 (테스트로 검증)
- **프라이버시**: 명시적 요청만 저장, 삭제·내보내기 도구 제공, 외부 API 호출·제3자 제공 없음 → [PRIVACY.md](./PRIVACY.md)
- **외부 의존성 제로**: 날씨 API도, 검색 API도 안 씁니다. 죽을 외부 요인이 없습니다

## 개발

```bash
npm install
npm run dev                                    # 사람사전 (기본 :3000)
npx tsx src/ledger-server.ts                   # 가계부
npm test                                       # vitest
npm run build && npm start
```

| 환경변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `3000` | 리스닝 포트 |
| `DB_PATH` | `data/memories.db` / `data/ledger.db` | SQLite 경로 (쓰기 불가 시 /tmp 폴백) |

## 배포 (카카오클라우드 PlayMCP in KC — Git 소스 빌드)

같은 Git URL로 서버를 2개 등록하고 Dockerfile 경로만 다르게 지정:

| 서버 | Git URL | 브랜치 | Dockerfile 경로 |
|---|---|---|---|
| 사람사전 | `https://github.com/cdsassj00/kakao-mcp.git` | `main` | `Dockerfile` |
| 말로 쓰는 가계부 | (동일) | `main` | `Dockerfile.ledger` |

등록 카피·접수 체크리스트: [docs/playmcp-registration.md](./docs/playmcp-registration.md)

## 본선 고도화 카드 (코드는 저장소에 보존)

예선용 도구 목록에서는 뺐지만 구현이 끝나 있는 기능들 — 본선(Kakao Tools) 환경에 맞춰 재도입 후보:

- **카톡 대화 임포트·원문 검색** (`src/kakao-parser.ts`, store의 chat_* 메서드): PC/Android/iOS '대화 내보내기' 파싱, 한국어 2글자 토큰까지 매칭되는 검색
- **관계망 지도** (`src/graph.ts`): 대화 빈도 × 최근성 × 상호성 기반 관계 강도, ego 중심 SVG 렌더링 — Kakao Tools의 Widget 스펙과 잘 맞음
- 카카오 OAuth(열쇠 없는 접근), 약속 리마인더, 임베딩 의미 검색

## 라이선스

MIT
