# PDF Editor

A private PDF app that runs in the browser on phones, desktops and laptops. Files never leave the device — no server, no uploads. Installable as an app (PWA) and works offline.

## Build 1 (done)
- Open and read PDFs (pages load as you scroll, to save memory on low-RAM phones), zoom, go to page
- Mark up: highlight, draw, comments (real PDF comments), text boxes
- Fill fillable forms (text, checkboxes, dropdowns, radio buttons), optional lock
- Draw a signature once, place it anywhere; move and resize
- Save to device and Share
- Mobile reading mode: big wrapping text, adjustable size
- Advanced edit: edit text (covers the old words, types new ones), add images, cover areas, create PDFs from blank pages or photos
- OCR: turns a scanned page into text you can copy, and makes it searchable when saved (works offline)

### Known limits
- "Edit text" covers old words with white and writes new text on top. The old words are still inside the file underneath — not a secure way to hide private info (real redaction is a later build).
- Added text uses Helvetica, so it may not match the PDF's original font. Non-Western characters show as "?".

## Build 2 (done)
- Export to Word (editable text, or exact-look pictures), Excel (tables guessed from word positions), PowerPoint (one slide per page, text in notes), JPG/PNG pictures (several pages → .zip)
- Combine PDFs and photos in any order (asks for passwords of locked files)
- Organize pages: move, turn, copy, delete, add blank pages, save picked pages as a new PDF
- Compress: Smart (shrinks photos, keeps text) or Strong/Smallest (pages become pictures)
- Password protect with AES-256, with print/copy/edit limits; open locked PDFs and save unlocked copies
- Tools that rebuild the file (organize, combine, compress) lock your marks onto the pages first

### Known limits
- Word "editable text" keeps paragraphs and headings, not exact layout or tables. Excel works best on simple tables.
- Smart compress only shrinks normal JPEG photos; other images are left alone.

## Build 3 (done)
- ✨ AI Assistant: ask questions about the open PDF, summarize, key facts, explain simply, write new content. Answers can be copied, added to the page, or saved as a PDF. Scanned pages are sent as pictures so the AI can read them.
  - Works with the user's own **Gemini** (free key) or **Claude** key, saved only on that device. The assistant is instructed to only help with the open document and to ignore instructions hidden inside it.
- Templates: letter, invoice (adds up totals and tax), resume, meeting notes, checklist, flyer, lined paper, grid paper; "Write this with AI" on long text boxes
- Page numbers, header, footer, watermark
- Page layout: paper size, margins, crop, 2 or 4 pages per sheet
- Picture editor (crop, turn, flip, brightness, contrast, colour, black & white) for added pictures, and for pictures already inside a PDF (edit, replace, remove)
- Desktop tabs: several PDFs open on wide screens; only the visible one stays loaded. Phones stay one-at-a-time.

### Known limits
- The AI key is stored in the browser on that device. The document text is sent to Google or Anthropic when you ask something.
- Editing pictures inside a PDF works on normal photos; some special image types can only be replaced or removed.

## Run locally
Any static web server: `python3 -m http.server` then open http://localhost:8000.

## Libraries (bundled in `vendor/`)
pdf.js (viewing), @cantoo/pdf-lib (saving, forms, passwords), Tesseract.js (OCR), docx, SheetJS, PptxGenJS, JSZip (exports). Export libraries load only when used.
