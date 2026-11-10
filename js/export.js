// Bakes the on-screen marks into a real PDF with pdf-lib.
import { dataUrlToBytes } from './ui.js';
import { pageAnnots } from './app.js';

const hex = h => {
  const n = parseInt(h.slice(1), 16);
  return PDFLib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

/** Removes characters the built-in Helvetica font cannot draw (it only knows Western letters). */
function safeText(font, str, cache) {
  let out = '';
  for (const ch of str) {
    if (!cache.has(ch)) { try { font.encodeText(ch); cache.set(ch, true); } catch { cache.set(ch, false); } }
    out += cache.get(ch) ? ch : (ch === '’' || ch === '‘' ? "'" : ch === '“' || ch === '”' ? '"' : '?');
  }
  return out;
}

/** Opens a PDF for editing; unlocks it with the password if it's locked. */
export async function openLib(bytes, password) {
  try { return await PDFLib.PDFDocument.load(bytes); }
  catch (e) {
    if (!/encrypt/i.test(e.message || '')) throw e;
    return await PDFLib.PDFDocument.load(bytes, { password: password || '' });
  }
}

export async function buildPdf(S) {
  const { PDFDocument, StandardFonts, BlendMode, LineCapStyle, PDFHexString, PDFString, degrees } = PDFLib;
  const doc = await openLib(S.bytes, S.password);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const cache = new Map();
  const images = new Map();

  for (const P of S.pages) {
    const pg = pages[P.num - 1];
    const toPdf = (x, y) => P.vp.convertToPdfPoint(x, y);
    // angle of the screen's "right" direction inside the PDF's own coordinates (handles rotated pages)
    const angleAt = (x, y) => {
      const [ax, ay] = toPdf(x, y), [bx, by] = toPdf(x + 10, y);
      return Math.round(Math.atan2(by - ay, bx - ax) * 180 / Math.PI);
    };

    // Invisible OCR text first, so it sits under everything (makes scans searchable/copyable)
    for (const wd of S.ocr[P.num] || []) {
      const txt = safeText(font, wd.text, cache).trim();
      if (!txt) continue;
      let size = wd.h * 0.9;
      const natural = font.widthOfTextAtSize(txt, size);
      if (natural > 0) size = Math.max(1, Math.min(size, size * wd.w / natural));
      const [px, py] = toPdf(wd.x, wd.y + wd.h * 0.8);
      pg.drawText(txt, { x: px, y: py, size, font, opacity: 0, rotate: degrees(angleAt(wd.x, wd.y)) });
    }

    for (const a of pageAnnots(P.num)) {
      if (a.type === 'highlight' || a.type === 'whiteout') {
        const [px, py] = toPdf(a.x, a.y + a.h);
        pg.drawRectangle({
          x: px, y: py, width: a.w, height: a.h, rotate: degrees(angleAt(a.x, a.y)),
          color: a.type === 'whiteout' ? PDFLib.rgb(1, 1, 1) : hex(a.color),
          ...(a.type === 'highlight' ? { opacity: 0.4, blendMode: BlendMode.Multiply } : {}),
        });
      } else if (a.type === 'pen') {
        const pts = a.pts.map(([x, y]) => toPdf(x, y));
        for (let i = 1; i < pts.length; i++) {
          pg.drawLine({ start: { x: pts[i - 1][0], y: pts[i - 1][1] }, end: { x: pts[i][0], y: pts[i][1] },
            thickness: a.width, color: hex(a.color), lineCap: LineCapStyle.Round });
        }
      } else if (a.type === 'text') {
        const rot = degrees(angleAt(a.x, a.y));
        a.text.split('\n').forEach((line, i) => {
          const t = safeText(font, line, cache);
          if (!t.trim()) return;
          const [px, py] = toPdf(a.x, a.y + a.size * 0.8 + i * a.size * 1.2);
          pg.drawText(t, { x: px, y: py, size: a.size, font, color: hex(a.color), rotate: rot });
        });
      } else if (a.type === 'image') {
        let img = images.get(a.src);
        if (!img) {
          const bytes = dataUrlToBytes(a.src);
          img = a.src.startsWith('data:image/png') ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
          images.set(a.src, img);
        }
        const [px, py] = toPdf(a.x, a.y + a.h);
        pg.drawImage(img, { x: px, y: py, width: a.w, height: a.h, rotate: degrees(angleAt(a.x, a.y)) });
      } else if (a.type === 'note') {
        // A real PDF comment (sticky note) that Acrobat, Chrome, etc. show as a comment icon
        const [px, py] = toPdf(a.x, a.y);
        const annot = doc.context.obj({
          Type: 'Annot', Subtype: 'Text', Rect: [px - 10, py - 10, px + 10, py + 10],
          Contents: PDFHexString.fromText(a.text), Name: 'Comment', C: [1, 0.83, 0], F: 4,
          M: PDFString.fromDate(new Date()),
        });
        pg.node.addAnnot(doc.context.register(annot));
      }
    }
  }
  return await doc.save();
}
