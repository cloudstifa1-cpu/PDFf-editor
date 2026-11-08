// Draw-your-signature pad. The signature is remembered on this device only.
import { $, openSheet, closeSheet, swatchesHtml, wireSwatches } from './ui.js';

const KEY = 'signature';

export function chooseSignature() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY)); } catch {}
  if (!saved) return drawSignature();
  return new Promise(resolve => {
    let result = null;
    const body = openSheet(`<h2>Your signature</h2>
      <img src="${saved.dataUrl}" style="width:100%;max-height:140px;object-fit:contain;background:#fff;border-radius:8px">
      <div class="actions"><button class="btn" id="new">Draw a new one</button>
      <button class="btn primary" id="use">Use this</button></div>`, () => { if (result !== undefined) resolve(result); });
    $('#use', body).onclick = () => { result = saved; closeSheet(); };
    $('#new', body).onclick = async () => {
      result = undefined; closeSheet();
      resolve(await drawSignature());
    };
  }).then(r => r);
}

export function drawSignature() {
  return new Promise(resolve => {
    let result = null;
    const body = openSheet(`<h2>Draw your signature</h2>
      <canvas id="sigPad"></canvas>
      ${swatchesHtml(['#000000', '#1a3fbf'], '#000000', 'ink')}
      <div class="actions"><button class="btn" id="clear">Clear</button>
      <button class="btn" id="cancel">Cancel</button><button class="btn primary" id="ok">Save</button></div>`,
      () => { if (result !== undefined) resolve(result); });
    const ink = wireSwatches(body);
    const c = $('#sigPad', body);
    const r = c.getBoundingClientRect();
    const k = Math.min(window.devicePixelRatio || 1, 2);
    c.width = r.width * k; c.height = r.height * k;
    const ctx = c.getContext('2d');
    ctx.scale(k, k); ctx.lineWidth = 2.6; ctx.lineCap = ctx.lineJoin = 'round';
    let drawing = false, any = false, last;
    const pos = e => { const b = c.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
    c.onpointerdown = e => { drawing = true; any = true; last = pos(e); c.setPointerCapture(e.pointerId); ctx.strokeStyle = ink('ink'); };
    c.onpointermove = e => {
      if (!drawing) return;
      const p = pos(e);
      ctx.beginPath(); ctx.moveTo(...last); ctx.lineTo(...p); ctx.stroke(); last = p;
    };
    c.onpointerup = c.onpointercancel = () => (drawing = false);
    $('#clear', body).onclick = () => { ctx.clearRect(0, 0, c.width, c.height); any = false; };
    $('#cancel', body).onclick = closeSheet;
    $('#ok', body).onclick = () => {
      if (!any) return closeSheet();
      result = trim(c);
      try { localStorage.setItem(KEY, JSON.stringify(result)); } catch {}
      closeSheet();
    };
  });
}

/** Crops the empty space around the ink and returns a transparent PNG. */
function trim(c) {
  const ctx = c.getContext('2d');
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  let x0 = width, y0 = height, x1 = 0, y1 = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  const pad = 6;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  const w = Math.min(width, x1 + pad) - x0, h = Math.min(height, y1 + pad) - y0;
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  out.getContext('2d').drawImage(c, x0, y0, w, h, 0, 0, w, h);
  return { dataUrl: out.toDataURL('image/png'), w, h };
}
