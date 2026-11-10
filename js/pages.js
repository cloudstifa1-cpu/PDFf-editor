// Organize pages (move, turn, delete, copy, add blank, pull out) and combine files.
import { S, loadBytes, confirmBake, pdfjsLib } from './app.js';
import { buildPdf, openLib } from './export.js';
import { addImagePage } from './create.js';
import { $, openSheet, closeSheet, toast, busy, esc, downloadBytes, fmtSize } from './ui.js';

const { degrees } = PDFLib;

/* ---------------- Thumbnails (drawn only when visible, to save memory) ---------------- */

function thumbObserver(root) {
  const io = new IntersectionObserver(async entries => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const img = en.target; io.unobserve(img);
      try {
        const page = await S.pdf.getPage(+img.dataset.src + 1);
        const vp0 = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: 220 / Math.max(vp0.width, vp0.height) });
        const c = document.createElement('canvas');
        c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        img.src = c.toDataURL('image/jpeg', 0.6);
        c.width = 0; page.cleanup();
      } catch { /* sheet was closed */ }
    }
  }, { root, rootMargin: '300px' });
  return io;
}

/* ---------------- Organize ---------------- */

export function openOrganize() {
  if (!confirmBake()) return;
  // Each item: src = original page index (-1 = new blank page), rot = extra turn in degrees
  let items = S.pages.map((_, i) => ({ src: i, rot: 0, key: i }));
  let sel = new Set(), nextKey = items.length;

  const body = openSheet(`<h2>Organize pages</h2>
    <p>Tap pages to pick them, then use the buttons.</p>
    <div class="org-bar">
      <button class="btn" data-o="left">◀ Earlier</button><button class="btn" data-o="right">Later ▶</button>
      <button class="btn" data-o="rot">⟳ Turn</button><button class="btn" data-o="dup">⧉ Copy</button>
      <button class="btn" data-o="blank">➕ Blank</button><button class="btn danger" data-o="del">🗑 Delete</button>
      <button class="btn" data-o="all">☑ All / none</button><button class="btn" data-o="extract">⬇ Save picked as new PDF</button>
    </div>
    <div class="org-grid" id="grid"></div>
    <div class="actions"><button class="btn" id="cancel">Cancel</button><button class="btn primary" id="apply">✔ Apply changes</button></div>`);
  body.classList.add('tall');
  const grid = $('#grid', body);
  const io = thumbObserver(body);
  const thumbs = new Map();   // original page index -> image data, shared by copies

  function render() {
    grid.innerHTML = '';
    items.forEach((it, i) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'org-card' + (sel.has(it.key) ? ' on' : '');
      card.dataset.key = it.key;
      if (it.src < 0) card.innerHTML = `<div class="org-blank" style="transform:rotate(${it.rot}deg)">Blank</div>`;
      else {
        const img = document.createElement('img');
        img.dataset.src = it.src;
        img.style.transform = `rotate(${it.rot}deg)`;
        if (thumbs.get(it.src)) img.src = thumbs.get(it.src);
        else { io.observe(img); img.onload = () => thumbs.set(it.src, img.src); }
        card.appendChild(img);
      }
      card.insertAdjacentHTML('beforeend', `<span>${i + 1}</span>`);
      grid.appendChild(card);
    });
  }
  render();

  grid.addEventListener('click', e => {
    const c = e.target.closest('.org-card'); if (!c) return;
    const k = +c.dataset.key;
    sel.has(k) ? sel.delete(k) : sel.add(k);
    c.classList.toggle('on');
  });

  const picked = () => items.filter(it => sel.has(it.key));
  body.querySelector('.org-bar').addEventListener('click', async e => {
    const op = e.target.closest('[data-o]')?.dataset.o; if (!op) return;
    if (op === 'all') { sel = sel.size === items.length ? new Set() : new Set(items.map(i => i.key)); return render(); }
    if (op === 'blank') {
      // after the last picked page, or at the end
      const last = Math.max(-1, ...items.map((it, i) => sel.has(it.key) ? i : -1));
      items.splice(last < 0 ? items.length : last + 1, 0, { src: -1, rot: 0, key: nextKey++ });
      return render();
    }
    if (!sel.size) return toast('Tap one or more pages first.');
    if (op === 'left' || op === 'right') {
      const d = op === 'left' ? -1 : 1;
      const idx = items.map((it, i) => sel.has(it.key) ? i : -1).filter(i => i >= 0);
      if (d > 0) idx.reverse();
      for (const i of idx) {
        const j = i + d;
        if (j < 0 || j >= items.length || sel.has(items[j].key)) continue;
        [items[i], items[j]] = [items[j], items[i]];
      }
    } else if (op === 'rot') picked().forEach(it => (it.rot = (it.rot + 90) % 360));
    else if (op === 'dup') {
      const out = [];
      items.forEach(it => { out.push(it); if (sel.has(it.key)) out.push({ ...it, key: nextKey++ }); });
      items = out;
    } else if (op === 'del') {
      if (sel.size >= items.length) return toast('A PDF needs at least one page.');
      items = items.filter(it => !sel.has(it.key)); sel.clear();
    } else if (op === 'extract') {
      const bytes = await assemble(picked());
      if (bytes) { downloadBytes(bytes, S.name.replace(/\.pdf$/i, '') + '-pages.pdf'); toast(`Saved ${sel.size} page(s) as a new PDF.`); }
      return;
    }
    render();
  });

  $('#cancel', body).onclick = () => { io.disconnect(); closeSheet(); };
  $('#apply', body).onclick = async () => {
    io.disconnect();
    const bytes = await assemble(items);
    closeSheet();
    if (!bytes) return;
    await loadBytes(bytes, S.name);
    S.dirty = true;
    toast('Pages updated. Save or Share to keep it.');
  };
}

