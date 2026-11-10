// Templates: make new PDFs from ready-made layouts, and stamp page numbers / header / footer / watermark.
import { S, loadBytes, confirmBake } from './app.js';
import { buildPdf, openLib, safeText } from './export.js';
import { $, openSheet, closeSheet, toast, busy, esc } from './ui.js';

const { rgb, degrees, StandardFonts } = PDFLib;
const INK = rgb(0, 0, 0), ACCENT = rgb(0.12, 0.3, 0.6), LIGHT = rgb(0.6, 0.6, 0.6);
const today = () => new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

/* ---------------- Text layout helper ---------------- */

/** Breaks text into lines that fit maxW. */
export function wrap(text, font, size, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    if (!para.trim()) { out.push(''); continue; }
    let line = '';
    for (const word of para.trim().split(/\s+/)) {
      const t = line ? line + ' ' + word : word;
      if (font.widthOfTextAtSize(t, size) <= maxW) { line = t; continue; }
      if (line) out.push(line);
      line = word;
      while (font.widthOfTextAtSize(line, size) > maxW && line.length > 1) {   // one very long word
        let k = line.length;
        while (k > 1 && font.widthOfTextAtSize(line.slice(0, k), size) > maxW) k--;
        out.push(line.slice(0, k)); line = line.slice(k);
      }
    }
    out.push(line);
  }
  return out;
}

/** Writes flowing text down the page and starts new pages when full. */
export class Writer {
  static async create(size = [612, 792], margin = 72) {
    const doc = await PDFLib.PDFDocument.create();
    const w = new Writer();
    w.doc = doc; w.size = size; w.m = margin;
    w.f = { reg: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold),
      ital: await doc.embedFont(StandardFonts.HelveticaOblique) };
    w.cache = new Map();
    w.newPage();
    return w;
  }
  get width() { return this.size[0] - this.m * 2; }
  newPage() { this.page = this.doc.addPage(this.size); this.y = this.size[1] - this.m; }
  need(h) { if (this.y - h < this.m) this.newPage(); }
  gap(h) { this.y -= h; }
  text(str, { font = 'reg', size = 11, color = INK, align = 'left', indent = 0, lead = 1.35, after = 6 } = {}) {
    const f = this.f[font];
    const lines = wrap(safeText(f, String(str ?? ''), this.cache), f, size, this.width - indent);
    for (const ln of lines) {
      this.need(size * lead);
      this.y -= size;
      const tw = f.widthOfTextAtSize(ln, size);
      const x = this.m + indent + (align === 'center' ? (this.width - indent - tw) / 2 : align === 'right' ? this.width - indent - tw : 0);
      if (ln) this.page.drawText(ln, { x, y: this.y, size, font: f, color });
      this.y -= size * (lead - 1);
    }
    this.y -= after;
  }
  rule(color = LIGHT, thick = 0.8) {
    this.need(8); this.y -= 4;
    this.page.drawLine({ start: { x: this.m, y: this.y }, end: { x: this.size[0] - this.m, y: this.y }, thickness: thick, color });
    this.y -= 8;
  }
  box(x, size = 10) {   // empty checkbox at current line
    this.page.drawRectangle({ x, y: this.y - size * 0.15, width: size, height: size, borderColor: INK, borderWidth: 1 });
  }
  save() { return this.doc.save(); }
}

/* ---------------- Templates ---------------- */

