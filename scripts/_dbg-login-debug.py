import asyncio, os
from playwright.async_api import async_playwright

BASE = os.environ.get('AW_BASE', 'http://127.0.0.1:3000')

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={'width': 1500, 'height': 950})
        await page.goto(BASE + '/workshop', wait_until='domcontentloaded', timeout=120000)
        await page.wait_for_timeout(6000)
        await page.screenshot(path='.e2e-shots/login-debug.png', full_page=False)
        inputs = await page.locator('input').all()
        for i, inp in enumerate(inputs):
            try:
                ph = await inp.get_attribute('placeholder')
                vis = await inp.is_visible()
                print(f'input[{i}] placeholder={ph!r} visible={vis}')
            except Exception as e:
                print(f'input[{i}] err {e}')
        await browser.close()

asyncio.run(main())
