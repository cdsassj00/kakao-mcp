import { describe, expect, it } from "vitest";
import { parseKakaoExport } from "../src/kakao-parser.js";

describe("parseKakaoExport", () => {
  it("parses PC (Windows) export format with date dividers", () => {
    const text = [
      "철수 님과 카카오톡 대화",
      "저장한 날짜 : 2026-07-04 12:00:00",
      "",
      "--------------- 2026년 7월 3일 금요일 ---------------",
      "[철수] [오후 2:30] 내일 점심 어때?",
      "[나] [오후 2:31] 좋아 어디서 볼까",
      "[철수] [오후 11:59] 강남역 5번 출구",
      "--------------- 2026년 7월 4일 토요일 ---------------",
      "[나] [오전 12:01] ㅇㅋ",
    ].join("\n");

    const messages = parseKakaoExport(text);
    expect(messages).toHaveLength(4);
    expect(messages[0]).toEqual({
      sender: "철수",
      sentAt: "2026-07-03T14:30",
      content: "내일 점심 어때?",
    });
    expect(messages[2].sentAt).toBe("2026-07-03T23:59");
    expect(messages[3].sentAt).toBe("2026-07-04T00:01");
  });

  it("parses Android export format", () => {
    const text = [
      "2026년 7월 3일 오후 2:30, 철수 : 내일 점심 어때?",
      "2026년 7월 3일 오전 12:05, 나 : 새벽이야 자자",
    ].join("\n");
    const messages = parseKakaoExport(text);
    expect(messages).toHaveLength(2);
    expect(messages[0].sentAt).toBe("2026-07-03T14:30");
    expect(messages[1].sentAt).toBe("2026-07-03T00:05");
    expect(messages[1].sender).toBe("나");
  });

  it("parses iOS export format", () => {
    const messages = parseKakaoExport("2026. 7. 3. 오후 2:30, 영희 : 회의 미뤄졌어");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      sender: "영희",
      sentAt: "2026-07-03T14:30",
      content: "회의 미뤄졌어",
    });
  });

  it("joins multi-line messages", () => {
    const text = [
      "--------------- 2026년 7월 3일 금요일 ---------------",
      "[철수] [오후 2:30] 주소 보낼게",
      "서울시 강남구 테헤란로 1",
      "2층이야",
      "[나] [오후 2:31] 고마워",
    ].join("\n");
    const messages = parseKakaoExport(text);
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe("주소 보낼게\n서울시 강남구 테헤란로 1\n2층이야");
  });

  it("ignores header lines and returns empty for non-export text", () => {
    expect(parseKakaoExport("그냥 아무 텍스트\n두번째 줄")).toHaveLength(0);
  });

  it("handles sender names containing colons and brackets in message body", () => {
    const messages = parseKakaoExport("2026년 7월 3일 오후 2:30, 철수 : 비율은 3 : 1로 하자");
    expect(messages[0].content).toBe("비율은 3 : 1로 하자");
  });
});
