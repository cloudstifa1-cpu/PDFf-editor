// PDF Editor — main viewer + annotation tools. Everything runs locally in the browser.
import * as pdfjsLib from '../vendor/pdf.min.mjs';
import { $, toast, busy, openSheet, closeSheet, esc, swatchesHtml, wireSwatches,
         downloadBytes, loadImageFile } from './ui.js';
import { buildPdf } from './export.js';
import { openForms } from './forms.js';
import { openReader } from './reader.js';
import { openOcr } from './ocr.js';
import { openCreate } from './create.js';
import { chooseSignature } from './signature.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
export { pdfjsLib };

const NS = 'http://www.w3.org/2000/svg';
const DPR = Math.min(window.devicePixelRatio || 1, 2);
const MAX_CANVAS_PIXELS = 4e6;          // keeps memory low on 2 GB phones
const MAX_PAGE_CSS_WIDTH = 900;         // readable width on desktop

/** App state. Annotation coords are PDF points, origin top-left of the displayed page. */
export const S = {
  pdf: null, bytes: null, name: '', encrypted: false,
  pages: [], annots: [], ocr: {}, zoom: 1, tool: 'hand',
  selected: null, undo: [], dirty: false, pending: null,
  style: JSON.parse(localStorage.getItem('style') || 'null') || {
    hl: '#ffeb3b', pen: '#e53935', penW: 2, text: '#000000', textSize: 14,
  },
};
const saveStyle = () => localStorage.setItem('style', JSON.stringify(S.style));
let nextId = 1;

const viewer = $('#viewer'), pagesEl = $('#pages');

/* ---------------- Opening & rendering ---------------- */

/* ---------------- Tabs (desktop only: several PDFs open; only the one you see stays loaded) ---------------- */

export const isDesktop = () => matchMedia('(min-width: 900px)').matches;
const tabs = [];   // saved state of each tab; the active tab's entry is null (its state lives in S)
let active = -1;
const snapshot = () => ({ bytes: S.bytes, name: S.name, password: S.password, annots: S.annots, ocr: S.ocr, undo: S.undo,
  dirty: S.dirty, zoom: S.zoom, chat: S.chat, scroll: viewer.scrollTop / Math.max(1, viewer.scrollHeight) });

function renderTabs() {
  const bar = $('#tabs');
  bar.hidden = tabs.length < 2;
  if (bar.hidden) return;
  bar.innerHTML = tabs.map((t, i) => {
    const on = i === active, name = on ? S.name : t.name, dirty = on ? S.dirty : t.dirty;
    return `<div class="tab${on ? ' on' : ''}" data-i="${i}" title="${esc(name)}"><span>${dirty ? '● ' : ''}${esc(name)}</span><button class="tab-x" data-x="${i}" title="Close">✖</button></div>`;
  }).join('') + '<button class="btn icon" id="tabNew" title="Open another PDF">+</button>';
}
async function switchTab(i) {
  if (i === active || !tabs[i]) return;
  tabs[active] = snapshot();
  const t = tabs[i];
  active = i;
  Object.assign(S, { annots: t.annots, ocr: t.ocr, undo: t.undo, zoom: t.zoom, chat: t.chat });
  await loadBytes(t.bytes, t.name, { keepAnnots: true, password: t.password });
  S.dirty = t.dirty; tabs[i] = null;
  updateUndo();
  viewer.scrollTop = t.scroll * viewer.scrollHeight;
}
async function closeTab(i) {
  const t = i === active ? { dirty: S.dirty, name: S.name } : tabs[i];
  if (t.dirty && !confirm(`"${t.name}" has unsaved changes. Close it anyway?`)) return;
  if (i === active) await switchTab(i > 0 ? i - 1 : 1);
  tabs.splice(i, 1);
  if (active > i) active--;
  renderTabs();
}
$('#tabs').addEventListener('click', e => {
  if (e.target.id === 'tabNew') return ACTIONS.open();
  const x = e.target.closest('[data-x]'); if (x) return closeTab(+x.dataset.x);
  const t = e.target.closest('[data-i]'); if (t) switchTab(+t.dataset.i);
});

