/**
 * 카카오톡 공식 "대화 내보내기" 텍스트 파일 파서.
 * 플랫폼별로 형식이 달라 세 가지를 모두 지원한다.
 *
 * PC(Windows/Mac):
 *   --------------- 2026년 7월 4일 금요일 ---------------
 *   [철수] [오후 2:30] 메시지 내용
 *
 * Android:
 *   2026년 7월 4일 오후 2:30, 철수 : 메시지 내용
 *
 * iOS:
 *   2026. 7. 4. 오후 2:30, 철수 : 메시지 내용
 *
 * 어느 패턴에도 맞지 않는 줄은 직전 메시지의 연속(멀티라인)으로 취급한다.
 */

export interface ParsedMessage {
  sender: string;
  /** ISO 형식 (분 단위). 날짜를 알 수 없으면 null */
  sentAt: string | null;
  content: string;
}

const DATE_DIVIDER = /^-*\s*(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s*[월화수목금토일]요일\s*-*\s*$/;
const PC_MESSAGE = /^\[(.+?)\]\s*\[(오전|오후)\s*(\d{1,2}):(\d{2})\]\s?(.*)$/;
const ANDROID_MESSAGE = /^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s*(오전|오후)\s*(\d{1,2}):(\d{2}),\s*(.+?)\s*:\s?(.*)$/;
const IOS_MESSAGE = /^(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.\s*(오전|오후)\s*(\d{1,2}):(\d{2}),\s*(.+?)\s*:\s?(.*)$/;

function to24Hour(meridiem: string, hour: number): number {
  if (meridiem === "오후" && hour !== 12) return hour + 12;
  if (meridiem === "오전" && hour === 12) return 0;
  return hour;
}

function isoAt(year: number, month: number, day: number, hour: number, minute: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
}

export function parseKakaoExport(text: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  let currentDate: { year: number; month: number; day: number } | null = null;
  let current: ParsedMessage | null = null;

  const flush = () => {
    if (current && current.content.trim()) {
      messages.push({ ...current, content: current.content.trim() });
    }
    current = null;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();

    const divider = line.match(DATE_DIVIDER);
    if (divider) {
      flush();
      currentDate = { year: Number(divider[1]), month: Number(divider[2]), day: Number(divider[3]) };
      continue;
    }

    const pc = line.match(PC_MESSAGE);
    if (pc) {
      flush();
      const hour = to24Hour(pc[2], Number(pc[3]));
      current = {
        sender: pc[1].trim(),
        sentAt: currentDate
          ? isoAt(currentDate.year, currentDate.month, currentDate.day, hour, Number(pc[4]))
          : null,
        content: pc[5],
      };
      continue;
    }

    const mobile = line.match(ANDROID_MESSAGE) ?? line.match(IOS_MESSAGE);
    if (mobile) {
      flush();
      const hour = to24Hour(mobile[4], Number(mobile[5]));
      current = {
        sender: mobile[7].trim(),
        sentAt: isoAt(Number(mobile[1]), Number(mobile[2]), Number(mobile[3]), hour, Number(mobile[6])),
        content: mobile[8],
      };
      continue;
    }

    // 패턴에 맞지 않는 줄: 진행 중인 메시지가 있으면 멀티라인으로 이어붙이고,
    // 없으면 헤더/시스템 줄이므로 버린다.
    if (current) {
      current.content += `\n${line}`;
    }
  }
  flush();
  return messages;
}
