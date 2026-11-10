// Small shared UI helpers.
export const $ = (s, el = document) => el.querySelector(s);

let toastTimer;
export function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

export function busy(text) {
  $('#busy').hidden = !text;
  if (text) $('#busyText').textContent = text;
}

let onSheetClose = null;
/** Opens the bottom sheet with given HTML. Returns the sheet body element. */
export function openSheet(html, onClose) {
  const body = $('#sheetBody');
  body.innerHTML = html;
  $('#sheet').hidden = false;
  onSheetClose = onClose || null;
  return body;
}
export function closeSheet() {
  $('#sheet').hidden = true;
  $('#sheetBody').innerHTML = '';
  const cb = onSheetClose; onSheetClose = null;
  if (cb) cb();
}
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function swatchesHtml(colors, current, name) {
  return `<div class="swatches" data-name="${name}">` + colors.map(c =>
    `<button type="button" class="swatch${c === current ? ' on' : ''}" data-color="${c}" style="background:${c}"></button>`
  ).join('') + '</div>';
}
/** Wires swatch rows inside el; returns getter for chosen color by name. */
export function wireSwatches(el) {
  el.querySelectorAll('.swatches').forEach(row => {
    row.addEventListener('click', e => {
      const b = e.target.closest('.swatch'); if (!b) return;
      row.querySelectorAll('.swatch').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
    });
  });
  return name => el.querySelector(`.swatches[data-name="${name}"] .swatch.on`)?.dataset.color;
}

export function downloadBytes(bytes, name, type = 'application/pdf') {
  const url = URL.createObjectURL(bytes instanceof Blob ? bytes : new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function dataUrlToBytes(dataUrl) {
  const b64 = dataUrl.split(',')[1];
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Loads an image file, shrinks it (saves phone memory), returns {dataUrl,w,h}. */
export async function loadImageFile(file, maxSide = 1600, type = 'image/jpeg') {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url;
    });
    const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
    ctx.drawImage(img, 0, 0, w, h);
    const dataUrl = c.toDataURL(type, 0.85);
    c.width = 0;
    return { dataUrl, w, h };
  } finally { URL.revokeObjectURL(url); }
}

export const fmtSize = n => n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1) + ' MB';

const scripts = {};
/** Loads a library file only when it's first needed (keeps the app light on low-memory phones). */
export function loadScript(path) {
  return scripts[path] ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = new URL('../' + path, import.meta.url).href;
    s.onload = res; s.onerror = () => { delete scripts[path]; rej(new Error('Could not load ' + path + ' (check internet the first time)')); };
    document.head.appendChild(s);
  });
}

/** Shows a finished file with Save and Share buttons. */
export function deliver(data, name, type, note = '') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const body = openSheet(`<h2>File ready</h2><p><b>${esc(name)}</b><br>${fmtSize(blob.size)}</p>${note ? `<p>${note}</p>` : ''}
    <div class="actions"><button class="btn primary" id="dl">💾 Save</button><button class="btn" id="sh">📤 Share</button>
    <button class="btn" id="x">Close</button></div>`);
  $('#dl', body).onclick = () => { downloadBytes(blob, name); toast('Saved to Downloads.'); closeSheet(); };
  $('#x', body).onclick = closeSheet;
  $('#sh', body).onclick = async () => {
    const file = new File([blob], name, { type: blob.type || type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); closeSheet(); } catch (e) { if (e.name !== 'AbortError') toast('Share failed.'); }
    } else toast('Sharing this file type is not supported here. Use Save.', 3500);
  };
}