/** Closes the PDF (or its tab) and goes back to the start screen. Returns true if fully closed. */
async function closeDoc() {
  if (!S.pdf) return true;
  if (tabs.length > 1) { await closeTab(active); return false; }
  if (S.dirty && !confirm('You have unsaved changes. Close without saving?')) return false;
  S.pages.forEach(unrender); await S.pdf.destroy();
  Object.assign(S, { pdf: null, bytes: null, name: '', pages: [], annots: [], ocr: {}, undo: [], dirty: false,
    chat: [], aiDoc: null, password: null, encrypted: false, selected: null });
  tabs.length = 0; active = -1;
  pagesEl.innerHTML = ''; $('#docName').textContent = 'No file open';
  $('#welcome').hidden = false; $('#tools').hidden = true; $('#pageInfo').hidden = true;
  setTool('hand'); updateUndo(); renderTabs();
  return true;
}

// Phone Back button: closes whatever is open first, then the PDF, instead of leaving the app
window.addEventListener('popstate', async () => {
  const keep = () => history.pushState({ doc: 1 }, '');
  if (!$('#sheet').hidden) { closeSheet(); return keep(); }
  if (!$('#menu').hidden) { $('#menu').hidden = true; return keep(); }
  if (!$('#reader').hidden) { $('#readerClose').click(); return keep(); }
  if (S.pdf && !(await closeDoc())) keep();
});

export async function loadBytes(bytes, name, { keepAnnots = false, newTab = false, password = null } = {}) {
  busy('Opening…');
  try {
    let encrypted = !!password, pw = password;
    const task = pdfjsLib.getDocument({ data: bytes.slice(0), ...(password ? { password } : {}) });
    task.onPassword = (cb, reason) => {
      encrypted = true;
      const p = prompt(reason === 2 ? 'Wrong password. Try again:' : 'This PDF is locked. Password:');
      if (p === null) task.destroy(); else { pw = p; cb(p); }
    };
    const pdf = await task.promise;
    if (newTab && S.pdf && isDesktop()) { tabs[active] = snapshot(); active = tabs.length; tabs.push(null); }
    if (active < 0) { active = 0; tabs.push(null); }
    if (S.pdf) { S.pages.forEach(unrender); await S.pdf.destroy(); }
    S.pdf = pdf;
    S.aiDoc = null;
    S.bytes = bytes; S.name = name; S.encrypted = encrypted; S.password = pw;
    if (!keepAnnots) { S.annots = []; S.ocr = {}; S.undo = []; S.dirty = false; S.chat = []; }
    S.selected = null;
    $('#docName').textContent = name;
    $('#welcome').hidden = true; $('#tools').hidden = false; $('#pageInfo').hidden = false;
    pagesEl.innerHTML = '';
    S.pages = [];
    for (let i = 1; i <= S.pdf.numPages; i++) {
      const page = await S.pdf.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const el = document.createElement('div');
      el.className = 'page'; el.dataset.num = i;
      el.innerHTML = `<div class="label">Page ${i}</div>`;
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'overlay');
      svg.setAttribute('viewBox', `0 0 ${vp.width} ${vp.height}`);
      svg.setAttribute('preserveAspectRatio', 'none');
      el.appendChild(svg);
      pagesEl.appendChild(el);
      const p = { num: i, page, vp, w: vp.width, h: vp.height, el, svg, canvas: null, rendered: false, task: null, text: null };
      S.pages.push(p);
      wireOverlay(p);
      drawAnnots(p);
    }
    layout();
    viewer.scrollTop = 0;
    updateUndo();
    renderTabs();
    if (!history.state?.doc) history.pushState({ doc: 1 }, '');
    if (encrypted) toast('Locked PDF opened. Saved copies will be unlocked — use 🔒 Password to lock again.', 4500);
  } catch (e) {
    console.error(e);
    toast(e?.name === 'InvalidPDFException' ? 'That file is not a valid PDF.' : 'Could not open: ' + (e.message || e), 4000);
  } finally { busy(false); }
}

