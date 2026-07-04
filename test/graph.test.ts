import { describe, expect, it } from "vitest";
import { buildGraph, egoRelationships, renderGraphSvg } from "../src/graph.js";
import { ChatMessage } from "../src/store.js";

const NOW = new Date("2026-07-04T12:00");

let nextId = 1;
function msg(room: string, sender: string, sentAt: string | null, content = "..."): ChatMessage {
  return { id: nextId++, box_id: "b", room, sender, sent_at: sentAt, content };
}

describe("buildGraph", () => {
  it("connects people who reply to each other and ranks by interaction", () => {
    const messages = [
      // 나-철수: 활발한 왕복 대화
      msg("철수", "나", "2026-07-01T10:00"),
      msg("철수", "철수", "2026-07-01T10:01"),
      msg("철수", "나", "2026-07-01T10:02"),
      msg("철수", "철수", "2026-07-01T10:03"),
      // 나-영희: 한 번의 왕복
      msg("영희", "나", "2026-07-01T11:00"),
      msg("영희", "영희", "2026-07-01T11:01"),
    ];
    const graph = buildGraph(messages, NOW);
    expect(graph.nodes.map((n) => n.name)).toContain("철수");

    const [top] = graph.edges;
    expect([top.a, top.b].sort()).toEqual(["나", "철수"]);
    expect(top.score).toBe(100);

    const yeonghui = graph.edges.find((e) => e.a === "영희" || e.b === "영희")!;
    expect(yeonghui.weight).toBeLessThan(top.weight);
  });

  it("does not connect people who never talked near each other", () => {
    const messages = [
      msg("방A", "나", "2026-07-01T10:00"),
      msg("방A", "철수", "2026-07-01T10:01"),
      msg("방B", "나", "2026-07-01T11:00"),
      msg("방B", "영희", "2026-07-01T11:01"),
    ];
    const graph = buildGraph(messages, NOW);
    expect(graph.edges.find((e) => [e.a, e.b].sort().join() === "영희,철수")).toBeUndefined();
  });

  it("weights recent conversations higher than old ones", () => {
    const messages = [
      msg("옛친구", "나", "2020-01-01T10:00"),
      msg("옛친구", "옛친구", "2020-01-01T10:01"),
      msg("새친구", "나", "2026-07-01T10:00"),
      msg("새친구", "새친구", "2026-07-01T10:01"),
    ];
    const graph = buildGraph(messages, NOW);
    const [top] = graph.edges;
    expect([top.a, top.b]).toContain("새친구");
  });

  it("boosts reciprocal relationships over one-sided ones", () => {
    const messages = [
      // 일방: 스팸이 나에게 계속 말을 검 (나는 한 번만 시작)
      msg("일방방", "나", "2026-07-01T10:00"),
      msg("일방방", "스팸", "2026-07-01T10:01"),
      msg("일방방", "스팸", "2026-07-01T10:02"),
      msg("일방방", "스팸", "2026-07-01T10:03"),
      // 상호: 같은 횟수의 인접 발화지만 왕복
      msg("상호방", "친구", "2026-07-01T10:00"),
      msg("상호방", "나", "2026-07-01T10:01"),
      msg("상호방", "친구", "2026-07-01T10:02"),
      msg("상호방", "나", "2026-07-01T10:03"),
    ];
    const graph = buildGraph(messages, NOW);
    const spam = graph.edges.find((e) => e.a === "스팸" || e.b === "스팸")!;
    const friend = graph.edges.find((e) => e.a === "친구" || e.b === "친구")!;
    expect(friend.weight).toBeGreaterThan(spam.weight);
  });

  it("egoRelationships returns only edges touching the ego", () => {
    const messages = [
      msg("단톡", "나", "2026-07-01T10:00"),
      msg("단톡", "철수", "2026-07-01T10:01"),
      msg("단톡", "영희", "2026-07-01T10:02"),
    ];
    const graph = buildGraph(messages, NOW);
    const mine = egoRelationships(graph, "나");
    expect(mine.every((e) => e.a === "나" || e.b === "나")).toBe(true);
  });
});

describe("renderGraphSvg", () => {
  it("renders a valid SVG with node labels and the ego at center", () => {
    const messages = [
      msg("단톡", "나", "2026-07-01T10:00"),
      msg("단톡", "철수", "2026-07-01T10:01"),
      msg("단톡", "영희", "2026-07-01T10:02"),
    ];
    const svg = renderGraphSvg(buildGraph(messages, NOW), "나");
    expect(svg).toContain("<svg");
    expect(svg).toContain("철수");
    expect(svg).toContain('cx="320.0" cy="320.0"');
  });

  it("escapes XML-sensitive characters in names", () => {
    const messages = [
      msg("방", "A<B>", "2026-07-01T10:00"),
      msg("방", "나", "2026-07-01T10:01"),
    ];
    const svg = renderGraphSvg(buildGraph(messages, NOW));
    expect(svg).toContain("A&lt;B&gt;");
    expect(svg).not.toContain("A<B>");
  });
});
