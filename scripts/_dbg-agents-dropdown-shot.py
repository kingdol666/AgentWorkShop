import asyncio, os
from playwright.async_api import async_playwright

BASE = os.environ.get('AW_BASE', 'http://127.0.0.1:3000')
SHOT = '.e2e-shots'

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={'width': 1500, 'height': 950})
        await page.goto(BASE + '/workshop', wait_until='domcontentloaded', timeout=120000)
        await page.wait_for_selector('input[placeholder="邮箱 / 用户名"]', timeout=90000)
        await page.wait_for_timeout(4000)
        await page.get_by_placeholder('邮箱 / 用户名').click(timeout=8000)
        await page.get_by_placeholder('邮箱 / 用户名').fill('admin', timeout=8000)
        await page.locator('input[type="password"]').first.click(timeout=8000)
        await page.locator('input[type="password"]').first.fill('admin123', timeout=8000)
        await page.get_by_role('button', name='登 录').click(timeout=8000)
        await page.wait_for_timeout(3500)
        await page.goto(BASE + '/workshop/agents', wait_until='domcontentloaded', timeout=120000)
        await page.wait_for_timeout(4000)
        await page.get_by_role('button', name='新建模板').first.click(timeout=8000)
        await page.wait_for_timeout(2500)
        sel = page.locator('.ant-select').nth(1)  # 表单内第 2 个 select(第 1 个是可见性)
        await sel.scroll_into_view_if_needed()
        await sel.click()
        await page.wait_for_timeout(1800)
        dots = await page.locator('.h-opt-dot').count()
        print(f'[agents] dropdown option dots = {dots}')
        await page.screenshot(path=f'{SHOT}/harness-agents-dropdown.png', full_page=False)
        await browser.close()

asyncio.run(main())
