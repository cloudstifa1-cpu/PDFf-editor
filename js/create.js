// Create a new PDF: blank pages, or from photos (camera or gallery).
import { S, loadBytes, isDesktop } from './app.js';
import { $, openSheet, closeSheet, toast, busy, loadImageFile, dataUrlToBytes } from './ui.js';

const SIZES = { letter: [612, 792], a4: [595.28, 841.89] };

export function openCreate() {
  const body = openSheet(`<h2>Create a PDF</h2>
    <button class="btn row" data-act="templates">📄 From a template (letter, invoice, resume…)</button>
    <button class="btn row" id="photos">📷 From photos or camera (scan paper)</button>
    <label>Or blank pages</label>
    <select id="size"><option value="letter">Letter (US)</option><option value="a4">A4</option></select>
    <label>How many pages</label><input type="text" id="count" inputmode="numeric" value="1">
    <div class="actions"><button class="btn" id="cancel">Cancel</button><button class="btn primary" id="blank">Make blank PDF</button></div>`);
  $('#cancel', body).onclick = closeSheet;
  $('#blank', body).onclick = async () => {
    const n = Math.max(1, Math.min(200, parseInt($('#count', body).value, 10) || 1));
    const size = SIZES[$('#size', body).value];
    closeSheet();
    if (!(await okToReplace())) return;
    const doc = await PDFLib.PDFDocument.create();
    for (let i = 0; i < n; i++) doc.addPage(size);
    await loadBytes(await doc.save(), 'New PDF.pdf', { newTab: true });
    S.dirty = true;
  };
  $('#photos', body).onclick = () => {
    closeSheet();
    const inp = $('#filePhotos');
    inp.value = '';
    inp.onchange = () => fromPhotos([...inp.files]);
    inp.click();
  };
}

async function okToReplace() {
  return !S.dirty || isDesktop() || confirm('You have unsaved changes. Replace them with a new PDF?');
}

async function fromPhotos(files) {
  if (!files.length) return;
  if (!(await okToReplace())) return;
  const doc = await PDFLib.PDFDocument.create();
  try {
    for (let i = 0; i < files.length; i++) {
      busy(`Adding photo ${i + 1} of ${files.length}…`);
      await addImagePage(doc, files[i]);
    }
    busy(false);
    await loadBytes(await doc.save(), 'Scan.pdf', { newTab: true });
    S.dirty = true;
    toast('PDF made. Use ⋮ → OCR to turn the photos into searchable text.', 4000);
  } catch (e) {
    busy(false); console.error(e);
    toast('Could not make PDF: ' + (e.message || e), 4000);
  }
}

/** Adds a photo as a new page, fitted to a Letter page turned to match the photo's shape. */
export async function addImagePage(doc, file) {
  const im = await loadImageFile(file, 2000, 'image/jpeg');   // shrink: saves memory and file size
  const img = await doc.embedJpg(dataUrlToBytes(im.dataUrl));
  const [W, H] = im.w > im.h ? [792, 612] : [612, 792];
  const k = Math.min(W / im.w, H / im.h);
  const page = doc.addPage([W, H]);
  page.drawImage(img, { x: (W - im.w * k) / 2, y: (H - im.h * k) / 2, width: im.w * k, height: im.h * k });
}
