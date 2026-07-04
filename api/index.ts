// Vercel 서버리스 데모 배포용 엔트리포인트.
// 주의: 서버리스 특성상 SQLite가 /tmp에 저장되어 인스턴스 재활용 시 초기화될 수
// 있다 — 데모/테스트 전용이며, 실제 서비스 배포는 영속 볼륨이 있는 환경
// (카카오클라우드 VM 등)에서 Dockerfile로 한다.
process.env.DB_PATH = process.env.DB_PATH ?? "/tmp/memories.db";

const { createApp } = await import("../src/server.js");

export default createApp();