function layout() {
  const avail = Math.min(viewer.clientWidth - 16, MAX_PAGE_CSS_WIDTH) * S.zoom;
  for (const p of S.pages) {
    p.el.style.width = avail + 'px';
    p.el.style.height = (avail * p.h / p.w) + 'px';
    unrender(p);
  }
  checkVisible();
}

function unrender(p) {
  if (p.task) { p.task.cancel(); p.task = null; }
  if (p.canvas) { p.canvas.width = 0; p.canvas.remove(); p.canvas = null; }
  if (p.rendered) { p.rendered = false; try { p.page.cleanup(); } catch {} }
}

async function renderPage(p) {
  if (p.rendered || p.task) return;
  const cssW = p.el.clientWidth;
  let scale = (cssW / p.w) * DPR;
  const px = p.w * p.h * scale * scale;
  if (px > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / px);
  const vp = p.page.getViewport({ scale });
  const c = document.createElement('canvas');
  c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  p.task = p.page.render({ canvasContext: c.getContext('2d'), viewport: vp });
  try {
    await p.task.promise;
    p.el.insertBefore(c, p.svg);
    p.canvas = c; p.rendered = true;
  } catch { c.width = 0; }
  finally { p.task = null; }
}

let visRaf = 0;
function checkVisible() {
  if (visRaf) return;
  visRaf = requestAnimationFrame(() => {
    visRaf = 0;
    const vh = viewer.clientHeight, top = viewer.getBoundingClientRect().top;
    let current = 1, best = -1;
    for (const p of S.pages) {
      const r = p.el.getBoundingClientRect();
      const rt = r.top - top, rb = r.bottom - top;
      if (rb > -vh && rt < vh * 2) renderPage(p);          // near the screen: draw
      else if (rb < -vh * 3 || rt > vh * 4) unrender(p);   // far away: free memory
      const visible = Math.min(rb, vh) - Math.max(rt, 0);
      if (visible > best) { best = visible; current = p.num; }
    }
    S.current = current;
    $('#pageNum').textContent = `${current} / ${S.pages.length}`;
  });
}
viewer.addEventListener('scroll', checkVisible, { passive: true });
let resizeT;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => S.pages.length && layout(), 250); });

