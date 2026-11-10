// Edit, replace or remove pictures that are already inside the PDF (on the current page).
import { S, loadBytes, confirmBake } from './app.js';
import { buildPdf, openLib } from './export.js';
import { editImage, toCanvas } from './imgedit.js';
import { $, openSheet, closeSheet, toast, busy, dataUrlToBytes } from './ui.js';

const L = PDFLib, N = n => L.PDFName.of(n);

/** Turns a PDF image object into a canvas, or null if it's a kind we can't read. */
async function decode(stream) {
  const d = stream.dict;
  const W = d.lookup(N('Width'))?.asNumber(), H = d.lookup(N('Height'))?.asNumber();
  if (!W || !H || d.get(N('ImageMask')) || d.get(N('Decode'))) return null;
  const f = d.lookup(N('Filter'));
  const filters = f instanceof L.PDFArray ? f.asArray().map(x => x.asString?.() ?? String(x)) : f ? [String(f)] : [];
  if (filters.length === 1 && filters[0] === '/DCTDecode') {
    try { return await toCanvas(new Blob([stream.contents], { type: 'image/jpeg' })); } catch { return null; }
  }
  if (filters.some(x => x !== '/FlateDecode')) return null;
  if ((d.lookup(N('BitsPerComponent'))?.asNumber() ?? 8) !== 8) return null;
  const cs = d.lookup(N('ColorSpace'));
  let comps = cs === N('DeviceRGB') ? 3 : cs === N('DeviceGray') ? 1 : 0;
  if (cs instanceof L.PDFArray && cs.lookup(0) === N('ICCBased')) comps = cs.lookup(1)?.dict?.lookup(N('N'))?.asNumber() || 0;
  if (comps !== 1 && comps !== 3) return null;
  let raw;
  try { raw = L.decodePDFRawStream(stream).decode(); } catch { return null; }
  // PNG-style row filters (predictor 10+) put one extra byte at the start of each row
  const pred = d.lookup(N('DecodeParms'))?.lookup?.(N('Predictor'))?.asNumber?.() || 1;
  const rowLen = W * comps;
  if (pred >= 10) raw = unpredict(raw, rowLen, comps, H);
  else if (pred !== 1) return null;
  if (raw.length < rowLen * H) return null;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d'), img = ctx.createImageData(W, H), o = img.data;
  for (let i = 0, j = 0; i < W * H; i++, j += comps) {
    o[i * 4] = raw[j]; o[i * 4 + 1] = raw[comps === 3 ? j + 1 : j]; o[i * 4 + 2] = raw[comps === 3 ? j + 2 : j]; o[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return W * H > 1600 * 1600 ? await toCanvas(c) : c;
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function unpredict(data, rowLen, bpp, rows) {
  const out = new Uint8Array(rowLen * rows), prev = new Uint8Array(rowLen);
  let p = 0;
  for (let r = 0; r < rows && p < data.length; r++) {
    const type = data[p++], row = out.subarray(r * rowLen, (r + 1) * rowLen);
    for (let i = 0; i < rowLen; i++) {
      const x = data[p++], a = i >= bpp ? row[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      row[i] = (x + (type === 1 ? a : type === 2 ? b : type === 3 ? (a + b) >> 1 : type === 4 ? paeth(a, b, c) : 0)) & 255;
    }
    prev.set(row);
  }
  return out;
}

export async function openPdfImages() {
  if (!confirmBake()) return;
  const num = S.current || 1;
  busy('Finding pictures…');
  let doc, list;
  try {
    doc = await openLib(await buildPdf(S), S.password);
    const xo = doc.getPage(num - 1).node.Resources()?.lookup(N('XObject'));
    list = [];
    if (xo instanceof L.PDFDict) {
      for (const [name, ref] of xo.entries()) {
        const obj = doc.context.lookup(ref);
        if (!(obj instanceof L.PDFRawStream) || obj.dict.get(N('Subtype')) !== N('Image')) continue;
        const canvas = await decode(obj);
        list.push({ name, ref, obj, canvas });
      }
    }
  } catch (e) { busy(false); console.error(e); return toast('Could not read pictures: ' + (e.message || e), 4000); }
  busy(false);
  if (!list.length) return toast(`No pictures found on page ${num}. (Scanned pages are one big picture — try the next page, or use Edit text.)`, 5000);

  let changed = false;
  const show = () => {
    const body = openSheet(`<h2>Pictures on page ${num}</h2><p>Tap a picture.</p>
      <div class="org-grid" id="g">${list.map((it, i) => `<button class="org-card" data-i="${i}">${it.canvas ? '' : '<b>Can\'t preview</b>'}<span>${i + 1}</span></button>`).join('')}</div>
      <div class="actions"><button class="btn" id="x">Cancel</button><button class="btn primary" id="ok" ${changed ? '' : 'disabled'}>✔ Apply changes</button></div>`);
    body.classList.add('tall');
    list.forEach((it, i) => {
      if (!it.canvas) return;
      const img = new Image(); img.src = it.canvas.toDataURL('image/jpeg', 0.6);
      body.querySelector(`[data-i="${i}"]`).prepend(img);
    });
    $('#g', body).onclick = e => { const c = e.target.closest('[data-i]'); if (c) actions(list[+c.dataset.i]); };
    $('#x', body).onclick = closeSheet;
    $('#ok', body).onclick = async () => {
      closeSheet(); busy('Saving pictures…');
      try { const out = await doc.save(); busy(false); await loadBytes(out, S.name); S.dirty = true; toast('Pictures updated.'); }
      catch (e) { busy(false); toast('Could not save: ' + e.message, 4000); }
    };
  };

  const actions = it => {
    const body = openSheet(`<h2>Picture</h2>
      ${it.canvas ? '<button class="btn row" id="ed">✏️ Edit (crop, turn, colours)</button>' : '<p>This kind of picture can\'t be edited here, but you can replace or remove it.</p>'}
      <button class="btn row" id="rep">🔁 Replace with another photo</button>
      <button class="btn row danger" id="rm">🗑 Remove picture</button>
      <button class="btn row" id="back">◀ Back</button>`);
    $('#back', body).onclick = show;
    if (it.canvas) $('#ed', body).onclick = async () => {
      const r = await editImage(it.canvas, { note: 'If you crop or turn it, it is stretched to fill its old spot on the page.' });
      if (r) await swap(it, r, !r.changedShape && !r.flipped);
      show();
    };
    $('#rep', body).onclick = () => {
      const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
      inp.onchange = async () => {
        const f = inp.files[0]; if (!f) return show();
        const r = await editImage(f, { note: 'The new photo is stretched to fill the old one\'s spot. Crop it to the same shape for best results.' });
        if (r) await swap(it, r, false);
        show();
      };
      inp.click();
    };
    $('#rm', body).onclick = async () => {
      const c = document.createElement('canvas'); c.width = c.height = 1;
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1, 1);
      await swap(it, { canvas: c, dataUrl: c.toDataURL('image/png'), png: true }, false, true);
      show();
    };
  };

  /** Points the page's picture name at a new picture. */
  async function swap(it, r, keepMask, remove = false) {
    const bytes = dataUrlToBytes(r.dataUrl);
    const img = r.png ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    await img.embed();
    const mask = it.obj.dict.get(N('SMask'));
    if (keepMask && mask) doc.context.lookup(img.ref).dict.set(N('SMask'), mask);
    if (remove) {   // fully transparent picture = gone
      doc.context.lookup(img.ref).dict.set(N('SMask'), doc.context.register(doc.context.flateStream(new Uint8Array([0]),
        { Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1, ColorSpace: 'DeviceGray', BitsPerComponent: 8 })));
    }
    doc.getPage(num - 1).node.Resources().lookup(N('XObject')).set(it.name, img.ref);
    it.ref = img.ref; it.obj = doc.context.lookup(img.ref); it.canvas = remove ? null : r.canvas;
    changed = true;
  }

  show();
}
