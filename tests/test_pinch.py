"""Pinch-to-zoom test. Run from the repo root:  python3 tests/test_pinch.py
Starts a local server, opens a sample PDF at phone size, and pinches with two simulated fingers."""
import asyncio, os, subprocess, sys, time
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8799
SAMPLE = os.path.join(ROOT, 'tests', 'fixtures', 'sample.pdf')

async def pinch(cdp, cx, cy, d_from, d_to, steps=8):
    pts = lambda d: [{'x': cx - d / 2, 'y': cy, 'id': 0}, {'x': cx + d / 2, 'y': cy, 'id': 1}]
    await cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': pts(d_from)})
    for i in range(1, steps + 1):
        await cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': pts(d_from + (d_to - d_from) * i / steps)})
    await cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})

async def main():
    srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT)], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    fails = []
    def check(name, ok, info=''):
        print(('PASS ' if ok else 'FAIL ') + name, info)
        if not ok: fails.append(name)
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch()
            ctx = await b.new_context(viewport={'width': 380, 'height': 800}, has_touch=True, is_mobile=True)
            pg = await ctx.new_page()
            errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)))
            await pg.goto(f'http://localhost:{PORT}/')
            await pg.set_input_files('#filePdf', SAMPLE)
            await pg.wait_for_selector('.page canvas')
            cdp = await ctx.new_cdp_session(pg)
            width = lambda: pg.evaluate('document.querySelector(".page").getBoundingClientRect().width')
            w0 = await width()

            await pinch(cdp, 190, 400, 100, 200); await pg.wait_for_timeout(400)
            w1 = await width()
            check('spread fingers doubles the page size', 1.8 < w1 / w0 < 2.2, f'{w0:.0f} -> {w1:.0f}')
            sl = await pg.evaluate('viewer.scrollLeft')
            check('zooms around the spot between the fingers (scrolled sideways)', sl > 50, f'scrollLeft={sl:.0f}')

            await pinch(cdp, 190, 400, 200, 100); await pg.wait_for_timeout(400)
            w2 = await width()
            check('pinch together shrinks back', 0.9 < w2 / w0 < 1.1, f'{w1:.0f} -> {w2:.0f}')

            await pinch(cdp, 190, 400, 100, 2000); await pg.wait_for_timeout(400)
            check('zoom stops at 400%', (await width()) / w0 < 4.1)
            await pinch(cdp, 190, 400, 2000, 10); await pg.wait_for_timeout(400)
            check('zoom stops at 50%', (await width()) / w0 > 0.45)

            await pg.click('.tool[data-tool=pen]')
            before = await pg.evaluate('document.querySelectorAll(".ann").length')
            await pinch(cdp, 190, 400, 100, 200); await pg.wait_for_timeout(400)
            after = await pg.evaluate('document.querySelectorAll(".ann").length')
            check('pinching with Draw on does not draw a line', before == after, f'{before} -> {after}')

            check('no page errors', not errs, str(errs))
            await b.close()
    finally:
        srv.terminate()
    print('ALL PASSED' if not fails else f'{len(fails)} FAILED')
    sys.exit(1 if fails else 0)

asyncio.run(main())