function setZoom(z) {
  const frac = viewer.scrollTop / Math.max(1, viewer.scrollHeight);
  S.zoom = Math.max(0.5, Math.min(4, z));
  layout();
  viewer.scrollTop = frac * viewer.scrollHeight;
  toast(Math.round(S.zoom * 100) + '%', 900);
}
$('#zoomIn').onclick = () => setZoom(S.zoom * 1.25);
$('#zoomOut').onclick = () => setZoom(S.zoom / 1.25);
$('#pageNum').onclick = () => {
  const n = parseInt(prompt(`Go to page (1–${S.pages.length}):`), 10);
  if (n >= 1 && n <= S.pages.length) S.pages[n - 1].el.scrollIntoView();
};
// Ctrl + mouse wheel zoom on desktop
viewer.addEventListener('wheel', e => {
  if (!e.ctrlKey || !S.pages.length) return;
  e.preventDefault(); setZoom(S.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
}, { passive: false });

/* ---------------- Drawing annotations on screen ---------------- */

function el(tag, attrs) {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}

/** A page's marks, with white cover-ups first so new text and highlights sit on top of them. */
export const pageAnnots = n => {
  const list = S.annots.filter(a => a.page === n);
  return [...list.filter(a => a.type === 'whiteout'), ...list.filter(a => a.type !== 'whiteout')];
};

export function drawAnnots(p) {
  p.svg.replaceChildren();
  // OCR text is invisible in the saved file; show a faint marker so the user knows it exists
  for (const a of pageAnnots(p.num)) {
    let g;
    const common = { 'data-id': a.id, class: 'ann' + (S.selected === a.id ? ' selected' : '') };
    if (a.type === 'highlight') g = el('rect', { ...common, x: a.x, y: a.y, width: a.w, height: a.h, fill: a.color, 'fill-opacity': .4, style: 'mix-blend-mode:multiply' });
    else if (a.type === 'whiteout') g = el('rect', { ...common, x: a.x, y: a.y, width: a.w, height: a.h, fill: '#fff' });
    else if (a.type === 'pen') g = el('polyline', { ...common, points: a.pts.map(q => q.join(',')).join(' '), fill: 'none', stroke: a.color, 'stroke-width': a.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    else if (a.type === 'image') g = el('image', { ...common, href: a.src, x: a.x, y: a.y, width: a.w, height: a.h, preserveAspectRatio: 'none' });
    else if (a.type === 'note') {
      g = el('g', { ...common, class: common.class + ' ann-note' });
      g.appendChild(el('circle', { cx: a.x, cy: a.y, r: 10 }));
      const t = el('text', { x: a.x, y: a.y + 4.5, 'text-anchor': 'middle', 'font-size': 13, 'font-weight': 700, fill: '#000', 'font-family': 'Arial,sans-serif' });
      t.textContent = '✎'; g.appendChild(t);
    } else if (a.type === 'text') {
      g = el('text', { ...common, x: a.x, y: a.y + a.size * 0.8, 'font-size': a.size, fill: a.color, 'font-family': 'Helvetica,Arial,sans-serif' });
      a.text.split('\n').forEach((line, i) => {
        const ts = el('tspan', { x: a.x, dy: i ? a.size * 1.2 : 0 });
        ts.textContent = line || ' ';
        g.appendChild(ts);
      });
    }
    if (g) p.svg.appendChild(g);
  }
}
const redrawPage = n => drawAnnots(S.pages[n - 1]);

/* ---------------- Undo ---------------- */

function pushUndo() {
  S.undo.push(JSON.stringify(S.annots));
  if (S.undo.length > 30) S.undo.shift();
  S.dirty = true; updateUndo();
}
function updateUndo() { $('#btnUndo').disabled = !S.undo.length; if (tabs.length > 1) renderTabs(); }
$('#btnUndo').onclick = () => {
  if (!S.undo.length) return;
  S.annots = JSON.parse(S.undo.pop());
  S.selected = null;
  S.pages.forEach(drawAnnots); updateUndo();
};

export function addAnnots(list) {
  pushUndo();
  for (const a of list) { a.id = nextId++; S.annots.push(a); }
  new Set(list.map(a => a.page)).forEach(redrawPage);
}

/* ---------------- Tools ---------------- */

const DRAG_TOOLS = new Set(['select', 'highlight', 'pen', 'whiteout']);
const HINTS = {
  hand: 'Move: scroll and read.',
  select: 'Tap a mark to edit or delete it. Drag to move it.',
  highlight: 'Drag over text to highlight. Tap Highlight again for colors.',
  pen: 'Draw with your finger. Tap Draw again for color and size.',
  note: 'Tap the page to add a comment.',
  text: 'Tap where you want to type.',
  edittext: 'Tap a line of text to change it.',
  whiteout: 'Drag over an area to cover it with white.',
};

function setTool(tool) {
  S.tool = tool; S.pending = null;
  document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  document.body.classList.toggle('drawing', DRAG_TOOLS.has(tool));
  if (tool !== 'select' && S.selected) { const a = byId(S.selected); S.selected = null; if (a) redrawPage(a.page); }
  if (HINTS[tool]) toast(HINTS[tool]);
}

$('#tools').addEventListener('click', async e => {
  const b = e.target.closest('.tool'); if (!b) return;
  const tool = b.dataset.tool;
  if (tool === S.tool && ['highlight', 'pen', 'text'].includes(tool)) return styleSheet(tool);
  setTool(tool);
  if (tool === 'sign') {
    const sig = await chooseSignature();
    if (!sig) return setTool('hand');
    S.pending = sig; toast('Tap where to place your signature.');
  } else if (tool === 'image') {
    $('#fileImg').value = ''; $('#fileImg').click();
  }
});

$('#fileImg').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (S.tool !== 'image') return;
  if (!f) return setTool('hand');
  const { editImage } = await import('./imgedit.js');
  const r = await editImage(f, { note: 'Fix it up first if you like, then tap ✔.' });
  if (!r) return setTool('hand');
  S.pending = { dataUrl: r.dataUrl, w: r.w, h: r.h };
  toast('Tap where to place the image.');
});

function styleSheet(tool) {
  const st = S.style;
  const body = openSheet(tool === 'highlight'
    ? `<h2>Highlight color</h2>${swatchesHtml(['#ffeb3b', '#76ff03', '#40c4ff', '#ff80ab', '#ffab40'], st.hl, 'c')}
       <div class="actions"><button class="btn primary" id="ok">Done</button></div>`
    : tool === 'pen'
    ? `<h2>Pen</h2>${swatchesHtml(['#e53935', '#000000', '#1e88e5', '#43a047', '#ffd400'], st.pen, 'c')}
       <label>Thickness: <b id="wv">${st.penW}</b></label><input type="range" id="w" min="1" max="12" value="${st.penW}">
       <div class="actions"><button class="btn primary" id="ok">Done</button></div>`
    : `<h2>Text style</h2>${swatchesHtml(['#000000', '#1e88e5', '#e53935', '#43a047'], st.text, 'c')}
       <label>Size: <b id="wv">${st.textSize}</b></label><input type="range" id="w" min="6" max="48" value="${st.textSize}">
       <div class="actions"><button class="btn primary" id="ok">Done</button></div>`);
  const color = wireSwatches(body);
  const w = $('#w', body);
  if (w) w.oninput = () => ($('#wv', body).textContent = w.value);
  $('#ok', body).onclick = () => {
    if (tool === 'highlight') st.hl = color('c');
    if (tool === 'pen') { st.pen = color('c'); st.penW = +w.value; }
    if (tool === 'text') { st.text = color('c'); st.textSize = +w.value; }
    saveStyle(); closeSheet();
  };
}

const byId = id => S.annots.find(a => a.id === id);
function ptOf(e, p) {
  const r = p.svg.getBoundingClientRect();
  return [(e.clientX - r.left) / r.width * p.w, (e.clientY - r.top) / r.height * p.h];
}

function wireOverlay(p) {
  const svg = p.svg;
  let drag = null;

  svg.addEventListener('pointerdown', e => {
    if (!DRAG_TOOLS.has(S.tool)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const [x, y] = ptOf(e, p);
    svg.setPointerCapture(e.pointerId);
    if (S.tool === 'select') {
      const hit = e.target.closest('.ann');
      const prev = S.selected;
      S.selected = hit ? +hit.dataset.id : null;
      if (prev && prev !== S.selected) { const pa = byId(prev); if (pa) redrawPage(pa.page); }
      drawAnnots(p);
      if (hit) drag = { kind: 'move', x0: x, y0: y, orig: JSON.parse(JSON.stringify(byId(S.selected))), moved: false, snap: JSON.stringify(S.annots) };
      return;
    }
    if (S.tool === 'pen') {
      drag = { kind: 'pen', pts: [[x, y]], tmp: el('polyline', { fill: 'none', stroke: S.style.pen, 'stroke-width': S.style.penW, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }) };
    } else {
      drag = { kind: 'rect', x0: x, y0: y, tmp: el('rect', { fill: S.tool === 'whiteout' ? '#fff' : S.style.hl, 'fill-opacity': S.tool === 'whiteout' ? 1 : .4, stroke: '#00e5ff', 'stroke-width': 1 }) };
    }
    svg.appendChild(drag.tmp);
  });

  svg.addEventListener('pointermove', e => {
    if (!drag) return;
    const [x, y] = ptOf(e, p);
    if (drag.kind === 'pen') {
      const last = drag.pts[drag.pts.length - 1];
      if (Math.hypot(x - last[0], y - last[1]) < 0.8) return;
      drag.pts.push([+x.toFixed(1), +y.toFixed(1)]);
      drag.tmp.setAttribute('points', drag.pts.map(q => q.join(',')).join(' '));
    } else if (drag.kind === 'rect') {
      drag.tmp.setAttribute('x', Math.min(x, drag.x0)); drag.tmp.setAttribute('y', Math.min(y, drag.y0));
      drag.tmp.setAttribute('width', Math.abs(x - drag.x0)); drag.tmp.setAttribute('height', Math.abs(y - drag.y0));
    } else if (drag.kind === 'move') {
      const dx = x - drag.x0, dy = y - drag.y0;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      drag.moved = true;
      const a = byId(S.selected), o = drag.orig;
      if (a.type === 'pen') a.pts = o.pts.map(([px, py]) => [px + dx, py + dy]);
      else { a.x = o.x + dx; a.y = o.y + dy; }
      drawAnnots(p);
    }
  });

  const end = e => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.kind === 'pen') {
      d.tmp.remove();
      if (d.pts.length > 1) addAnnots([{ type: 'pen', page: p.num, pts: d.pts, color: S.style.pen, width: S.style.penW }]);
    } else if (d.kind === 'rect') {
      d.tmp.remove();
      const [x, y] = ptOf(e, p);
      const r = { x: Math.min(x, d.x0), y: Math.min(y, d.y0), w: Math.abs(x - d.x0), h: Math.abs(y - d.y0) };
      if (r.w > 2 && r.h > 2) addAnnots([{ type: S.tool === 'whiteout' ? 'whiteout' : 'highlight', page: p.num, ...r, color: S.style.hl }]);
    } else if (d.kind === 'move') {
      if (d.moved) { S.undo.push(d.snap); S.dirty = true; updateUndo(); }
      else if (e.type === 'pointerup') editSheet(byId(S.selected));
    }
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);

  // Tap tools use click so the page can still scroll with those tools on.
  svg.addEventListener('click', e => {
    const [x, y] = ptOf(e, p);
    if (S.tool === 'note') noteSheet({ page: p.num, x, y });
    else if (S.tool === 'text') textSheet({ page: p.num, x, y, size: S.style.textSize, color: S.style.text, text: '' });
    else if (S.tool === 'edittext') editTextAt(p, x, y);
    else if ((S.tool === 'sign' || S.tool === 'image') && S.pending) {
      const im = S.pending;
      const w = S.tool === 'sign' ? Math.min(160, p.w * 0.4) : Math.min(200, p.w * 0.5);
      const h = w * im.h / im.w;
      addAnnots([{ type: 'image', page: p.num, x: x - w / 2, y: y - h / 2, w, h, src: im.dataUrl }]);
      if (S.tool === 'image') { S.pending = null; setTool('select'); toast('Placed. Drag to move, tap to resize.'); }
      else toast('Signed. Use Select to move or resize it.');
    }
  });
}

