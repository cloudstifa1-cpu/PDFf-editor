// Export a PDF to Word, Excel, PowerPoint or pictures. All done on the device.
import { S, pdfjsLib } from './app.js';
import { buildPdf } from './export.js';
import { paragraphs } from './reader.js';
import { $, openSheet, closeSheet, toast, busy, loadScript, deliver } from './ui.js';

const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip', jpg: 'image/jpeg', png: 'image/png',
};
const base = () => S.name.replace(/\.pdf$/i, '');
const tick = () => new Promise(r => setTimeout(r, 0));

export function openConvert() {
  const body = openSheet(`<h2>Export to…</h2>
    <button class="btn row" data-f="word">📝 Word (.docx)</button>
    <button class="btn row" data-f="excel">📊 Excel (.xlsx)</button>
    <button class="btn row" data-f="ppt">📽️ PowerPoint (.pptx)</button>
    <button class="btn row" data-f="img">🖼️ Pictures (JPG or PNG)</button>
    <div class="actions"><button class="btn" id="x">Cancel</button></div>`);
  $('#x', body).onclick = closeSheet;
  body.addEventListener('click', e => {
    const f = e.target.closest('[data-f]')?.dataset.f; if (!f) return;
    ({ word: wordSheet, excel: excelSheet, ppt: pptSheet, img: imgSheet })[f]();
  });
}

/* ---------------- Shared helpers ---------------- */

/** A pdf.js copy of the document with marks drawn in (only made when there are marks). */
async function sourceDoc() {
  if (!S.annots.length) return { doc: S.pdf, done: () => {} };
  const doc = await pdfjsLib.getDocument({ data: await buildPdf(S) }).promise;
  return { doc, done: () => doc.destroy() };
}

/** Draws one page to a picture. dpi = sharpness. Returns {blob, w, h} (w,h in pixels). */
export async function pageImage(doc, n, dpi, type = 'image/jpeg', quality = 0.82) {
  const page = await doc.getPage(n);
  let scale = dpi / 72;
  const v1 = page.getViewport({ scale: 1 });
  const maxPx = 8e6;                                       // memory guard for low-RAM phones
  if (v1.width * v1.height * scale * scale > maxPx) scale = Math.sqrt(maxPx / (v1.width * v1.height));
  const vp = page.getViewport({ scale });
  const c = document.createElement('canvas');
  c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const blob = await new Promise(r => c.toBlob(r, type, quality));
  const out = { blob, w: c.width, h: c.height, ptW: v1.width, ptH: v1.height };
  c.width = 0; page.cleanup();
  return out;
}
const blobBytes = async b => new Uint8Array(await b.arrayBuffer());
const blobB64 = b => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });

async function pageText(n) {
  const P = S.pages[n - 1];
  return (P.text || await P.page.getTextContent()).items;
}

function optionsSheet(title, html, run) {
  const body = openSheet(`<h2>${title}</h2>${html}
    <div class="actions"><button class="btn" id="x">Cancel</button><button class="btn primary" id="go">Export</button></div>`);
  $('#x', body).onclick = closeSheet;
  $('#go', body).onclick = async () => {
    const opts = Object.fromEntries([...body.querySelectorAll('input:checked, select')].map(i => [i.name, i.value]));
    closeSheet();
    try { await run(opts); }
    catch (e) { console.error(e); toast('Export failed: ' + (e.message || e), 5000); }
    finally { busy(false); }
  };
}
const radio = (name, items) => items.map(([v, label], i) =>
  `<label class="radio"><input type="radio" name="${name}" value="${v}" ${i ? '' : 'checked'}> ${label}</label>`).join('');
const pagesPick = () => `<div class="opt-group"><h3>Which pages</h3>${radio('pages', [['all', `All ${S.pages.length} pages`], ['this', `Only page ${S.current || 1}`]])}</div>`;
const pageList = o => o.pages === 'this' ? [S.current || 1] : S.pages.map(p => p.num);

/* ---------------- Word ---------------- */

