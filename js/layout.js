// Page layout: change paper size, add margins, crop edges, put 2 or 4 pages on one sheet.
import { S, loadBytes } from './app.js';
import { buildPdf, openLib } from './export.js';
import { $, openSheet, closeSheet, toast, busy } from './ui.js';

const { degrees } = PDFLib;
const SIZES = { letter: [612, 792], a4: [595.28, 841.89], legal: [612, 1008], tabloid: [792, 1224] };
const pctOpts = Array.from({ length: 16 }, (_, i) => `<option value="${i * 2}">${i * 2}%</option>`).join('');

export function openLayout() {
  const body = openSheet(`<h2>📐 Page layout</h2>
    <label class="radio"><input type="radio" name="m" value="size" checked><span><b>Paper size</b> — fit every page onto one size</span></label>
    <label class="radio"><input type="radio" name="m" value="margin"><span><b>Add margins</b> — shrink content to leave white space around it</span></label>
    <label class="radio"><input type="radio" name="m" value="crop"><span><b>Crop</b> — cut off the edges of pages</span></label>
    <label class="radio"><input type="radio" name="m" value="nup"><span><b>Pages per sheet</b> — print 2 or 4 pages on one sheet</span></label>
    <div class="opt-group" data-for="size nup"><h3>Paper</h3><select id="paper"><option value="letter">Letter (US)</option><option value="a4">A4</option><option value="legal">Legal</option><option value="tabloid">Tabloid</option></select></div>
    <div class="opt-group" data-for="margin"><h3>Margin</h3><select id="mg"><option value="18">¼ inch</option><option value="36" selected>½ inch</option><option value="54">¾ inch</option><option value="72">1 inch</option></select></div>
    <div class="opt-group" data-for="crop"><h3>Cut off (as you see the page)</h3>
      <label>Top</label><select id="ct">${pctOpts}</select><label>Bottom</label><select id="cb">${pctOpts}</select>
      <label>Left</label><select id="cl">${pctOpts}</select><label>Right</label><select id="cr">${pctOpts}</select>
      <label class="check"><input type="checkbox" id="conly"> Only page ${S.current || 1}</label></div>
    <div class="opt-group" data-for="nup"><h3>Pages per sheet</h3><select id="n"><option value="2">2</option><option value="4">4</option></select></div>
    <p>Comments and form boxes are locked onto the page first.</p>
    <div class="actions"><button class="btn" id="x">Cancel</button><button class="btn primary" id="go">Apply</button></div>`);
  const sync = () => {
    const m = body.querySelector('input[name=m]:checked').value;
    body.querySelectorAll('[data-for]').forEach(g => (g.hidden = !g.dataset.for.split(' ').includes(m)));
  };
  body.querySelectorAll('input[name=m]').forEach(r => (r.onchange = sync)); sync();
  $('#x', body).onclick = closeSheet;
  $('#go', body).onclick = async () => {
    const m = body.querySelector('input[name=m]:checked').value;
    const o = { paper: SIZES[$('#paper', body).value], mg: +$('#mg', body).value, n: +$('#n', body).value,
      t: +$('#ct', body).value / 100, b: +$('#cb', body).value / 100, l: +$('#cl', body).value / 100, r: +$('#cr', body).value / 100,
      only: $('#conly', body).checked };
    if (m === 'crop' && !(o.t + o.b + o.l + o.r)) return toast('Pick how much to cut off.');
    if ((S.annots.length || Object.keys(S.ocr).length) && !confirm('Your marks will be locked onto the pages. Continue?')) return;
    closeSheet(); busy('Changing layout…');
    try {
      const src = await openLib(await buildPdf(S), S.password);
      try { src.getForm().flatten(); } catch {}
      const out = m === 'crop' ? await crop(src, o) : await rebuild(src, m, o);
      busy(false);
      await loadBytes(out, S.name); S.dirty = true;
      toast('Layout changed. Save or Share to keep it.');
    } catch (e) { busy(false); console.error(e); toast('Could not change layout: ' + (e.message || e), 4500); }
  };
}