/* ---------------- Sheets for creating / editing marks ---------------- */

function noteSheet(a, existing = false) {
  const body = openSheet(`<h2>${existing ? 'Edit comment' : 'Add comment'}</h2>
    <textarea id="t" placeholder="Type your comment">${esc(a.text || '')}</textarea>
    <div class="actions">${existing ? '<button class="btn danger" id="del">Delete</button>' : ''}
    <button class="btn" id="cancel">Cancel</button><button class="btn primary" id="ok">Save</button></div>`);
  const t = $('#t', body); setTimeout(() => t.focus(), 50);
  $('#cancel', body).onclick = closeSheet;
  if (existing) $('#del', body).onclick = () => { deleteAnnot(a); closeSheet(); };
  $('#ok', body).onclick = () => {
    const text = t.value.trim();
    if (!text) return closeSheet();
    if (existing) { pushUndo(); a.text = text; redrawPage(a.page); }
    else addAnnots([{ type: 'note', page: a.page, x: a.x, y: a.y, text }]);
    closeSheet();
  };
}

function textSheet(a, existing = false, extra = []) {
  const body = openSheet(`<h2>${existing ? 'Edit text' : 'Add text'}</h2>
    <textarea id="t">${esc(a.text)}</textarea>
    ${swatchesHtml(['#000000', '#1e88e5', '#e53935', '#43a047', '#ffffff'], a.color, 'c')}
    <label>Size: <b id="sv">${Math.round(a.size)}</b></label><input type="range" id="s" min="6" max="48" step="0.5" value="${a.size}">
    <div class="actions">${existing ? '<button class="btn danger" id="del">Delete</button>' : ''}
    <button class="btn" id="cancel">Cancel</button><button class="btn primary" id="ok">Save</button></div>`);
  const color = wireSwatches(body);
  const t = $('#t', body), s = $('#s', body);
  s.oninput = () => ($('#sv', body).textContent = Math.round(s.value));
  setTimeout(() => t.focus(), 50);
  $('#cancel', body).onclick = closeSheet;
  if (existing) $('#del', body).onclick = () => { deleteAnnot(a); closeSheet(); };
  $('#ok', body).onclick = () => {
    const text = t.value.replace(/\s+$/, '');
    const vals = { text, size: +s.value, color: color('c') || '#000000' };
    closeSheet();
    if (!text && !extra.length) return;
    if (existing) { pushUndo(); Object.assign(a, vals); redrawPage(a.page); }
    else addAnnots([...extra, ...(text ? [{ type: 'text', page: a.page, x: a.x, y: a.y, ...vals }] : [])]);
  };
}

