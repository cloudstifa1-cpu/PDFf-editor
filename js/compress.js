// Compress (make the file smaller) and password protection.
import { S, loadBytes, confirmBake, pdfjsLib } from './app.js';
import { buildPdf, openLib } from './export.js';
import { pageImage } from './convert.js';
import { $, openSheet, closeSheet, toast, busy, deliver, fmtSize, esc } from './ui.js';

const base = () => S.name.replace(/\.pdf$/i, '');
const tick = () => new Promise(r => setTimeout(r, 0));

/* ---------------- Compress ---------------- */

export function openCompress() {
  const body = openSheet(`<h2>Compress</h2><p>Now: <b>${fmtSize(S.bytes.length)}</b></p>
    <label class="radio"><input type="radio" name="m" value="smart" checked><span><b>Smart</b> — shrinks photos inside the PDF. Text stays sharp and copyable.</span></label>
    <label class="radio"><input type="radio" name="m" value="strong"><span><b>Strong</b> — every page becomes a picture. Much smaller for scans, but text can't be copied or searched.</span></label>
    <label class="radio"><input type="radio" name="m" value="tiny"><span><b>Smallest</b> — like Strong, lower quality. Good for email limits.</span></label>
    <div class="actions"><button class="btn" id="x">Cancel</button><button class="btn primary" id="go">🗜️ Compress</button></div>`);
  $('#x', body).onclick = closeSheet;
  $('#go', body).onclick = async () => {
    const mode = body.querySelector('input[name=m]:checked').value;
    closeSheet();
    if (!confirmBake()) return;
    const before = S.bytes.length;
    let out;
    try {
      out = mode === 'smart' ? await smart() : await raster(mode === 'tiny' ? 85 : 130, mode === 'tiny' ? 0.5 : 0.68);
    } catch (e) {
      console.error(e); busy(false);
      return toast('Compress failed: ' + (e.message || e), 4500);
    }
    busy(false);
    if (out.length >= before * 0.95) {
      return toast(mode === 'smart'
        ? 'Already about as small as Smart can make it. Try Strong if it has scanned pages.'
        : 'This file is already small — Strong would not help.', 5000);
    }
    await loadBytes(out, S.name);
    S.dirty = true;
    const pct = Math.round((1 - out.length / before) * 100);
    deliver(out, base() + '-small.pdf', 'application/pdf', `<b>${fmtSize(before)} → ${fmtSize(out.length)}</b> (${pct}% smaller). It's open now so you can check how it looks.`);
  };
}

/** Re-saves photos inside the PDF at a smaller size. Only touches normal JPEG photos. */
async function smart() {
  const { PDFName, PDFRawStream, PDFNumber, PDFArray } = PDFLib;
  busy('Getting file ready…');
  const doc = await openLib(await buildPdf(S), S.password);
  const N = n => PDFName.of(n);
  const imgs = doc.context.enumerateIndirectObjects().filter(([, o]) =>
    o instanceof PDFRawStream && o.dict.get(N('Subtype')) === N('Image') && o.contents.length > 40000);
  let i = 0;
  for (const [ref, obj] of imgs) {
    i++;
    busy(`Shrinking photo ${i} of ${imgs.length}…`);
    const d = obj.dict;
    const f = d.lookup(N('Filter'));
    const isJpeg = f === N('DCTDecode') || (f instanceof PDFArray && f.size() === 1 && f.lookup(0) === N('DCTDecode'));
    if (!isJpeg || d.get(N('Decode')) || d.get(N('ImageMask'))) continue;
    // Only plain colour or grey photos (CMYK and special colours could come out wrong)
    const cs = d.lookup(N('ColorSpace'));
    let comps = cs === N('DeviceRGB') ? 3 : cs === N('DeviceGray') ? 1 : 0;
    if (cs instanceof PDFArray && cs.lookup(0) === N('ICCBased')) {
      const n = cs.lookup(1)?.dict?.lookup(N('N'));
      comps = n ? n.asNumber() : 0;
    }
    if (comps !== 1 && comps !== 3) continue;
    const W = d.lookup(N('Width')).asNumber(), H = d.lookup(N('Height')).asNumber();
    const k = Math.min(1, 1700 / Math.max(W, H));
    const w = Math.max(1, Math.round(W * k)), h = Math.max(1, Math.round(H * k));
    let bmp;
    try { bmp = await createImageBitmap(new Blob([obj.contents], { type: 'image/jpeg' }), { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' }); }
    catch { continue; }   // browser couldn't read this photo; leave it alone
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0); bmp.close();
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.62));
    c.width = 0;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.length > obj.contents.length * 0.85) continue;   // not worth it
    d.set(N('Width'), PDFNumber.of(w)); d.set(N('Height'), PDFNumber.of(h));
    d.set(N('BitsPerComponent'), PDFNumber.of(8)); d.set(N('Filter'), N('DCTDecode'));
    d.delete(N('DecodeParms'));
    if (comps === 1) d.set(N('ColorSpace'), N('DeviceRGB'));
    d.set(N('Length'), PDFNumber.of(bytes.length));
    doc.context.assign(ref, PDFRawStream.of(d, bytes));
    await tick();
  }
  busy('Saving…');
  return await doc.save({ useObjectStreams: true });
}

