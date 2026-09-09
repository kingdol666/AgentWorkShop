import asyncio, os
from playwright.async_api import async_playwright

BASE = os.environ.get('AW_BASE', 'http://127.0.0.1:3000')

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={'width': 1600, 'height': 1000})
        await page.goto(BASE + '/workshop', wait_until='domcontentloaded', timeout=120000)
        await page.wait_for_selector('input[placeholder="邮箱 / 用户名"]', timeout=90000)
        await page.wait_for_timeout(4000)
        await page.get_by_placeholder('邮箱 / 用户名').click(timeout=8000)
        await page.get_by_placeholder('邮箱 / 用户名').fill('admin', timeout=8000)
        await page.locator('input[type="password"]').first.click(timeout=8000)
        await page.locator('input[type="password"]').first.fill('admin123', timeout=8000)
        await page.get_by_role('button', name='登 录').click(timeout=8000)
        await page.wait_for_timeout(3500)
        await page.goto(BASE + '/town', wait_until='domcontentloaded', timeout=120000)
        await page.wait_for_timeout(45000)  # 等 three.js 场景构建与首帧渲染
        await page.screenshot(path='.e2e-shots/town-render.png', full_page=False)
        print('[town] screenshot saved')
        await browser.close()

asyncio.run(main())