function imageSheet(a) {
  const body = openSheet(`<h2>Image / signature</h2>
    <label>Size: <b id="sv">${Math.round(a.w)}</b></label>
    <input type="range" id="s" min="20" max="${Math.round(S.pages[a.page - 1].w)}" value="${Math.round(a.w)}">
    <button class="btn row" id="ed">✏️ Edit picture (crop, turn, colours)</button>
    <div class="actions"><button class="btn danger" id="del">Delete</button><button class="btn primary" id="ok">Done</button></div>`);
  $('#ed', body).onclick = async () => {
    const { editImage } = await import('./imgedit.js');
    const r = await editImage(a.src);
    if (!r) return;
    pushUndo(); a.src = r.dataUrl; a.h = a.w * r.h / r.w; redrawPage(a.page);
  };
  const s = $('#s', body), snap = JSON.stringify(S.annots), ratio = a.h / a.w;
  const cx = a.x + a.w / 2, cy = a.y + a.h / 2;
  s.oninput = () => {
    a.w = +s.value; a.h = a.w * ratio; a.x = cx - a.w / 2; a.y = cy - a.h / 2;
    $('#sv', body).textContent = s.value; redrawPage(a.page);
  };
  $('#del', body).onclick = () => { deleteAnnot(a); closeSheet(); };
  $('#ok', body).onclick = () => { if (JSON.stringify(S.annots) !== snap) { S.undo.push(snap); S.dirty = true; updateUndo(); } closeSheet(); };
}

