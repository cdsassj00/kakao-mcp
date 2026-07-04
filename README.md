# 사람사전 📖

> 내 주변 사람들의 사전 — 개인 인맥 기록(Personal CRM) MCP 서버
> — Kakao PlayMCP **AGENTIC PLAYER 10** 출품작

"철수랑 마지막에 무슨 얘기했더라?", "지난달에 약속한 게 뭐였지?"
연락처에는 번호만 남고 관계의 맥락은 사라집니다.
「사람사전」에서 사람 이름을 찾아보면, 그 사람과의 약속·취향·대화가 나옵니다.

> 이 저장소에는 자매 서버 **「인맥 온톨로지」**(대화 기록 기반 관계망 그래프)도
> 함께 들어 있습니다 — [아래 섹션](#인맥-온톨로지--관계망-그래프-서버) 참고.

대부분의 MCP 서버가 **외부 API를 연동**하는 데 그치는 것과 달리, 이 서버는
**사용자 동의 하에 사용자의 대화 내용 자체를 DB화**하고 MCP 도구로 다시 꺼내 쓰게 하는
**개인 기억 저장소**라는 새로운 발상에서 출발했습니다.

**모든 핵심 경험은 AI 채팅 안에서 완결됩니다.** 기억 저장·검색·사람별 요약·약속 관리는 물론,
과거 대화 가져오기까지 챗 안에서 해결됩니다 (붙여넣기 또는 챗이 건네주는 업로드 링크 클릭).

데이터가 들어오는 경로는 두 가지입니다:

1. **평소 기억 저장** — 대화 중 "이거 기억해줘"라고 하면 요약을 저장 (`remember` → `recall`)
2. **과거 대화 통째 검색** — 카카오톡 공식 **"대화 내보내기"** 텍스트를 넣으면
   과거 대화 원문 전체가 검색 대상이 됨 (`import_kakao_export` → `search_chat`)
   - 짧으면: 챗에 그대로 붙여넣기
   - 길거나 모바일이면: 챗에서 `upload_page_link`로 받은 **업로드 페이지**에서 파일 선택
   - PC 파워유저면: 감시 폴더 스크립트로 반자동화 (선택사항)

## 카카오톡 대화에 직접 접근할 수 있나요?

**아니요, 그 누구도 불가능합니다.** 카카오톡 대화 원본은 사용자의 기기와 카카오 서버에만 있고,
카카오는 대화 내용을 읽는 API를 제3자에게 제공하지 않습니다 (메시지 "보내기" API만 존재).
톡서랍·채팅방 서랍·받은 파일도 마찬가지입니다.

그래서 이 서버는 **사용자가 스스로 꺼낸 데이터**(카카오톡 공식 대화 내보내기 기능)를
**사용자가 직접 넣어주는** 방식을 씁니다. 본인 데이터를 본인 동의로 가져오는,
약관과 개인정보 원칙을 지키는 유일한 경로입니다.

## 대화 파일 가져오기 3단계 경로

**① 챗에 붙여넣기** (기본) — 내보내기 텍스트를 채팅에 붙여넣으면 `import_kakao_export`가 처리.

**② 업로드 페이지** (긴 파일/모바일) — 챗에서 "파일이 너무 커"라고 하면 AI가
`upload_page_link`로 `/upload` 페이지 링크를 건네줍니다. 파일을 선택하면 끝.
채팅방 이름은 파일 머리글에서 자동 인식되고, 완료 즉시 챗에서 검색 가능합니다.
(서버 환경변수 `PUBLIC_URL`에 배포 주소를 설정해야 링크가 안내됩니다)

**③ 감시 폴더 스크립트** (PC 파워유저, 선택사항) — 내보내기 버튼 이후 전부 자동:

```bash
node scripts/watch-uploads.mjs --server https://<배포주소> --box <box_key> --dir ~/kakao-exports
```

폴더에 내보내기 파일을 저장하기만 하면 자동 업로드됩니다.

②③ 공통으로, 같은 채팅방을 다시 올리면 서버가 이전 본을 새 전체본으로 **교체**하므로
중복 없이 주기적으로 갱신할 수 있습니다. (`POST /import` 엔드포인트, 최대 30MB)

> 왜 "완전 자동"은 없나요? — 모바일은 OS 앱 샌드박스가 타 앱의 카카오톡 DB 접근을
> 차단하고, PC 로컬 DB는 암호화되어 있어 우회하면 약관 위반입니다. 알림 가로채기 방식은
> 기술적으로 가능하지만 수신 메시지만 잡히는 데다 약관 회색지대라 채택하지 않았습니다.

## 어떻게 쓰나요?

AI 채팅(PlayMCP AI 채팅, Kakao Tools 등)에서 자연어로 대화하면 에이전트가 도구를 호출합니다.

```
👤 "기억상자 하나 만들어줘"
🤖 → create_memory_box → "box_key를 안전한 곳에 보관하세요!"

👤 "철수랑 다음주 화요일에 점심 먹기로 한 거 기억해줘"
🤖 → remember(person: 철수, kind: promise, happened_at: ...)

... 2주 뒤 ...

👤 "나 철수랑 뭐 하기로 했었지?"
🤖 → recall(query: "철수") → "다음주 화요일 점심 약속이 있었어요"

👤 "영희에 대해 내가 기억해둔 거 다 보여줘"
🤖 → person_summary(person: 영희) → 취향/약속/메모 정리
```

과거 대화 통째 검색:

```
👤 (카카오톡 채팅방 설정 → 대화 내보내기 → 텍스트 붙여넣기)
   "이거 철수랑 나눈 대화인데 보관해줘"
🤖 → import_kakao_export(room: 철수) → "대화 1,842건을 가져왔습니다"

👤 "철수가 예약했다던 식당 이름이 뭐였지?"
🤖 → search_chat(query: "식당 예약") → "온기정으로 예약했다고 했네요 (7/3 오후 2:30)"

👤 "그 앞뒤 대화 보여줘"
🤖 → chat_context(message_id: ...) → 전후 맥락 표시
```

## MCP 도구 목록

| 도구 | 설명 |
|---|---|
| `create_memory_box` | 기억상자 생성, 접근 키(box_key) 발급 |
| `remember` | 대화 내용 저장 (사람, 종류, 태그, 날짜 포함) |
| `recall` | 키워드/사람/종류로 기억 검색 |
| `person_summary` | 특정 사람에 대한 기억을 종류별로 요약 |
| `list_people` | 기억에 등장하는 사람 목록 |
| `list_promises` | 약속만 날짜순으로 조회 |
| `memory_stats` | 기억상자 현황 |
| `forget` | 개별 기억 삭제 |
| `delete_memory_box` | 상자 전체 영구 삭제 |
| `export_memories` | 전체 기억 JSON 내보내기 |
| `import_kakao_export` | 카카오톡 대화 내보내기 텍스트 임포트 (PC/Android/iOS 형식 지원) |
| `upload_page_link` | 대화 파일 업로드 페이지 링크 안내 (챗 안에서 파일 임포트 연결) |
| `search_chat` | 임포트된 대화 원문 키워드 검색 |
| `chat_context` | 검색된 메시지의 앞뒤 대화 흐름 조회 |
| `list_chat_rooms` | 임포트된 채팅방 목록과 기간 |
| `delete_chat_room` | 특정 채팅방 대화 전체 삭제 |

기억 종류(kind): `note`(메모) · `promise`(약속) · `preference`(취향)

## 설계 포인트

- **Streamable HTTP (stateless)**: 요청마다 MCP 서버 인스턴스를 생성하는 무상태 구조로, 세션 관리 없이 수평 확장이 가능합니다. PlayMCP가 요구하는 원격 HTTPS Endpoint에 그대로 연결됩니다.
- **한국어 검색**: SQLite FTS5 트라이그램은 한국어 2글자 토큰("점심", "약속")을 매칭하지 못하는 제약이 있어, 개인 기억 규모(상자당 최대 5,000건)에 맞는 **다중 토큰 AND 매칭 + 출현 빈도 스코어링**을 자체 구현했습니다.
- **프라이버시 우선**: 자동 수집 없음, UUID 키 기반 상자 격리, 삭제·내보내기 도구 제공. 자세한 내용은 [PRIVACY.md](./PRIVACY.md) 참고.

## 개발

```bash
npm install
npm run dev        # 개발 서버 (기본 :3000)
npm test           # 테스트 (vitest)
npm run build      # dist/ 빌드
npm start          # 프로덕션 실행
```

환경변수:

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `3000` | 리스닝 포트 |
| `DB_PATH` | `data/memories.db` | SQLite 파일 경로 (`:memory:` 가능) |
| `PUBLIC_URL` | (없음) | 배포된 공개 주소 — 설정 시 챗에서 업로드 페이지 링크 안내 가능 |

엔드포인트:
- `POST /mcp` — MCP Streamable HTTP 엔드포인트
- `GET /upload[?box_key=<uuid>]` — 대화 파일 업로드 페이지 (모바일/PC)
- `POST /import?box_key=<uuid>[&room=<이름>]` — 대화 내보내기 텍스트 업로드 API
- `GET /healthz` — 헬스체크

로컬 확인:

```bash
curl -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

## 배포 (카카오클라우드 → PlayMCP)

1. 컨테이너 빌드/실행:
   ```bash
   docker build -t remember-talk-mcp .
   docker run -p 3000:3000 -v $(pwd)/data:/data remember-talk-mcp
   ```
2. 카카오클라우드 등에 배포해 HTTPS Endpoint 확보 (`https://<도메인>/mcp`)
   - `DB_PATH`가 가리키는 볼륨을 영속 스토리지로 마운트할 것
3. [PlayMCP 개발자 콘솔](https://playmcp.kakao.com/)에서 MCP 서버 등록 → Endpoint 입력
4. AI 채팅에서 도구 동작 테스트
5. 서버 공개 상태를 **전체 공개**로 전환
6. 페이지 하단 **Player 예선 참여** 버튼으로 접수 (마감: 7/14)

## 인맥 온톨로지 — 관계망 그래프 서버

같은 저장소에 들어 있는 자매 MCP 서버입니다 (`src/ontology-server.ts`, `Dockerfile.ontology`).
임포트한 카카오톡 대화에서 **관계망을 결정론적으로 계산**해 그래프와 강도로 보여줍니다.

```
👤 (대화 내보내기 붙여넣기) → import_kakao_export
👤 "내 관계망 보여줘" → relationship_map(me: 홍길동)
🤖 1. 철수 ●●●●● 100/100 (상호작용 214회, 마지막 2026-07-01)
   2. 영희 ●●●○○ 61/100 ...
   🗺️ 관계망 지도: https://<주소>/map?box_key=...&me=홍길동  ← SVG 그래프
```

- **노드** = 발화자, **엣지** = 인접 발화(창 3), **강도** = 빈도 × 최근성 감쇠(반감기 90일) × 상호성 보정
- LLM 추측이 아닌 결정론적 집계라 같은 입력에 항상 같은 결과
- `GET /map` 이 관계망 SVG를 렌더링 (ego 중심 원형 배치, 강도 = 선 굵기)
- 도구: `create_network` · `import_kakao_export` · `relationship_map` · `relationship_strength` · `list_chat_rooms` · `delete_chat_room` · `delete_network`
- 배포: 카카오클라우드 Git 소스 빌드에서 **Dockerfile 경로만 `Dockerfile.ontology`로** 지정 (환경변수 `DB_PATH` 기본 `data/ontology.db`)

## 로드맵 (본선 고도화 후보)

- [ ] 카카오 OAuth 연동 — 키 없이 계정 기반 접근
- [ ] 약속 리마인더 — 다가오는 약속 알림
- [ ] 임베딩 기반 의미 검색 — "돈 얘기" → 축의금/월급 기억까지 검색
- [ ] box_key 파생 키를 이용한 at-rest 암호화
- [ ] 기억 자동 요약 — 사람별 관계 타임라인 생성

## 라이선스

MIT
