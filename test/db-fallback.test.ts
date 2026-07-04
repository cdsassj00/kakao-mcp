import { describe, expect, it, vi } from "vitest";

describe("DB 경로 폴백", () => {
  it("falls back to /tmp when DB_PATH is not writable", async () => {
    // /dev/null 하위 경로는 mkdir이 ENOTDIR로 즉시 실패한다
    // (/proc 하위 경로는 이 환경에서 mkdirSync recursive가 무한 루프를 돌므로 사용 금지)
    vi.stubEnv("DB_PATH", "/dev/null/nope/memories.db");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // server.ts는 모듈 로드 시 store를 열므로, env를 세팅한 뒤 fresh import 한다
    vi.resetModules();
    const { createApp } = await import("../src/server.js");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("폴백"),
      expect.anything()
    );
    expect(typeof createApp).toBe("function");
    warn.mockRestore();
    vi.unstubAllEnvs();
  });
});