const T = [
  { id: 'letter', name: '✉️ Letter', fields: [
      { k: 'from', label: 'Your name', remember: true }, { k: 'addr', label: 'Your address / phone / email', type: 'area', remember: true },
      { k: 'date', label: 'Date', def: today }, { k: 'to', label: 'To (name and address)', type: 'area' },
      { k: 'hi', label: 'Greeting', def: () => 'Dear Sir or Madam,' },
      { k: 'body', label: 'Letter', type: 'area', big: true, ai: 'the body of a letter' }, { k: 'bye', label: 'Closing', def: () => 'Sincerely,' }],
    async draw(w, v) {
      w.text(v.from, { font: 'bold', size: 16, after: 2 });
      w.text(v.addr, { size: 10, color: rgb(0.25, 0.25, 0.25) }); w.rule(ACCENT, 1.5); w.gap(6);
      w.text(v.date, { after: 14 }); if (v.to) w.text(v.to, { after: 14 });
      w.text(v.hi, { after: 10 });
      for (const p of v.body.split(/\n\s*\n/)) w.text(p, { after: 10 });
      w.gap(6); w.text(v.bye, { after: 34 }); w.text(v.from);
    } },
  { id: 'invoice', name: '🧾 Invoice', fields: [
      { k: 'from', label: 'Your business name and address', type: 'area', remember: true }, { k: 'to', label: 'Bill to', type: 'area' },
      { k: 'num', label: 'Invoice number', def: () => String(Date.now()).slice(-5) }, { k: 'date', label: 'Date', def: today },
      { k: 'due', label: 'Due date' },
      { k: 'items', label: 'Items — one per line: description | quantity | price', type: 'area', big: true, def: () => 'Logo design | 1 | 250\nBusiness cards | 2 | 45.50' },
      { k: 'tax', label: 'Tax %', def: () => '0' }, { k: 'notes', label: 'Notes / how to pay', type: 'area', remember: true }],
    async draw(w, v) {
      const f = w.f, pg = () => w.page, R = w.size[0] - w.m;
      w.text('INVOICE', { font: 'bold', size: 26, color: ACCENT, after: 2 });
      w.text(`Invoice # ${v.num}    Date: ${v.date}${v.due ? `    Due: ${v.due}` : ''}`, { size: 10 }); w.gap(8);
      // From and Bill-to side by side
      const half = w.width / 2 - 10;
      const block = (title, text, x) => {
        let y = w.y;
        y -= 10; pg().drawText(title, { x, y, size: 10, font: f.bold }); y -= 4;
        for (const ln of wrap(safeText(f.reg, text), f.reg, 10, half)) { y -= 13; if (ln) pg().drawText(ln, { x, y, size: 10, font: f.reg }); }
        return y;
      };
      w.y = Math.min(block('From', v.from, w.m), block('Bill to', v.to, w.m + half + 20)) - 18;
      const cols = [w.m, R - 190, R - 120, R];   // description, qty, price, total(right edge)
      const row = (cells, bold = false) => {
        w.need(20); w.y -= 14;
        const font = bold ? f.bold : f.reg;
        const desc = wrap(safeText(font, cells[0]), font, 10, cols[1] - cols[0] - 10)[0] || '';
        pg().drawText(desc, { x: cols[0], y: w.y, size: 10, font });
        [cells[1], cells[2], cells[3]].forEach((t, i) => {
          const tw = font.widthOfTextAtSize(t, 10);
          pg().drawText(t, { x: (i === 0 ? cols[2] - 20 : i === 1 ? cols[3] - 70 : cols[3]) - tw, y: w.y, size: 10, font });
        });
        w.y -= 6;
      };
      pg().drawRectangle({ x: w.m - 4, y: w.y - 22, width: R - w.m + 8, height: 22, color: rgb(0.9, 0.93, 0.98) });
      row(['Description', 'Qty', 'Price', 'Total'], true);
      const money = n => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      let sub = 0;
      for (const line of v.items.split('\n').filter(l => l.trim())) {
        const [d, q = '1', p = '0'] = line.split('|').map(s => s.trim());
        const qty = parseFloat(q) || 0, price = parseFloat(String(p).replace(/[$,]/g, '')) || 0;
        sub += qty * price;
        row([d, String(qty), money(price), money(qty * price)]);
      }
      w.rule();
      const tax = sub * (parseFloat(v.tax) || 0) / 100;
      row(['', '', 'Subtotal', money(sub)]);
      if (tax) row(['', '', `Tax ${v.tax}%`, money(tax)]);
      row(['', '', 'TOTAL', money(sub + tax)], true);
      w.gap(20); if (v.notes) { w.text('Notes', { font: 'bold', size: 10, after: 2 }); w.text(v.notes, { size: 10 }); }
    } },
  { id: 'resume', name: '📄 Resume', fields: [
      { k: 'name', label: 'Full name', remember: true }, { k: 'contact', label: 'Phone · email · city', remember: true },
      { k: 'sum', label: 'Summary', type: 'area', ai: 'a short professional resume summary' },
      { k: 'exp', label: 'Experience — first line of each job is the title; leave a blank line between jobs', type: 'area', big: true },
      { k: 'edu', label: 'Education', type: 'area' }, { k: 'skills', label: 'Skills', type: 'area' }],
    async draw(w, v) {
      w.text(v.name, { font: 'bold', size: 24, align: 'center', after: 2 });
      w.text(v.contact, { size: 10, align: 'center' }); w.rule(ACCENT, 1.5);
      const sec = (title, body, jobs = false) => {
        if (!body.trim()) return;
        w.gap(4); w.text(title.toUpperCase(), { font: 'bold', size: 11, color: ACCENT, after: 4 });
        if (!jobs) return w.text(body, { size: 10.5 });
        for (const block of body.split(/\n\s*\n/)) {
          const [first, ...rest] = block.trim().split('\n');
          w.text(first, { font: 'bold', size: 10.5, after: 2 });
          rest.forEach(l => w.text(l.replace(/^[-•*]\s*/, '• '), { size: 10.5, indent: 8, after: 2 }));
          w.gap(6);
        }
      };
      sec('Summary', v.sum); sec('Experience', v.exp, true); sec('Education', v.edu, true); sec('Skills', v.skills);
    } },
  { id: 'notes', name: '🗒️ Meeting notes', fields: [
      { k: 'title', label: 'Meeting', def: () => 'Team meeting' }, { k: 'date', label: 'Date', def: today },
      { k: 'who', label: 'Attendees' }, { k: 'agenda', label: 'Agenda (one per line)', type: 'area' },
      { k: 'notes', label: 'Notes', type: 'area', big: true }, { k: 'todo', label: 'Action items (one per line)', type: 'area' }],
    async draw(w, v) {
      w.text(v.title, { font: 'bold', size: 20, after: 2 }); w.text(`${v.date}${v.who ? '  ·  ' + v.who : ''}`, { size: 10 }); w.rule(ACCENT, 1.5);
      const list = (title, body, boxes) => {
        if (!body.trim()) return;
        w.text(title, { font: 'bold', size: 13, color: ACCENT, after: 4 });
        body.split('\n').filter(l => l.trim()).forEach(l => {
          w.need(16); if (boxes) w.box(w.m, 10);
          w.text(boxes ? l : '• ' + l, { indent: 16, after: 3 });
        });
        w.gap(8);
      };
      list('Agenda', v.agenda);
      if (v.notes.trim()) { w.text('Notes', { font: 'bold', size: 13, color: ACCENT, after: 4 }); w.text(v.notes, { after: 10 }); }
      list('Action items', v.todo, true);
    } },
  { id: 'check', name: '☑️ Checklist', fields: [
      { k: 'title', label: 'Title', def: () => 'To do' }, { k: 'items', label: 'Items (one per line)', type: 'area', big: true }],
    async draw(w, v) {
      w.text(v.title, { font: 'bold', size: 22, after: 4 }); w.rule(ACCENT, 1.5);
      v.items.split('\n').filter(l => l.trim()).forEach(l => { w.need(24); w.gap(6); w.box(w.m, 12); w.text(l, { size: 13, indent: 22, after: 4 }); });
    } },
  { id: 'flyer', name: '📣 Flyer', fields: [
      { k: 'head', label: 'Big headline', def: () => 'GRAND OPENING' }, { k: 'sub', label: 'Subheading' },
      { k: 'body', label: 'Details', type: 'area', ai: 'short, exciting flyer text (2-4 sentences)' },
      { k: 'when', label: 'When and where', type: 'area' }, { k: 'contact', label: 'Contact / website' }],
    async draw(w, v) {
      const [W, H] = w.size;
      w.page.drawRectangle({ x: 0, y: H - 200, width: W, height: 200, color: ACCENT });
      const f = w.f.bold, head = safeText(f, v.head);
      let size = 54; while (size > 20 && f.widthOfTextAtSize(head, size) > W - 80) size -= 2;
      w.page.drawText(head, { x: (W - f.widthOfTextAtSize(head, size)) / 2, y: H - 115, size, font: f, color: rgb(1, 1, 1) });
      w.y = H - 240;
      if (v.sub) w.text(v.sub, { font: 'bold', size: 20, align: 'center', after: 18 });
      if (v.body) w.text(v.body, { size: 15, align: 'center', after: 24 });
      if (v.when) w.text(v.when, { font: 'bold', size: 16, align: 'center', color: ACCENT, after: 24 });
      if (v.contact) w.text(v.contact, { size: 13, align: 'center' });
    } },
  { id: 'lined', name: '📝 Lined paper', fields: [{ k: 'n', label: 'How many pages', def: () => '1' }],
    async draw(w, v) { paper(w, +v.n || 1, (pg, W, H) => { for (let y = H - 90; y > 50; y -= 24) pg.drawLine({ start: { x: 50, y }, end: { x: W - 40, y }, thickness: 0.6, color: rgb(0.55, 0.7, 0.9) }); pg.drawLine({ start: { x: 80, y: 30 }, end: { x: 80, y: H - 30 }, thickness: 0.8, color: rgb(0.9, 0.5, 0.5) }); }); } },
  { id: 'grid', name: '▦ Grid paper', fields: [{ k: 'n', label: 'How many pages', def: () => '1' }, { k: 'sq', label: 'Square size (inches)', def: () => '0.25' }],
    async draw(w, v) {
      const s = Math.max(0.1, parseFloat(v.sq) || 0.25) * 72;
      paper(w, +v.n || 1, (pg, W, H) => {
        for (let x = 36; x <= W - 36; x += s) pg.drawLine({ start: { x, y: 36 }, end: { x, y: H - 36 }, thickness: 0.4, color: rgb(0.7, 0.8, 0.9) });
        for (let y = 36; y <= H - 36; y += s) pg.drawLine({ start: { x: 36, y }, end: { x: W - 36, y }, thickness: 0.4, color: rgb(0.7, 0.8, 0.9) });
      });
    } },
];
function paper(w, n, drawFn) {
  n = Math.max(1, Math.min(100, n));
  for (let i = 0; i < n; i++) { if (i) w.newPage(); drawFn(w.page, ...w.size); }
}

