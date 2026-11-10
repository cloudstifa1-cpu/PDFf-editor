// Picture editor: crop, turn, flip, brightness, contrast, colour, black & white.
import { $, openSheet, closeSheet, toast } from './ui.js';

const MAX = 1600;   // working size; keeps memory low on small phones

/** Loads any picture source (data URL, Blob, canvas) into a canvas no bigger than MAX. */
export async function toCanvas(src) {
  let bmp;
  if (src instanceof HTMLCanvasElement) bmp = src;
  else {
    const blob = typeof src === 'string' ? await (await fetch(src)).blob() : src;
    bmp = await createImageBitmap(blob);
  }
  const k = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  if (bmp.close) bmp.close();
  return c;
}

/** Turn/flip a canvas. rot = 0/90/180/270 clockwise. */
function transform(src, rot, fh, fv) {
  const c = document.createElement('canvas');
  const side = rot % 180 !== 0;
  c.width = side ? src.height : src.width; c.height = side ? src.width : src.height;
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(rot * Math.PI / 180);
  ctx.scale(fh ? -1 : 1, fv ? -1 : 1);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

/** Brightness/contrast/colour done by hand so it works in every browser. */
function adjust(c, b, ct, sat) {
  if (b === 100 && ct === 100 && sat === 100) return;
  const ctx = c.getContext('2d');
  const img = ctx.getImageData(0, 0, c.width, c.height), d = img.data;
  const bf = b / 100, cf = ct / 100, sf = sat / 100;
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i] * bf, g = d[i + 1] * bf, bl = d[i + 2] * bf;
    r = (r - 128) * cf + 128; g = (g - 128) * cf + 128; bl = (bl - 128) * cf + 128;
    const grey = 0.299 * r + 0.587 * g + 0.114 * bl;
    d[i] = grey + (r - grey) * sf; d[i + 1] = grey + (g - grey) * sf; d[i + 2] = grey + (bl - grey) * sf;
  }
  ctx.putImageData(img, 0, 0);
}

function hasAlpha(c) {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 4 * 7) if (d[i] < 250) return true;
  return false;
}

/**
 * Opens the editor. Resolves to {canvas, dataUrl, w, h, changedShape} or null if cancelled.
 * opts.note: extra line of help under the title.
 */
