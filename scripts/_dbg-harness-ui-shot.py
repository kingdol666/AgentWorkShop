"""Harness 前端真实交互验证:登录 → 仪表盘执行引擎面板(绿/灰 + 官网跳转链接)截图
→ 设置页把 crush_command 改成无效值(交互传参给后端 API)→ 面板出现 crush 灰化+跳转
→ 恢复 → agents 页下拉状态点截图。输出 .e2e-shots/harness-*.png。
"""
import asyncio, os
from playwright.async_api import async_playwright

BASE = os.environ.get('AW_BASE', 'http://127.0.0.1:3100')
SHOT = '.e2e-shots'

async def main():
    os.makedirs(SHOT, exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={'width': 1500, 'height': 950})

        # ---- 登录 ----
        await page.goto(BASE + '/workshop', wait_until='domcontentloaded', timeout=120000)
        await page.reload(wait_until='domcontentloaded', timeout=120000)
        await page.wait_for_selector('input[placeholder="邮箱 / 用户名"]', timeout=90000)
        for attempt in range(4):
            await page.wait_for_timeout(3500 + attempt * 2500)  # 等 toast 消失 + 水合
            try:
                await page.get_by_placeholder('邮箱 / 用户名').click(timeout=5000)
                await page.get_by_placeholder('邮箱 / 用户名').fill('admin', timeout=8000)
                await page.locator('input[type="password"]').first.click(timeout=5000)
                await page.locator('input[type="password"]').first.fill('admin123', timeout=8000)
                async with page.expect_response(lambda r: '/api/users/login' in r.url, timeout=15000) as ri:
                    await page.get_by_role('button', name='登 录').click(timeout=8000)
                if (await ri.value).status == 200:
                    break
            except Exception as exc:
                print(f'[login] attempt {attempt} failed: {str(exc)[:120]}')
                await page.screenshot(path=f'{SHOT}/login-fail-{attempt}.png', full_page=False)
        await page.wait_for_timeout(2000)

        # ---- 1. 仪表盘执行引擎面板:全绿 + 数量 ----
        await page.goto(BASE + '/', wait_until='domcontentloaded', timeout=120000)
        await page.wait_for_selector('.harness-row .h-item', timeout=90000)
        await page.wait_for_timeout(2000)
        items = await page.locator('.harness-row .h-item').count()
        print(f'[dashboard] harness items = {items}')
        links = await page.locator('.harness-row .h-item.link').count()
        print(f'[dashboard] install-link items = {links}')
        await page.locator('.harness-row').scroll_into_view_if_needed()
        await page.screenshot(path=f'{SHOT}/harness-dashboard-green.png', full_page=False)

        # ---- 2. 交互传参:设置页把 crush_command 改无效 → 面板灰化 + 官网链接 ----
        await page.goto(BASE + '/settings', wait_until='domcontentloaded', timeout=120000)
        await page.wait_for_timeout(3000)
        # 找 crush 命令输入框(设置页按描述符 label 渲染)
        inp = page.locator('.ant-form-item:has-text("crush 命令") input').first
        if await inp.count() == 0:
            inp = page.locator('input').filter(has_text='').nth(0)  # 兜底(不应触达)
        await inp.fill('crush-definitely-not-installed')
        await page.wait_for_timeout(800)
        # 提交:找保存按钮(settings 页有保存动作;回车兜底)
        save = page.locator('button:has-text("保存")').first
        if await save.count() > 0:
            await save.click()
        else:
            await inp.press('Enter')
        await page.wait_for_timeout(6000)  # 等 SystemConfigService 传播 + 探测缓存过期

        await page.goto(BASE + '/?refresh=1', wait_until='domcontentloaded', timeout=120000)
        await page.wait_for_selector('.harness-row .h-item', timeout=90000)
        await page.wait_for_timeout(2500)
        off = page.locator('.harness-row .h-item.off')
        off_n = await off.count()
        print(f'[dashboard] off items after break-crush = {off_n}')
        link = page.locator('.harness-row .h-item.off a.h-item[href*="blockgoose"], .harness-row .h-item.off.link')
        link_n = await link.count()
        print(f'[dashboard] off+homepage-link = {link_n}')
        if off_n > 0:
            txt = (await off.first.inner_text()).replace('\n', ' ')
            print(f'[dashboard] off item text = {txt[:80]}')
        await page.locator('.harness-row').scroll_into_view_if_needed()
        await page.screenshot(path=f'{SHOT}/harness-dashboard-grey-link.png', full_page=False)

        # ---- 3. agents 页:下拉状态点 + 安装链接截图 ----
        await page.goto(BASE + '/workshop/agents', wait_until='domcontentloaded', timeout=120000)
        await page.wait_for_timeout(3500)
        # 打开 harness 下拉
        sel = page.locator('.ant-select').filter(has_text='omp').first
        if await sel.count() == 0:
            sel = page.locator('.ant-select').first
        await sel.click()
        await page.wait_for_timeout(1500)
        dots = await page.locator('.h-opt-dot').count()
        print(f'[agents] dropdown option dots = {dots}')
        await page.screenshot(path=f'{SHOT}/harness-agents-dropdown.png', full_page=False)
        await page.keyboard.press('Escape')

        # ---- 4. 恢复 crush_command ----
        await page.goto(BASE + '/settings', wait_until='domcontentloaded', timeout=120000)
        await page.wait_for_timeout(3000)
        inp2 = page.locator('.ant-form-item:has-text("crush 命令") input').first
        await inp2.fill('crush')
        save2 = page.locator('button:has-text("保存")').first
        if await save2.count() > 0:
            await save2.click()
        else:
            await inp2.press('Enter')
        await page.wait_for_timeout(4000)
        print('[restore] crush_command restored')

        await browser.close()

asyncio.run(main())