const remembered = k => { try { return localStorage.getItem('tpl.' + k) || ''; } catch { return ''; } };

export function openTemplates() {
  const body = openSheet(`<h2>Start from a template</h2>${T.map((t, i) => `<button class="btn row" data-t="${i}">${t.name}</button>`).join('')}
    <div class="actions"><button class="btn" id="x">Cancel</button></div>`);
  $('#x', body).onclick = closeSheet;
  body.addEventListener('click', e => { const b = e.target.closest('[data-t]'); if (b) fillTemplate(T[+b.dataset.t]); });
}

function fillTemplate(t) {
  const body = openSheet(`<h2>${t.name}</h2>${t.fields.map(f => {
    const v = esc(f.remember ? remembered(f.k) || (f.def?.() ?? '') : f.def?.() ?? '');
    return `<label>${esc(f.label)}</label>` + (f.type === 'area'
      ? `<textarea data-k="${f.k}" ${f.big ? 'style="min-height:180px"' : ''}>${v}</textarea>${f.ai ? `<button class="btn" data-ai="${f.k}">✨ Write this with AI</button>` : ''}`
      : `<input type="text" data-k="${f.k}" value="${v}">`);
  }).join('')}
    <label>Page size</label><select id="sz"><option value="letter">Letter (US)</option><option value="a4">A4</option></select>
    <div class="actions"><button class="btn" id="x">Cancel</button><button class="btn primary" id="go">📄 Make PDF</button></div>`);
  body.classList.add('tall');
  $('#x', body).onclick = closeSheet;
  body.addEventListener('click', async e => {
    const k = e.target.closest('[data-ai]')?.dataset.ai; if (!k) return;
    const f = t.fields.find(x => x.k === k);
    const about = prompt(`What should it say? (A few words is fine.)`);
    if (!about) return;
    const ctx = t.fields.filter(x => x.k !== k).map(x => `${x.label}: ${body.querySelector(`[data-k="${x.k}"]`).value}`).join('\n');
    busy('AI is writing…');
    try {
      const { aiWrite } = await import('./ai.js');
      body.querySelector(`[data-k="${k}"]`).value = await aiWrite(`Write ${f.ai} for a ${t.name.replace(/^\S+\s/, '')}. The user wants: ${about}\n\nOther details already filled in:\n${ctx}`);
    } catch (err) { toast(err.message, 6000); }
    finally { busy(false); }
  });
  $('#go', body).onclick = async () => {
    const v = {};
    body.querySelectorAll('[data-k]').forEach(i => (v[i.dataset.k] = i.value));
    t.fields.filter(f => f.remember).forEach(f => { try { localStorage.setItem('tpl.' + f.k, v[f.k]); } catch {} });
    const size = $('#sz', body).value === 'a4' ? [595.28, 841.89] : [612, 792];
    closeSheet(); busy('Making PDF…');
    try {
      const w = await Writer.create(size, t.id === 'flyer' ? 54 : 72);
      await t.draw(w, v);
      const bytes = await w.save();
      busy(false);
      await loadBytes(bytes, `${t.name.replace(/^\S+\s/, '')}.pdf`, { newTab: true });
      S.dirty = true;
      toast('Made! You can still mark it up, sign it, or Save it.');
    } catch (e) { busy(false); console.error(e); toast('Could not make PDF: ' + (e.message || e), 4500); }
  };
}