function simpleSheet(a, label) {
  const body = openSheet(`<h2>${label}</h2><div class="actions">
    <button class="btn danger" id="del">Delete</button><button class="btn primary" id="ok">Keep</button></div>`);
  $('#del', body).onclick = () => { deleteAnnot(a); closeSheet(); };
  $('#ok', body).onclick = closeSheet;
}

function editSheet(a) {
  if (!a) return;
  if (a.type === 'note') noteSheet(a, true);
  else if (a.type === 'text') textSheet(a, true);
  else if (a.type === 'image') imageSheet(a);
  else simpleSheet(a, { highlight: 'Highlight', pen: 'Drawing', whiteout: 'Erased area' }[a.type]);
}

function deleteAnnot(a) {
  pushUndo();
  S.annots = S.annots.filter(x => x !== a);
  S.selected = null;
  redrawPage(a.page);
}

/* ---------------- Edit existing text (cover + retype) ---------------- */

async function editTextAt(p, x, y) {
  if (!p.text) p.text = await p.page.getTextContent();
  let hit = null;
  for (const it of p.text.items) {
    if (!it.str || !it.str.trim()) continue;
    const tx = pdfjsLib.Util.transform(p.vp.transform, it.transform);
    const fh = Math.hypot(tx[2], tx[3]);
    const bx = tx[4], base = tx[5], bw = it.width * p.vp.scale;
    if (x >= bx - 2 && x <= bx + bw + 2 && y >= base - fh - 2 && y <= base + fh * 0.3 + 2) {
      hit = { str: it.str, x: bx, base, fh, w: bw }; break;
    }
  }
  if (!hit) {
    toast(S.ocr[p.num] ? 'No text there. Try tapping right on a word.' : 'No text there. If this page is a scanned photo, run OCR first (⋮ menu).', 3500);
    return;
  }
  const cover = { type: 'whiteout', page: p.num, x: hit.x - 1, y: hit.base - hit.fh * 0.95, w: hit.w + 2, h: hit.fh * 1.25 };
  textSheet({ page: p.num, x: hit.x, y: hit.base - hit.fh * 0.8, size: +hit.fh.toFixed(1), color: '#000000', text: hit.str }, false, [cover]);
}