function wordSheet() {
  optionsSheet('Export to Word', `<div class="opt-group"><h3>Style</h3>${radio('mode', [
    ['text', '<span><b>Editable text</b> — you can change the words. Layout is simplified.</span>'],
    ['exact', '<span><b>Exact look</b> — pages look the same, but are pictures (not editable).</span>']])}</div>${pagesPick()}`,
  async o => {
    busy('Loading Word tools…');
    await loadScript('vendor/office/docx.js');
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun, PageBreak } = docx;
    const list = pageList(o);
    const sections = [];
    const src = await sourceDoc();
    try {
      if (o.mode === 'exact') {
        for (const n of list) {
          busy(`Making Word page ${n} of ${list.length}…`);
          const im = await pageImage(src.doc, n, 150);
          sections.push({
            properties: { page: { size: { width: Math.round(im.ptW * 20), height: Math.round(im.ptH * 20) }, margin: { top: 0, right: 0, bottom: 0, left: 0 } } },
            children: [new Paragraph({ children: [new ImageRun({ type: 'jpg', data: await blobBytes(im.blob), transformation: { width: Math.floor(im.ptW * 96 / 72) - 1, height: Math.floor(im.ptH * 96 / 72) - 2 } })] })],
          });
          await tick();
        }
      } else {
        const children = [];
        for (const [i, n] of list.entries()) {
          busy(`Reading page ${n}…`);
          if (i) children.push(new Paragraph({ children: [new PageBreak()] }));
          let paras = paragraphs(await pageText(n));
          if (!paras.length && S.ocr[n]) paras = [{ text: S.ocr[n].map(w => w.text).join(' '), size: 11 }];
          if (!paras.length) {   // scanned page with no text: keep it as a picture
            const im = await pageImage(src.doc, n, 130);
            const w = 624, h = Math.round(w * im.h / im.w);
            children.push(new Paragraph({ children: [new ImageRun({ type: 'jpg', data: await blobBytes(im.blob), transformation: { width: w, height: Math.min(h, 860) } })] }));
            continue;
          }
          const sizes = paras.map(p => p.size).sort((a, b) => a - b);
          const body = sizes[Math.floor(sizes.length / 2)] || 11;
          for (const p of paras) {
            const r = p.size / body;
            children.push(r >= 1.7 ? new Paragraph({ text: p.text, heading: HeadingLevel.HEADING_1 })
              : r >= 1.3 ? new Paragraph({ text: p.text, heading: HeadingLevel.HEADING_2 })
              : new Paragraph({ children: [new TextRun({ text: p.text, size: 22 })], spacing: { after: 160 } }));
          }
          await tick();
        }
        sections.push({ children });
      }
    } finally { src.done(); }
    busy('Saving Word file…');
    const blob = await Packer.toBlob(new Document({ creator: 'PDF Editor', sections }));
    busy(false);
    deliver(blob, base() + '.docx', MIME.docx);
  });
}

/* ---------------- Excel ---------------- */

const NUM = /^\(?-?\$?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?\)?$/;
function toCell(t) {
  if (!NUM.test(t)) return t;
  const neg = t.startsWith('(') || t.startsWith('-');
  const v = parseFloat(t.replace(/[(),$-]/g, ''));
  return isNaN(v) ? t : neg ? -v : v;
}

/** Guesses table rows and columns from where the words sit on the page. */
export function tableFromText(items) {
  const cells = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4], y = it.transform[5], h = Math.hypot(it.transform[2], it.transform[3]) || 10;
    const cw = it.width / Math.max(1, it.str.length);
    for (const m of it.str.matchAll(/\S+(?: \S+)*/g))     // 2+ spaces inside a piece = separate cells
      cells.push({ x: x + m.index * cw, y, h, w: m[0].length * cw, t: m[0] });
  }
  cells.sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const c of cells) {
    const r = rows[rows.length - 1];
    if (r && Math.abs(r.y - c.y) < Math.max(r.h, c.h) * 0.5) r.cells.push(c);
    else rows.push({ y: c.y, h: c.h, cells: [c] });
  }
  // join words that belong to the same cell
  for (const r of rows) {
    r.cells.sort((a, b) => a.x - b.x);
    const merged = [];
    for (const c of r.cells) {
      const p = merged[merged.length - 1];
      const gap = p ? c.x - (p.x + p.w) : Infinity;
      if (p && gap < p.h * 0.9) { p.t += (gap > p.h * 0.12 ? ' ' : '') + c.t; p.w = c.x + c.w - p.x; }
      else merged.push({ ...c });
    }
    r.cells = merged;
  }
  // column starts shared across the page
  const xs = rows.flatMap(r => r.cells.map(c => c.x)).sort((a, b) => a - b);
  const anchors = [];
  for (const x of xs) if (!anchors.length || x - anchors[anchors.length - 1] > 14) anchors.push(x);
  const col = x => { let best = 0; anchors.forEach((a, i) => { if (a <= x + 14) best = i; }); return best; };
  return rows.map(r => {
    const out = [];
    for (const c of r.cells) {
      const i = col(c.x);
      out[i] = out[i] === undefined ? c.t : out[i] + ' ' + c.t;
    }
    return Array.from(out, v => v === undefined ? '' : toCell(v));
  });
}