/** Page info as you see it on screen (turned pages have width and height swapped). */
function info(pg) {
  const rot = ((pg.getRotation().angle % 360) + 360) % 360;
  const box = pg.getCropBox();
  return { rot, box, W: rot % 180 ? box.height : box.width, H: rot % 180 ? box.width : box.height };
}

/** Draws an embedded page so it shows upright, with its seen-on-screen bottom-left at (x, y). */
function place(dst, emb, rot, x, y, s) {
  const w = emb.width * s, h = emb.height * s;
  const at = { 0: [x, y], 90: [x, y + w], 180: [x + w, y + h], 270: [x + h, y] }[rot];
  dst.drawPage(emb, { x: at[0], y: at[1], xScale: s, yScale: s, rotate: degrees(-rot) });
}

async function rebuild(src, mode, o) {
  const doc = await PDFLib.PDFDocument.create();
  const pages = src.getPages(), inf = pages.map(info);
  const embs = await doc.embedPages(pages, inf.map(i => ({ left: i.box.x, bottom: i.box.y, right: i.box.x + i.box.width, top: i.box.y + i.box.height })));
  if (mode === 'size' || mode === 'margin') {
    pages.forEach((_, i) => {
      const f = inf[i];
      const [pw, ph] = mode === 'size' ? (f.W > f.H ? [o.paper[1], o.paper[0]] : o.paper) : [f.W, f.H];
      const m = mode === 'margin' ? o.mg : 0;
      const s = Math.min((pw - m * 2) / f.W, (ph - m * 2) / f.H);
      const dst = doc.addPage([pw, ph]);
      place(dst, embs[i], f.rot, (pw - f.W * s) / 2, (ph - f.H * s) / 2, s);
    });
  } else {   // pages per sheet
    const [PW, PH] = o.n === 2 ? [o.paper[1], o.paper[0]] : o.paper;
    const cols = 2, rows = o.n === 2 ? 1 : 2, gap = 18;
    const cw = (PW - gap * (cols + 1)) / cols, ch = (PH - gap * (rows + 1)) / rows;
    for (let i = 0; i < pages.length; i += o.n) {
      const dst = doc.addPage([PW, PH]);
      for (let k = 0; k < o.n && i + k < pages.length; k++) {
        const f = inf[i + k], c = k % cols, r = Math.floor(k / cols);
        const s = Math.min(cw / f.W, ch / f.H);
        const cx = gap + c * (cw + gap), cy = PH - gap - (r + 1) * ch - r * gap;
        place(dst, embs[i + k], f.rot, cx + (cw - f.W * s) / 2, cy + (ch - f.H * s) / 2, s);
        dst.drawRectangle({ x: cx + (cw - f.W * s) / 2, y: cy + (ch - f.H * s) / 2, width: f.W * s, height: f.H * s, borderColor: PDFLib.rgb(0.75, 0.75, 0.75), borderWidth: 0.5 });
      }
    }
  }
  return doc.save();
}

async function crop(doc, o) {
  // which edge of the stored page is shown at the top/right/bottom/left for each turn
  const MAP = { 0: { t: 't', r: 'r', b: 'b', l: 'l' }, 90: { t: 'l', r: 't', b: 'r', l: 'b' },
    180: { t: 'b', r: 'l', b: 't', l: 'r' }, 270: { t: 'r', r: 'b', b: 'l', l: 't' } };
  doc.getPages().forEach((pg, i) => {
    if (o.only && i !== (S.current || 1) - 1) return;
    const { rot, box } = info(pg), e = { t: 0, r: 0, b: 0, l: 0 };
    for (const k of ['t', 'r', 'b', 'l']) e[MAP[rot][k]] = o[k];
    pg.setCropBox(box.x + e.l * box.width, box.y + e.b * box.height, box.width * (1 - e.l - e.r), box.height * (1 - e.t - e.b));
  });
  return doc.save();
}