/* ---------------- Save / share / menu ---------------- */

const outName = () => S.name.replace(/\.pdf$/i, '') + (S.dirty ? '-edited' : '') + '.pdf';

async function getOutput() {
  if (!S.pdf) { toast('Open a PDF first.'); return null; }
  busy('Building PDF…');
  try { return await buildPdf(S); }
  catch (e) { console.error(e); toast('Save failed: ' + (e.message || e), 5000); return null; }
  finally { busy(false); }
}

async function save() {
  const bytes = await getOutput(); if (!bytes) return;
  downloadBytes(bytes, outName());
  S.dirty = false; toast('Saved to Downloads.');
}

async function share() {
  const bytes = await getOutput(); if (!bytes) return;
  const file = new File([bytes], outName(), { type: 'application/pdf' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: file.name }); }
    catch (e) { if (e.name !== 'AbortError') toast('Share failed — saved instead.'), downloadBytes(bytes, file.name); }
  } else { downloadBytes(bytes, file.name); toast('Sharing not supported here — saved to Downloads instead.', 3500); }
}

const need = () => S.pdf ? true : (toast('Open a PDF first.'), false);
async function lazy(file, fn) {
  try { (await import(file))[fn](); }
  catch (e) { console.error(e); toast('Could not start that tool: ' + (e.message || e), 4000); }
}

/** Locks marks onto the pages before tools that rebuild the file. Returns false if user cancels. */
export function confirmBake() {
  return !S.annots.length && !Object.keys(S.ocr).length ? true
    : confirm('Your marks will be locked onto the pages (they can no longer be moved or edited). Continue?');
}

const ACTIONS = {
  open: () => { $('#filePdf').value = ''; $('#filePdf').click(); },
  save, share,
  reader: () => S.pdf ? openReader() : toast('Open a PDF first.'),
  forms: () => S.pdf ? openForms() : toast('Open a PDF first.'),
  ocr: () => S.pdf ? openOcr(S.current || 1) : toast('Open a PDF first.'),
  create: () => openCreate(),
  organize: () => need() && lazy('./pages.js', 'openOrganize'),
  combine: () => lazy('./pages.js', 'openCombine'),
  convert: () => need() && lazy('./convert.js', 'openConvert'),
  compress: () => need() && lazy('./compress.js', 'openCompress'),
  protect: () => need() && lazy('./compress.js', 'openProtect'),
  ai: () => need() && lazy('./ai.js', 'openAI'),
  templates: () => lazy('./templates.js', 'openTemplates'),
  stamps: () => need() && lazy('./templates.js', 'openStamps'),
  layout: () => need() && lazy('./layout.js', 'openLayout'),
  pdfimages: () => need() && lazy('./pdfimages.js', 'openPdfImages'),
  close: () => {},
  closepdf: () => closeDoc(),
};
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  $('#menu').hidden = true;
  ACTIONS[b.dataset.act]?.();
});
$('#btnOpen').onclick = ACTIONS.open;
$('#btnMenu').onclick = () => ($('#menu').hidden = false);
$('#menu').addEventListener('click', e => { if (e.target.id === 'menu') $('#menu').hidden = true; });

$('#filePdf').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  if (!(isDesktop() && S.pdf) && S.dirty && !confirm('You have unsaved changes. Open a new file anyway?')) return;
  setTool('hand');
  await loadBytes(new Uint8Array(await f.arrayBuffer()), f.name, { newTab: true });
});

window.addEventListener('beforeunload', e => { if (S.dirty || tabs.some(t => t?.dirty)) { e.preventDefault(); e.returnValue = ''; } });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
