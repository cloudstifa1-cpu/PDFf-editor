// Mobile reading mode: pulls the text out of the PDF and shows it as big, wrapping text.
import { S } from './app.js';
import { $, esc } from './ui.js';

let size = +localStorage.getItem('readerSize') || 20;
let runId = 0;

function setSize(n) {
  size = Math.max(14, Math.min(40, n));
  localStorage.setItem('readerSize', size);
  $('#readerText').style.fontSize = size + 'px';
}
$('#readerSmaller').onclick = () => setSize(size - 2);
$('#readerBigger').onclick = () => setSize(size + 2);
$('#readerClose').onclick = () => { runId++; $('#reader').hidden = true; $('#readerText').innerHTML = ''; };

/** Turns one page's text pieces into paragraphs. */
function paragraphs(items) {
  const lines = [];
  let cur = null;
  for (const it of items) {
    if (!('str' in it)) continue;
    const y = it.transform[5], h = Math.hypot(it.transform[2], it.transform[3]) || 10;
    if (!cur) cur = { text: '', y, h };
    cur.text += it.str;
    if (it.hasEOL) { lines.push(cur); cur = null; }
  }
  if (cur) lines.push(cur);
  const paras = [];
  let p = '';
  lines.forEach((ln, i) => {
    const t = ln.text.trim();
    const prev = lines[i - 1];
    const gap = prev ? Math.abs(prev.y - ln.y) : 0;
    if (!t || (prev && gap > prev.h * 1.7)) { if (p) paras.push(p); p = ''; }
    if (!t) return;
    if (!p) p = t;
    else if (p.endsWith('-')) p = p.slice(0, -1) + t;   // join words split across lines
    else p += ' ' + t;
  });
  if (p) paras.push(p);
  return paras;
}

export async function openReader() {
  const id = ++runId;
  const out = $('#readerText');
  out.innerHTML = '';
  setSize(size);
  $('#reader').hidden = false;
  const start = S.current || 1;
  for (let n = 1; n <= S.pages.length; n++) {
    if (id !== runId) return;               // closed
    const P = S.pages[n - 1];
    const tc = P.text || await P.page.getTextContent();
    let paras = paragraphs(tc.items);
    if (!paras.length && S.ocr[n]) paras = [S.ocr[n].map(w => w.text).join(' ')];
    const sec = document.createElement('section');
    sec.id = 'r' + n;
    sec.innerHTML = `<h3>Page ${n}</h3>` + (paras.length
      ? paras.map(t => `<p>${esc(t)}</p>`).join('')
      : `<p class="scan">No text on this page — it's probably a scanned picture. Use OCR in the ⋮ menu to turn it into text.</p>`);
    out.appendChild(sec);
    if (n === start && n > 1) sec.scrollIntoView();
    if (n % 5 === 0) await new Promise(r => setTimeout(r, 0));  // stay responsive on slow phones
  }
}