function excelSheet() {
  optionsSheet('Export to Excel', `<p>Works best on PDFs with simple tables. Columns are guessed from where the words sit.</p>
    <div class="opt-group"><h3>Layout</h3>${radio('layout', [['each', 'One sheet tab per page'], ['one', 'Everything on one sheet']])}</div>${pagesPick()}`,
  async o => {
    busy('Loading Excel tools…');
    await loadScript('vendor/office/xlsx.js');
    const wb = XLSX.utils.book_new();
    const all = [];
    let found = 0;
    for (const n of pageList(o)) {
      busy(`Reading page ${n}…`);
      let rows = tableFromText(await pageText(n));
      if (!rows.length && S.ocr[n]) rows = tableFromText(S.ocr[n].map(w => ({ str: w.text, width: w.w, transform: [w.h, 0, 0, w.h, w.x, -w.y] })));
      found += rows.length;
      if (o.layout === 'one') { if (all.length && rows.length) all.push([]); all.push(...rows); }
      else addSheet(wb, rows.length ? rows : [['(no text on this page)']], 'Page ' + n);
      await tick();
    }
    if (o.layout === 'one') addSheet(wb, all.length ? all : [['(no text found)']], 'Sheet1');
    if (!found) toast('No text found — if these are scanned pages, run OCR first.', 4500);
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    busy(false);
    deliver(new Blob([out], { type: MIME.xlsx }), base() + '.xlsx', MIME.xlsx);
  });
}
function addSheet(wb, rows, name) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const widths = [];
  rows.forEach(r => r.forEach((v, i) => { widths[i] = Math.min(60, Math.max(widths[i] || 6, String(v).length + 2)); }));
  ws['!cols'] = Array.from(widths, w => ({ wch: w || 8 }));
  XLSX.utils.book_append_sheet(wb, ws, name);
}

/* ---------------- PowerPoint ---------------- */

function pptSheet() {
  optionsSheet('Export to PowerPoint', `<p>Each page becomes one slide (as a picture, so it looks exactly the same).</p>
    <label class="check"><input type="checkbox" name="notes" value="1" checked> Put each page's text in the slide notes</label>${pagesPick()}`,
  async o => {
    busy('Loading PowerPoint tools…');
    await loadScript('vendor/office/pptxgen.js');
    const pptx = new PptxGenJS();
    const list = pageList(o);
    const first = S.pages[list[0] - 1];
    const W = first.w / 72, H = first.h / 72;
    pptx.defineLayout({ name: 'PDF', width: W, height: H });
    pptx.layout = 'PDF';
    const src = await sourceDoc();
    try {
      for (const n of list) {
        busy(`Making slide ${n} of ${list.length}…`);
        const im = await pageImage(src.doc, n, 150);
        const k = Math.min(W / (im.ptW / 72), H / (im.ptH / 72));
        const w = im.ptW / 72 * k, h = im.ptH / 72 * k;
        const slide = pptx.addSlide();
        slide.addImage({ data: (await blobB64(im.blob)).replace(/^data:/, ''), x: (W - w) / 2, y: (H - h) / 2, w, h });
        if (o.notes) {
          const t = paragraphs(await pageText(n)).map(p => p.text).join('\n\n') || (S.ocr[n] || []).map(w => w.text).join(' ');
          if (t) slide.addNotes(t);
        }
        await tick();
      }
    } finally { src.done(); }
    busy('Saving PowerPoint file…');
    const blob = await pptx.write({ outputType: 'blob' });
    busy(false);
    deliver(blob, base() + '.pptx', MIME.pptx);
  });
}

/* ---------------- Pictures ---------------- */

function imgSheet() {
  optionsSheet('Export as pictures', `
    <div class="opt-group"><h3>Type</h3>${radio('type', [['jpg', 'JPG — smaller files, best for photos'], ['png', 'PNG — sharpest, bigger files']])}</div>
    <div class="opt-group"><h3>Sharpness</h3>${radio('dpi', [['150', 'Normal'], ['220', 'High'], ['96', 'Small (for messages)']])}</div>
    ${pagesPick()}<p>Several pages are saved together in one .zip file.</p>`,
  async o => {
    const list = pageList(o);
    const type = o.type === 'png' ? 'image/png' : 'image/jpeg';
    const src = await sourceDoc();
    try {
      if (list.length === 1) {
        busy('Making picture…');
        const im = await pageImage(src.doc, list[0], +o.dpi, type, 0.88);
        busy(false);
        return deliver(im.blob, `${base()}-page${list[0]}.${o.type}`, MIME[o.type]);
      }
      busy('Loading zip tools…');
      await loadScript('vendor/office/jszip.js');
      const zip = new JSZip();
      for (const n of list) {
        busy(`Making picture ${n} of ${list.length}…`);
        const im = await pageImage(src.doc, n, +o.dpi, type, 0.88);
        zip.file(`${base()}-page${String(n).padStart(3, '0')}.${o.type}`, im.blob);
        await tick();
      }
      busy('Packing zip…');
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      busy(false);
      deliver(blob, base() + '-pictures.zip', MIME.zip);
    } finally { src.done(); }
  });
}
