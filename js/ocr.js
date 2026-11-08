// OCR: reads the words in a scanned page picture. Runs fully on the device (no internet needed).
import { S, pdfjsLib } from './app.js';
import { $, openSheet, closeSheet, toast, busy, esc } from './ui.js';

const base = new URL('../vendor/ocr/', import.meta.url).href;
let loading = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  return loading ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = base + 'tesseract.min.js'; s.onload = res; s.onerror = () => rej(new Error('OCR engine failed to load'));
    document.head.appendChild(s);
  });
}

async function ocrPage(num, onProgress) {
  await loadTesseract();
  const P = S.pages[num - 1];
  // ~1700px wide is sharp enough for print text but light on memory
  const scale = Math.min(3, 1700 / P.w);
  const vp = P.page.getViewport({ scale });
  const c = document.createElement('canvas');
  c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await P.page.render({ canvasContext: ctx, viewport: vp }).promise;

  const worker = await Tesseract.createWorker('eng', 1, {
    workerPath: base + 'worker.min.js', corePath: base + 'core', langPath: base + 'lang',
    gzip: true, cacheMethod: 'none',
    logger: m => m.status === 'recognizing text' && onProgress?.(Math.round(m.progress * 100)),
  });
  try {
    const { data } = await worker.recognize(c);
    const words = (data.words || []).filter(w => w.confidence > 30 && w.text.trim()).map(w => ({
      text: w.text,
      x: w.bbox.x0 / scale, y: w.bbox.y0 / scale,
      w: (w.bbox.x1 - w.bbox.x0) / scale, h: (w.bbox.y1 - w.bbox.y0) / scale,
    }));
    return { text: data.text || '', words };
  } finally {
    await worker.terminate();
    c.width = 0;
  }
}

export async function openOcr(num) {
  const P = S.pages[num - 1];
  if (!P.text) P.text = await P.page.getTextContent();
  const hasText = P.text.items.some(i => i.str && i.str.trim());
  if (hasText && !confirm(`Page ${num} already has real text you can copy. Run OCR anyway?`)) return;

  busy(`Reading page ${num}… (first time takes longer)`);
  let res;
  try {
    res = await ocrPage(num, pct => busy(`Reading page ${num}… ${pct}%`));
  } catch (e) {
    console.error(e); busy(false);
    return toast('OCR failed: ' + (e.message || e), 4000);
  }
  busy(false);
  if (!res.words.length) return toast('No readable text found on this page.', 3500);

  const body = openSheet(`<h2>Text found on page ${num}</h2>
    <div class="ocr-out" id="o">${esc(res.text.trim())}</div>
    <label class="check"><input type="checkbox" id="keep" checked> Make this page searchable when saved</label>
    <div class="actions"><button class="btn" id="copy">📋 Copy text</button>
    ${num < S.pages.length ? '<button class="btn" id="next">Next page ▶</button>' : ''}
    <button class="btn primary" id="ok">Done</button></div>`);
  const commit = () => {
    if ($('#keep', body).checked) { S.ocr[num] = res.words; S.dirty = true; }
    else delete S.ocr[num];
  };
  $('#copy', body).onclick = async () => {
    try { await navigator.clipboard.writeText(res.text); toast('Copied.'); }
    catch { toast('Long-press the text to copy it.'); }
  };
  $('#ok', body).onclick = () => { commit(); closeSheet(); };
  const next = $('#next', body);
  if (next) next.onclick = () => { commit(); closeSheet(); openOcr(num + 1); };
}
