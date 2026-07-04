import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore, StoreError } from "../src/store.js";

describe("MemoryStore", () => {
  let store: MemoryStore;
  let boxId: string;

  beforeEach(() => {
    store = new MemoryStore(":memory:");
    boxId = store.createBox("테스트 상자").id;
  });

  it("creates and retrieves a box", () => {
    const box = store.getBox(boxId);
    expect(box?.name).toBe("테스트 상자");
    expect(store.getBox("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("saves and retrieves a memory", () => {
    const memory = store.addMemory({
      boxId,
      content: "철수와 점심 약속을 했다",
      person: "철수",
      kind: "promise",
      tags: ["점심"],
      happenedAt: "2026-07-10",
    });
    expect(memory.id).toBeGreaterThan(0);
    expect(memory.person).toBe("철수");
    expect(memory.tags).toEqual(["점심"]);
  });

  it("rejects empty content", () => {
    expect(() => store.addMemory({ boxId, content: "   " })).toThrow(StoreError);
  });

  it("searches with multi-token AND matching including 2-char Korean tokens", () => {
    store.addMemory({ boxId, content: "철수와 점심 약속을 했다", person: "철수" });
    store.addMemory({ boxId, content: "영희가 이직을 고민 중이라고 했다", person: "영희" });

    const hit = store.search({ boxId, query: "점심 약속" });
    expect(hit).toHaveLength(1);
    expect(hit[0].person).toBe("철수");

    const both = store.search({ boxId, query: "했다" });
    expect(both).toHaveLength(2);

    const miss = store.search({ boxId, query: "점심 이직" });
    expect(miss).toHaveLength(0);
  });

  it("matches query tokens against person and tags too", () => {
    store.addMemory({ boxId, content: "생일 선물로 향수를 좋아한다", person: "영희", tags: ["생일"] });
    expect(store.search({ boxId, query: "영희 생일" })).toHaveLength(1);
  });

  it("escapes LIKE wildcards in queries", () => {
    store.addMemory({ boxId, content: "할인율 100% 이벤트 얘기" });
    store.addMemory({ boxId, content: "그냥 잡담" });
    expect(store.search({ boxId, query: "100%" })).toHaveLength(1);
    expect(store.search({ boxId, query: "%" })).toHaveLength(1);
  });

  it("filters by person and kind", () => {
    store.addMemory({ boxId, content: "커피 취향은 아이스 아메리카노", person: "철수", kind: "preference" });
    store.addMemory({ boxId, content: "다음주 회의", person: "철수", kind: "promise" });
    const prefs = store.search({ boxId, person: "철수", kind: "preference" });
    expect(prefs).toHaveLength(1);
    expect(prefs[0].content).toContain("아메리카노");
  });

  it("ranks by token occurrence count", () => {
    store.addMemory({ boxId, content: "여행 얘기 잠깐" });
    store.addMemory({ boxId, content: "여행 계획: 여행지는 제주, 여행 날짜는 8월" });
    const results = store.search({ boxId, query: "여행" });
    expect(results[0].content).toContain("제주");
  });

  it("lists people with counts", () => {
    store.addMemory({ boxId, content: "a", person: "철수" });
    store.addMemory({ boxId, content: "b", person: "철수" });
    store.addMemory({ boxId, content: "c", person: "영희" });
    store.addMemory({ boxId, content: "d" });
    const people = store.listPeople(boxId);
    expect(people).toHaveLength(2);
    expect(people.find((p) => p.person === "철수")?.count).toBe(2);
  });

  it("lists promises in chronological order", () => {
    store.addMemory({ boxId, content: "늦은 약속", kind: "promise", happenedAt: "2026-08-01" });
    store.addMemory({ boxId, content: "빠른 약속", kind: "promise", happenedAt: "2026-07-05" });
    store.addMemory({ boxId, content: "메모", kind: "note" });
    const promises = store.listPromises(boxId);
    expect(promises.map((p) => p.content)).toEqual(["빠른 약속", "늦은 약속"]);
  });

  it("deletes a memory and a whole box with cascade", () => {
    const memory = store.addMemory({ boxId, content: "삭제될 기억" });
    expect(store.deleteMemory(boxId, memory.id)).toBe(true);
    expect(store.deleteMemory(boxId, memory.id)).toBe(false);

    store.addMemory({ boxId, content: "상자와 함께 삭제" });
    expect(store.deleteBox(boxId)).toBe(true);
    expect(store.getBox(boxId)).toBeNull();
  });

  it("does not leak memories across boxes", () => {
    const otherBox = store.createBox("남의 상자").id;
    store.addMemory({ boxId: otherBox, content: "남의 비밀 얘기" });
    expect(store.search({ boxId, query: "비밀" })).toHaveLength(0);
    const memory = store.addMemory({ boxId, content: "내 기억" });
    expect(store.getMemory(otherBox, memory.id)).toBeNull();
  });

  it("exports all memories", () => {
    store.addMemory({ boxId, content: "기억 1" });
    store.addMemory({ boxId, content: "기억 2" });
    const data = store.exportAll(boxId);
    expect(data?.memories).toHaveLength(2);
    expect(data?.box.name).toBe("테스트 상자");
  });

  it("imports and searches chat messages", () => {
    store.importChatMessages(boxId, "철수", [
      { sender: "철수", sentAt: "2026-07-03T14:30", content: "내일 강남역 5번 출구에서 보자" },
      { sender: "나", sentAt: "2026-07-03T14:31", content: "ㅇㅋ 몇 시?" },
      { sender: "철수", sentAt: "2026-07-03T14:32", content: "12시 반" },
    ]);
    store.importChatMessages(boxId, "가족방", [
      { sender: "엄마", sentAt: "2026-07-02T09:00", content: "주말에 집에 오니?" },
    ]);

    const hits = store.searchChat({ boxId, query: "강남역" });
    expect(hits).toHaveLength(1);
    expect(hits[0].sender).toBe("철수");

    const roomFiltered = store.searchChat({ boxId, query: "오니", room: "가족방" });
    expect(roomFiltered).toHaveLength(1);

    const context = store.chatContext(boxId, hits[0].id, 5);
    expect(context.map((m) => m.content)).toContain("12시 반");
    expect(context.every((m) => m.room === "철수")).toBe(true);

    const rooms = store.listRooms(boxId);
    expect(rooms).toHaveLength(2);
    expect(rooms.find((r) => r.room === "철수")?.count).toBe(3);

    expect(store.deleteRoom(boxId, "철수")).toBe(3);
    expect(store.searchChat({ boxId, query: "강남역" })).toHaveLength(0);
    expect(store.chatCount(boxId)).toBe(1);
  });

  it("isolates chat messages between boxes", () => {
    const otherBox = store.createBox("남의 상자").id;
    store.importChatMessages(otherBox, "비밀방", [
      { sender: "타인", sentAt: null, content: "비밀 대화" },
    ]);
    expect(store.searchChat({ boxId, query: "비밀" })).toHaveLength(0);
  });

  it("reports stats", () => {
    store.addMemory({ boxId, content: "a", person: "철수", kind: "promise" });
    store.addMemory({ boxId, content: "b", person: "영희" });
    const stats = store.stats(boxId);
    expect(stats.total).toBe(2);
    expect(stats.byKind.promise).toBe(1);
    expect(stats.people).toBe(2);
  });
});
