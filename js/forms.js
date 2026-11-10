// Fill fillable PDF form fields (text boxes, checkboxes, dropdowns, radio buttons).
import { S, loadBytes } from './app.js';
import { openLib } from './export.js';
import { $, openSheet, closeSheet, esc, toast, busy } from './ui.js';

export async function openForms() {
  busy('Reading form…');
  let doc, fields;
  try {
    doc = await openLib(S.bytes, S.password);
    fields = doc.getForm().getFields();
  } catch (e) { busy(false); return toast('Could not read the form: ' + e.message, 4000); }
  busy(false);

  const L = PDFLib;
  const rows = [];
  fields.forEach((f, i) => {
    const name = f.getName();
    const label = esc(name.split('.').pop());
    try {
      if (f instanceof L.PDFTextField) {
        const v = f.getText() || '';
        rows.push(f.isMultiline()
          ? `<label>${label}</label><textarea data-i="${i}">${esc(v)}</textarea>`
          : `<label>${label}</label><input type="text" data-i="${i}" value="${esc(v)}">`);
      } else if (f instanceof L.PDFCheckBox) {
        rows.push(`<label class="check"><input type="checkbox" data-i="${i}" ${f.isChecked() ? 'checked' : ''}> ${label}</label>`);
      } else if (f instanceof L.PDFDropdown || f instanceof L.PDFOptionList || f instanceof L.PDFRadioGroup) {
        const cur = f instanceof L.PDFRadioGroup ? f.getSelected() : f.getSelected()[0];
        rows.push(`<label>${label}</label><select data-i="${i}"><option value="">—</option>` +
          f.getOptions().map(o => `<option ${o === cur ? 'selected' : ''}>${esc(o)}</option>`).join('') + '</select>');
      } else if (f instanceof L.PDFSignature) {
        rows.push(`<label>${label}</label><p>Signature box — use the ✍️ Sign tool on the page.</p>`);
      }
    } catch { /* skip odd fields */ }
  });

  if (!rows.length) {
    const b = openSheet(`<h2>Fill form</h2><p>This PDF has no fillable boxes. Use the 🔤 Text tool to type anywhere on the page, and ✍️ Sign to sign it.</p>
      <div class="actions"><button class="btn primary" id="ok">OK</button></div>`);
    $('#ok', b).onclick = closeSheet;
    return;
  }

  const body = openSheet(`<h2>Fill form (${rows.length} fields)</h2>${rows.join('')}
    <label class="check"><input type="checkbox" id="flat"> Lock answers (can't be changed later)</label>
    <div class="actions"><button class="btn" id="cancel">Cancel</button><button class="btn primary" id="ok">Apply</button></div>`);
  $('#cancel', body).onclick = closeSheet;
  $('#ok', body).onclick = async () => {
    body.querySelectorAll('[data-i]').forEach(inp => {
      const f = fields[+inp.dataset.i];
      try {
        if (f instanceof L.PDFTextField) f.setText(inp.value);
        else if (f instanceof L.PDFCheckBox) inp.checked ? f.check() : f.uncheck();
        else if (f instanceof L.PDFRadioGroup) { if (inp.value) f.select(inp.value); else f.clear(); }
        else if (inp.value) f.select(inp.value); else f.clear();
      } catch (e) { console.warn('field', f.getName(), e); }
    });
    const flatten = $('#flat', body).checked;
    closeSheet();
    busy('Filling form…');
    try {
      const form = doc.getForm();
      try { form.updateFieldAppearances(await doc.embedFont(L.StandardFonts.Helvetica)); } catch {}
      if (flatten) form.flatten();
      const bytes = await doc.save();
      S.dirty = true;
      await loadBytes(bytes, S.name, { keepAnnots: true });
      toast('Form filled. Save or Share to keep it.');
    } catch (e) { toast('Could not fill form: ' + e.message, 4000); }
    finally { busy(false); }
  };
}
