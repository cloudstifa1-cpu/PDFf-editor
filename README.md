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
- Password-locked PDFs open, but saving them comes in Build 2.

## Next
- **Build 2:** export to Word/Excel/PowerPoint/images, combine files, organize pages, compress, password protection
- **Build 3:** AI assistant (questions, summaries, writing), templates, layouts, image editing

## Run locally
Any static web server: `python3 -m http.server` then open http://localhost:8000.

## Libraries (bundled in `vendor/`)
pdf.js (viewing), pdf-lib (saving/forms), Tesseract.js (OCR, English).