/** Turns every page into a JPEG picture page. */
async function raster(dpi, quality) {
  busy('Getting file ready…');
  const src = S.annots.length || Object.keys(S.ocr).length
    ? await pdfjsLib.getDocument({ data: await buildPdf(S) }).promise : null;
  const pdf = src || S.pdf;
  try {
    const doc = await PDFLib.PDFDocument.create();
    for (let n = 1; n <= pdf.numPages; n++) {
      busy(`Compressing page ${n} of ${pdf.numPages}…`);
      const im = await pageImage(pdf, n, dpi, 'image/jpeg', quality);
      const img = await doc.embedJpg(new Uint8Array(await im.blob.arrayBuffer()));
      doc.addPage([im.ptW, im.ptH]).drawImage(img, { x: 0, y: 0, width: im.ptW, height: im.ptH });
      await tick();
    }
    busy('Saving…');
    return await doc.save();
  } finally { if (src) src.destroy(); }
}

/* ---------------- Password protection ---------------- */

export function openProtect() {
  const body = openSheet(`<h2>🔒 Password protect</h2>
    ${S.encrypted ? `<p><b>This PDF was locked.</b> You opened it with its password, so copies you save are unlocked.
      <button class="btn row" id="unlock">🔓 Save an unlocked copy</button></p><p>Or lock it with a new password:</p>` : ''}
    <label>Password</label><input type="text" id="p1" autocomplete="off" autocapitalize="off" spellcheck="false">
    <label>Type it again</label><input type="text" id="p2" autocomplete="off" autocapitalize="off" spellcheck="false">
    <div class="opt-group"><h3>People who open it can…</h3>
      <label class="check"><input type="checkbox" id="pp" checked> Print it</label>
      <label class="check"><input type="checkbox" id="pc" checked> Copy text</label>
      <label class="check"><input type="checkbox" id="pe"> Change it (edit, add pages)</label>
      <p>Some apps ignore these limits. The password itself is strong (AES-256).</p></div>
    <p><b>Write the password down.</b> If it's lost, the file can't be opened.</p>
    <div class="actions"><button class="btn" id="x">Cancel</button><button class="btn primary" id="go">🔒 Lock</button></div>`);
  $('#x', body).onclick = closeSheet;
  const unlock = $('#unlock', body);
  if (unlock) unlock.onclick = async () => {
    closeSheet(); busy('Unlocking…');
    try { const out = await buildPdf(S); busy(false); deliver(out, base() + '-unlocked.pdf', 'application/pdf'); }
    catch (e) { busy(false); toast('Could not unlock: ' + e.message, 4000); }
  };
  $('#go', body).onclick = async () => {
    const p1 = $('#p1', body).value, p2 = $('#p2', body).value;
    if (p1.length < 4) return toast('Use at least 4 characters.');
    if (p1 !== p2) return toast("The two passwords don't match.");
    const edit = $('#pe', body).checked;
    const permissions = {
      printing: $('#pp', body).checked ? 'highResolution' : false, copying: $('#pc', body).checked,
      modifying: edit, annotating: edit, fillingForms: true, contentAccessibility: true, documentAssembly: edit,
    };
    const limited = !permissions.printing || !permissions.copying || !edit;
    closeSheet(); busy('Locking…');
    try {
      const doc = await openLib(await buildPdf(S), S.password);
      // With limits, a separate secret owner password keeps them from being switched off
      const owner = limited ? crypto.getRandomValues(new Uint32Array(4)).join('-') : p1;
      doc.encrypt({ userPassword: p1, ownerPassword: owner, permissions });
      const out = await doc.save();
      busy(false);
      deliver(out, base() + '-locked.pdf', 'application/pdf', `Password: <b>${esc(p1)}</b>`);
    } catch (e) { busy(false); console.error(e); toast('Could not lock: ' + (e.message || e), 4500); }
  };
}