/** Builds a new PDF from a list of {src, rot} using the current file with marks locked in. */
async function assemble(list) {
  busy('Arranging pages…');
  try {
    const src = await openLib(await buildPdf(S), S.password);
    const doc = await PDFLib.PDFDocument.create();
    const used = [...new Set(list.filter(i => i.src >= 0).map(i => i.src))];
    const copied = new Map();
    if (used.length) (await doc.copyPages(src, used)).forEach((p, i) => copied.set(used[i], p));
    const firstSize = src.getPage(0).getSize();
    const seen = new Set();
    for (const it of list) {
      if (it.src < 0) {
        const p = doc.addPage([firstSize.width, firstSize.height]);
        if (it.rot) p.setRotation(degrees(it.rot));
        continue;
      }
      // A copied page object can be added only once; copy again for duplicates
      let p = copied.get(it.src);
      if (seen.has(it.src)) [p] = await doc.copyPages(src, [it.src]);
      seen.add(it.src);
      p.setRotation(degrees((p.getRotation().angle + it.rot) % 360));
      doc.addPage(p);
    }
    return await doc.save();
  } catch (e) {
    console.error(e); toast('Could not arrange pages: ' + (e.message || e), 4000); return null;
  } finally { busy(false); }
}

/* ---------------- Combine ---------------- */

export function openCombine() {
  // Each entry: {name, file} or the open document {name, current: true}
  const list = S.pdf ? [{ name: S.name + ' (open now)', current: true }] : [];

  const body = openSheet(`<h2>Combine files</h2>
    <p>Add PDFs or photos. They join in this order.</p>
    <div id="clist"></div>
    <button class="btn row" id="add">➕ Add PDFs or photos</button>
    <div class="actions"><button class="btn" id="cancel">Cancel</button><button class="btn primary" id="go">🧩 Combine</button></div>`);
  const box = $('#clist', body);

  function render() {
    box.innerHTML = list.length ? list.map((f, i) => `<div class="c-row">
      <span>${i + 1}. ${esc(f.name)}${f.file ? ` <small>(${fmtSize(f.file.size)})</small>` : ''}</span>
      <button class="btn icon" data-c="up" data-i="${i}">▲</button><button class="btn icon" data-c="down" data-i="${i}">▼</button>
      <button class="btn icon danger" data-c="rm" data-i="${i}">✖</button></div>`).join('') : '<p><b>No files yet.</b></p>';
  }
  render();

  box.addEventListener('click', e => {
    const b = e.target.closest('[data-c]'); if (!b) return;
    const i = +b.dataset.i, c = b.dataset.c;
    if (c === 'rm') list.splice(i, 1);
    else { const j = c === 'up' ? i - 1 : i + 1; if (j >= 0 && j < list.length) [list[i], list[j]] = [list[j], list[i]]; }
    render();
  });
  $('#add', body).onclick = () => {
    const inp = $('#fileMany'); inp.value = '';
    inp.onchange = () => { [...inp.files].forEach(f => list.push({ name: f.name, file: f })); render(); };
    inp.click();
  };
  $('#cancel', body).onclick = closeSheet;
  $('#go', body).onclick = async () => {
    if (list.length < 2) return toast('Add at least 2 files.');
    if (list.some(f => f.current) && !confirmBake()) return;
    closeSheet();
    const doc = await PDFLib.PDFDocument.create();
    try {
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        busy(`Adding ${i + 1} of ${list.length}: ${f.name}`);
        if (f.file && f.file.type.startsWith('image/')) { await addImagePage(doc, f.file); continue; }
        const bytes = f.current ? await buildPdf(S) : new Uint8Array(await f.file.arrayBuffer());
        const src = await openWithPrompt(bytes, f.current ? S.password : null, f.name);
        if (!src) continue;
        (await doc.copyPages(src, src.getPageIndices())).forEach(p => doc.addPage(p));
      }
      if (!doc.getPageCount()) return toast('Nothing to combine.');
      busy('Finishing…');
      const out = await doc.save();
      busy(false);
      await loadBytes(out, 'Combined.pdf');
      S.dirty = true;
      toast(`Combined ${list.length} files. Save or Share to keep it.`);
    } catch (e) {
      console.error(e); toast('Could not combine: ' + (e.message || e), 4500);
    } finally { busy(false); }
  };
}

/** Opens a PDF, asking for its password if it's locked. Returns null if skipped. */
async function openWithPrompt(bytes, password, name) {
  for (;;) {
    try { return await openLib(bytes, password); }
    catch (e) {
      if (!/encrypt|password/i.test(e.message || '')) throw new Error(name + ' is not a valid PDF');
      busy(false);
      password = prompt(`"${name}" is locked. Enter its password (or Cancel to skip it):`);
      if (password === null) return null;
    }
  }
}