/** Makes a simple PDF from a block of text (used by the AI assistant). */
export async function textToPdf(title, text) {
  const w = await Writer.create();
  if (title) { w.text(title, { font: 'bold', size: 18, after: 4 }); w.rule(ACCENT, 1.2); }
  for (const line of text.split('\n')) {
    const bullet = /^\s*[-*•]\s+/.test(line), head = /^#+\s/.test(line);
    const clean = line.replace(/^#+\s*/, '').replace(/^\s*[-*•]\s+/, '• ').replace(/\*\*(.+?)\*\*/g, '$1');
    if (!clean.trim()) { w.gap(6); continue; }
    w.text(clean, { font: head ? 'bold' : 'reg', size: head ? 13 : 11, indent: bullet ? 10 : 0, after: 3 });
  }
  return w.save();
}

/* ---------------- Page numbers, header, footer, watermark ---------------- */

export function openStamps() {
  const body = openSheet(`<h2>Page numbers, header & watermark</h2>
    <label>Page numbers</label><select id="pn"><option value="">None</option><option value="bc" selected>Bottom middle</option><option value="br">Bottom right</option><option value="tr">Top right</option></select>
    <label>Number style</label><select id="pf"><option value="n">1</option><option value="p">Page 1</option><option value="pof" selected>Page 1 of ${S.pages.length}</option></select>
    <label>Header (top of each page)</label><input type="text" id="hd">
    <label>Footer (bottom left)</label><input type="text" id="ft">
    <label>Watermark (big see-through text)</label><input type="text" id="wm" placeholder="e.g. DRAFT or CONFIDENTIAL">
    <label class="check"><input type="checkbox" id="skip"> Skip the first page</label>
    <div class="actions"><button class="btn" id="x">Cancel</button><button class="btn primary" id="go">Apply</button></div>`);
  $('#x', body).onclick = closeSheet;
  $('#go', body).onclick = async () => {
    const o = { pn: $('#pn', body).value, pf: $('#pf', body).value, hd: $('#hd', body).value.trim(), ft: $('#ft', body).value.trim(),
      wm: $('#wm', body).value.trim(), skip: $('#skip', body).checked };
    if (!o.pn && !o.hd && !o.ft && !o.wm) return toast('Fill in at least one thing.');
    if (!confirmBake()) return;
    closeSheet(); busy('Adding to pages…');
    try {
      const doc = await openLib(await buildPdf(S), S.password);
      const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
      const pages = doc.getPages(), total = pages.length;
      pages.forEach((pg, i) => {
        if (o.skip && i === 0) return;
        const P = S.pages[i], vp = P.vp, W = P.w, H = P.h;
        // draw text at a spot measured on the page as you see it (works on turned pages too)
        const put = (t, x, y, size, f = font, opts = {}) => {
          t = safeText(f, t);
          const [px, py] = vp.convertToPdfPoint(x, y), [qx, qy] = vp.convertToPdfPoint(x + 10, y);
          const ang = Math.atan2(qy - py, qx - px) * 180 / Math.PI;
          pg.drawText(t, { x: px, y: py, size, font: f, color: rgb(0.2, 0.2, 0.2), rotate: degrees(ang + (opts.extra || 0)), ...opts.style });
        };
        const tw = (t, s, f = font) => f.widthOfTextAtSize(safeText(f, t), s);
        const m = 30;
        if (o.pn) {
          const n = i + 1, t = o.pf === 'n' ? `${n}` : o.pf === 'p' ? `Page ${n}` : `Page ${n} of ${total}`;
          const x = o.pn === 'bc' ? (W - tw(t, 10)) / 2 : W - m - tw(t, 10);
          put(t, x, o.pn === 'tr' ? m : H - m + 10, 10);
        }
        if (o.hd) put(o.hd, (W - tw(o.hd, 10)) / 2, m, 10);
        if (o.ft) put(o.ft, m, H - m + 10, 9);
        if (o.wm) {
          let size = Math.min(110, Math.hypot(W, H) * 0.75 / Math.max(1, tw(o.wm, 1, bold)));
          const len = tw(o.wm, size, bold), c = Math.SQRT1_2;
          const x = W / 2 - c * len / 2 + c * size * 0.35, y = H / 2 + c * len / 2 + c * size * 0.35;
          put(o.wm, x, y, size, bold, { extra: 45, style: { color: rgb(0.5, 0.5, 0.5), opacity: 0.2 } });
        }
      });
      const out = await doc.save();
      busy(false);
      await loadBytes(out, S.name); S.dirty = true;
      toast('Added. Save or Share to keep it.');
    } catch (e) { busy(false); console.error(e); toast('Could not add: ' + (e.message || e), 4500); }
  };
}
