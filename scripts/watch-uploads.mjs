#!/usr/bin/env node
/**
 * 카카오톡 '대화 내보내기' 자동 업로드 감시 스크립트 (PC용 컴패니언)
 *
 * 사용법:
 *   node scripts/watch-uploads.mjs --server https://<배포주소> --box <box_key> [--dir <감시폴더>]
 *   (환경변수 SERVER_URL, BOX_KEY, WATCH_DIR로도 지정 가능)
 *
 * 동작:
 *   지정한 폴더를 5초마다 확인해서, 새로 생기거나 내용이 바뀐 .txt 파일을
 *   서버의 POST /import로 업로드한다. 채팅방 이름은 파일 머리글에서 자동 인식된다.
 *   같은 채팅방을 다시 내보내면 서버가 이전 내용을 새 전체본으로 교체하므로
 *   중복 걱정 없이 덮어쓰면 된다.
 *
 *   → 사용자가 할 일은 "채팅방에서 대화 내보내기 → 이 폴더에 저장" 뿐이다.
 *
 * 처리한 파일은 .uploaded.json(내용 해시 기준)에 기록해 재업로드를 방지한다.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    server: { type: "string" },
    box: { type: "string" },
    dir: { type: "string" },
  },
});

const SERVER_URL = (args.server ?? process.env.SERVER_URL ?? "").replace(/\/$/, "");
const BOX_KEY = args.box ?? process.env.BOX_KEY ?? "";
const WATCH_DIR = args.dir ?? process.env.WATCH_DIR ?? ".";
const POLL_MS = 5000;

if (!SERVER_URL || !BOX_KEY) {
  console.error("사용법: node scripts/watch-uploads.mjs --server https://<주소> --box <box_key> [--dir <폴더>]");
  process.exit(1);
}

const journalPath = join(WATCH_DIR, ".uploaded.json");
let journal = {};
try {
  journal = JSON.parse(await readFile(journalPath, "utf8"));
} catch {
  // 첫 실행이면 저널이 없다.
}

const pendingSizes = new Map();

async function poll() {
  let entries;
  try {
    entries = await readdir(WATCH_DIR);
  } catch (error) {
    console.error(`폴더를 읽을 수 없습니다: ${WATCH_DIR} (${error.message})`);
    return;
  }
  for (const name of entries) {
    if (!name.toLowerCase().endsWith(".txt")) continue;
    const path = join(WATCH_DIR, name);
    let info;
    try {
      info = await stat(path);
    } catch {
      continue;
    }

    // 저장이 끝나 크기가 안정된 파일만 처리한다 (두 번 연속 같은 크기).
    const lastSize = pendingSizes.get(name);
    pendingSizes.set(name, info.size);
    if (lastSize !== info.size) continue;

    const content = await readFile(path, "utf8");
    const hash = createHash("sha256").update(content).digest("hex");
    if (journal[name] === hash) continue;

    try {
      const response = await fetch(`${SERVER_URL}/import?box_key=${encodeURIComponent(BOX_KEY)}`, {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: content,
      });
      const result = await response.json();
      if (result.ok) {
        journal[name] = hash;
        await writeFile(journalPath, JSON.stringify(journal, null, 2));
        console.log(
          `✅ ${name} → 「${result.room}」 ${result.imported}건 적재` +
            (result.replaced ? ` (기존 ${result.replaced}건 교체)` : "")
        );
      } else {
        console.error(`❌ ${name}: ${result.error}`);
      }
    } catch (error) {
      console.error(`❌ ${name}: 업로드 실패 (${error.message}) — 다음 주기에 재시도`);
    }
  }
}

console.log(`감시 시작: ${WATCH_DIR} → ${SERVER_URL}/import (${POLL_MS / 1000}초 주기)`);
console.log(`카카오톡 채팅방에서 '대화 내보내기'로 이 폴더에 저장하기만 하면 됩니다.`);
await poll();
setInterval(poll, POLL_MS);