export function editImage(src, opts = {}) {
  return new Promise(async resolve => {
    let base;
    try { base = await toCanvas(src); } catch { toast('Could not read that picture.'); return resolve(null); }
    let st = { rot: 0, fh: false, fv: false, crop: { x: 0, y: 0, w: 1, h: 1 }, b: 100, c: 100, s: 100, cropping: false };
    let geo = base, result = null;

    const body = openSheet(`<h2>Edit picture</h2>${opts.note ? `<p>${opts.note}</p>` : ''}
      <div class="ie-wrap"><canvas id="iePrev"></canvas><div id="ieCrop" hidden><i data-h="nw"></i><i data-h="ne"></i><i data-h="sw"></i><i data-h="se"></i></div></div>
      <div class="org-bar">
        <button class="btn" data-a="crop">✂️ Crop</button><button class="btn" data-a="rot">⟳ Turn</button>
        <button class="btn" data-a="fh">↔ Flip</button><button class="btn" data-a="fv">↕ Flip</button>
        <button class="btn" data-a="bw">⚫ Black & white</button><button class="btn" data-a="reset">↺ Reset</button>
      </div>
      <label>Brightness <b id="vb">100</b></label><input type="range" id="rb" min="40" max="180" value="100">
      <label>Contrast <b id="vc">100</b></label><input type="range" id="rc" min="40" max="200" value="100">
      <label>Colour <b id="vs">100</b></label><input type="range" id="rs" min="0" max="200" value="100">
      <div class="actions"><button class="btn" id="x">Cancel</button><button class="btn primary" id="ok">✔ Use picture</button></div>`,
      () => resolve(result));
    body.classList.add('tall');
    const prev = $('#iePrev', body), box = $('#ieCrop', body);

    function draw() {
      const maxW = Math.min(body.clientWidth - 32, 520), maxH = window.innerHeight * 0.38;
      const k = Math.min(maxW / geo.width, maxH / geo.height);
      prev.width = Math.round(geo.width * k); prev.height = Math.round(geo.height * k);
      prev.getContext('2d').drawImage(geo, 0, 0, prev.width, prev.height);
      prev.style.filter = `brightness(${st.b}%) contrast(${st.c}%) saturate(${st.s}%)`;
      box.hidden = !st.cropping;
      const cr = st.crop;
      Object.assign(box.style, { left: prev.offsetLeft + cr.x * prev.width + 'px', top: prev.offsetTop + cr.y * prev.height + 'px',
        width: cr.w * prev.width + 'px', height: cr.h * prev.height + 'px' });
      if (!st.cropping) {   // show the crop result by dimming outside
        prev.style.clipPath = `inset(${cr.y * 100}% ${(1 - cr.x - cr.w) * 100}% ${(1 - cr.y - cr.h) * 100}% ${cr.x * 100}%)`;
      } else prev.style.clipPath = '';
    }
    const regeo = () => { geo = transform(base, st.rot, st.fh, st.fv); st.crop = { x: 0, y: 0, w: 1, h: 1 }; draw(); };
    draw();

    body.querySelector('.org-bar').addEventListener('click', e => {
      const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
      if (a === 'crop') { st.cropping = !st.cropping; e.target.closest('button').classList.toggle('primary', st.cropping); if (st.cropping) toast('Drag the corners. Tap ✂️ Crop again when done.'); }
      if (a === 'rot') { st.rot = (st.rot + 90) % 360; regeo(); }
      if (a === 'fh') { st.fh = !st.fh; regeo(); }
      if (a === 'fv') { st.fv = !st.fv; regeo(); }
      if (a === 'bw') { st.s = st.s ? 0 : 100; $('#rs', body).value = st.s; $('#vs', body).textContent = st.s; }
      if (a === 'reset') {
        st = { rot: 0, fh: false, fv: false, crop: { x: 0, y: 0, w: 1, h: 1 }, b: 100, c: 100, s: 100, cropping: false };
        ['b', 'c', 's'].forEach(k => { $('#r' + k, body).value = 100; $('#v' + k, body).textContent = 100; });
        body.querySelector('[data-a=crop]').classList.remove('primary');
        geo = base;
      }
      draw();
    });
    ['b', 'c', 's'].forEach(k => {
      const r = $('#r' + k, body);
      r.oninput = () => { st[k] = +r.value; $('#v' + k, body).textContent = r.value; draw(); };
    });

    // Crop box dragging (corners resize, middle moves)
    let drag = null;
    box.addEventListener('pointerdown', e => {
      box.setPointerCapture(e.pointerId);
      drag = { h: e.target.dataset.h || 'move', x: e.clientX, y: e.clientY, c: { ...st.crop } };
      e.preventDefault();
    });
    box.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = (e.clientX - drag.x) / prev.width, dy = (e.clientY - drag.y) / prev.height, o = drag.c, m = 0.05;
      let { x, y, w, h } = o;
      if (drag.h === 'move') { x = Math.min(1 - w, Math.max(0, o.x + dx)); y = Math.min(1 - h, Math.max(0, o.y + dy)); }
      else {
        if (drag.h.includes('w')) { x = Math.min(o.x + o.w - m, Math.max(0, o.x + dx)); w = o.x + o.w - x; }
        if (drag.h.includes('e')) w = Math.max(m, Math.min(1 - o.x, o.w + dx));
        if (drag.h.includes('n')) { y = Math.min(o.y + o.h - m, Math.max(0, o.y + dy)); h = o.y + o.h - y; }
        if (drag.h.includes('s')) h = Math.max(m, Math.min(1 - o.y, o.h + dy));
      }
      st.crop = { x, y, w, h }; draw();
    });
    const up = () => (drag = null);
    box.addEventListener('pointerup', up); box.addEventListener('pointercancel', up);

    $('#x', body).onclick = closeSheet;
    $('#ok', body).onclick = () => {
      const cr = st.crop;
      const out = document.createElement('canvas');
      out.width = Math.max(1, Math.round(cr.w * geo.width)); out.height = Math.max(1, Math.round(cr.h * geo.height));
      out.getContext('2d').drawImage(geo, cr.x * geo.width, cr.y * geo.height, out.width, out.height, 0, 0, out.width, out.height);
      adjust(out, st.b, st.c, st.s);
      const png = hasAlpha(out);
      const changedShape = st.rot % 180 !== 0 || cr.w < 0.999 || cr.h < 0.999;
      result = { canvas: out, dataUrl: out.toDataURL(png ? 'image/png' : 'image/jpeg', 0.88), w: out.width, h: out.height,
        changedShape, flipped: st.fh || st.fv || st.rot !== 0, png };
      closeSheet();
    };
  });
}
