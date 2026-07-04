/**
 * 대화 내보내기 파일 업로드 페이지 (GET /upload).
 * 챗에서 링크를 받아 열고, 파일을 선택하면 브라우저가 텍스트를 읽어
 * POST /import로 전송한다. 모바일/PC 모두 동작하며 파일은 서버 DB에만 저장된다.
 */
export function renderUploadPage(prefillBoxKey: string): string {
  const safeKey = /^[0-9a-f-]{36}$/i.test(prefillBoxKey) ? prefillBoxKey : "";
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>그때 뭐랬지? — 대화 가져오기</title>
<style>
  body { font-family: -apple-system, "Malgun Gothic", sans-serif; max-width: 480px; margin: 0 auto; padding: 24px 16px; color: #222; }
  h1 { font-size: 1.3rem; }
  .step { color: #555; font-size: .92rem; line-height: 1.6; background: #f6f6f6; border-radius: 8px; padding: 12px; }
  label { display: block; margin: 16px 0 4px; font-weight: 600; font-size: .95rem; }
  input[type=text] { width: 100%; box-sizing: border-box; padding: 10px; border: 1px solid #ccc; border-radius: 8px; font-size: .95rem; }
  input[type=file] { margin-top: 4px; width: 100%; }
  button { margin-top: 20px; width: 100%; padding: 14px; border: 0; border-radius: 8px; background: #FEE500; font-size: 1rem; font-weight: 700; cursor: pointer; }
  button:disabled { opacity: .5; }
  #results { margin-top: 16px; font-size: .92rem; line-height: 1.7; word-break: break-all; }
  .ok { color: #1a7f37; } .err { color: #c62828; }
</style>
</head>
<body>
<h1>🧠 그때 뭐랬지? — 대화 가져오기</h1>
<div class="step">
  ① 카카오톡 채팅방 ⚙️ 설정 → <b>대화 내용 내보내기</b> (텍스트만)<br>
  ② 저장된 .txt 파일을 아래에서 선택<br>
  ③ 가져오기가 끝나면 AI 채팅에서 바로 검색할 수 있어요
</div>
<label for="key">기억상자 키 (box_key)</label>
<input type="text" id="key" value="${safeKey}" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" autocomplete="off">
<label for="files">대화 내보내기 파일 (.txt, 여러 개 가능)</label>
<input type="file" id="files" accept=".txt,text/plain" multiple>
<button id="go">가져오기</button>
<div id="results"></div>
<script>
const go = document.getElementById('go');
go.addEventListener('click', async () => {
  const key = document.getElementById('key').value.trim();
  const files = document.getElementById('files').files;
  const results = document.getElementById('results');
  results.textContent = '';
  if (!/^[0-9a-f-]{36}$/i.test(key)) { results.innerHTML = '<div class="err">올바른 기억상자 키를 입력해 주세요. (AI 채팅에서 "기억상자 만들어줘"라고 하면 발급됩니다)</div>'; return; }
  if (!files.length) { results.innerHTML = '<div class="err">파일을 선택해 주세요.</div>'; return; }
  go.disabled = true;
  for (const file of files) {
    const line = document.createElement('div');
    line.textContent = file.name + ' … 업로드 중';
    results.appendChild(line);
    try {
      const text = await file.text();
      const res = await fetch('/import?box_key=' + encodeURIComponent(key), {
        method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: text,
      });
      const data = await res.json();
      if (data.ok) {
        line.className = 'ok';
        line.textContent = '✅ ' + file.name + ' → 「' + data.room + '」 ' + data.imported.toLocaleString() + '건 가져옴' + (data.replaced ? ' (이전 ' + data.replaced.toLocaleString() + '건 교체)' : '');
      } else {
        line.className = 'err';
        line.textContent = '❌ ' + file.name + ': ' + data.error;
      }
    } catch (e) {
      line.className = 'err';
      line.textContent = '❌ ' + file.name + ': 업로드 실패 (' + e.message + ')';
    }
  }
  go.disabled = false;
});
</script>
</body>
</html>`;
}
