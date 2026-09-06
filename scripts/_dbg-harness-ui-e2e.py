"""Harness 可用性 UI E2E:用户名登录 → 仪表盘 Harness 面板(dsh=未安装灰化) → agents 模板选择禁用 → teams 页截图。
dsh 未安装态由外部脚本预置;恢复也由外部执行(本脚本不发起 HTTP)。
AW_BASE 环境变量切换目标实例(默认 :3021);EXPECT_OFF=1 时断言恰好 1 条灰化。"""
import asyncio, os, sys
from playwright.async_api import async_playwright

BASE = os.environ.get('AW_BASE', 'http://127.0.0.1:3021')
EXPECT_OFF = os.environ.get('EXPECT_OFF', '1') == '1'
SHOT = '.e2e-shots'

async def main():
    results = []
    def ok(cond, name, extra=''):
        results.append((cond, name))
        print(('  ✓ ' if cond else '  ✗ ') + name + (f' {extra}' if extra and not cond else ''), flush=True)

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={'width': 1440, 'height': 900})

        # ---- 1. 用户名登录(admin/admin123;水合时机在 dev 下有抖动 → 重试 3 轮)----
        await page.goto(BASE + '/workshop', wait_until='domcontentloaded', timeout=90000)
        await page.reload(wait_until='domcontentloaded', timeout=90000)
        await page.wait_for_selector('input[placeholder="邮箱 / 用户名"]', timeout=60000)
        login_status = None
        for attempt in range(3):
            await page.wait_for_timeout(2500 + attempt * 2000)  # 等 Vue 水合
            await page.fill('input[placeholder="邮箱 / 用户名"]', 'admin')
            await page.fill('.ant-input-password input', 'admin123')
            try:
                async with page.expect_response(lambda r: '/api/users/login' in r.url, timeout=15000) as ri:
                    await page.locator('.ant-input-password input').first.press('Enter')
                login_status = (await ri.value).status
            except Exception:
                login_status = None
            login_input = page.locator('input[placeholder="邮箱 / 用户名"]')
            gone = (await login_input.count()) == 0 or not await login_input.first.is_visible()
            if login_status == 200 and gone:
                break
        ok(login_status == 200, f'登录 POST 200(实际 {login_status})')
        login_input = page.locator('input[placeholder="邮箱 / 用户名"]')
        logged = (await login_input.count()) == 0 or not await login_input.first.is_visible()
        ok(logged, '用户名登录进入系统')

        # ---- 2. 仪表盘 Harness 面板(dsh 当前为未安装态)----
        await page.goto(BASE + '/', wait_until='domcontentloaded', timeout=90000)
        ok('/workshop' not in page.url, f'仪表盘未跳登录门(url={page.url})')
        await page.wait_for_selector('.harness-row .h-item', timeout=90000)
        await page.wait_for_timeout(1500)
        items = await page.locator('.harness-row .h-item').count()
        ok(items == 6, f'仪表盘 6 引擎条目(实际 {items})')
        off = page.locator('.harness-row .h-item.off')
        off_n = await off.count()
        if EXPECT_OFF:
            ok(off_n == 1, f'未安装灰化条目=1(实际 {off_n})')
            if off_n == 1:
                txt = await off.first.inner_text()
                ok('未安装' in txt and 'dsh' in txt, f'灰化条目为 dsh:{txt!r}')
            total = await page.locator('.dp-hd:has-text("执行引擎") .fleet-total').inner_text()
            ok('5/6' in total, f'就绪计数 5/6(实际 {total!r})')
        else:
            print(f'  · 灰化条目={off_n}(当前环境探测结果;全部安装时为 0)', flush=True)
            total = await page.locator('.dp-hd:has-text("执行引擎") .fleet-total').inner_text()
            print(f'  · 就绪计数={total!r}', flush=True)
        await page.screenshot(path=f'{SHOT}/harness-1-dashboard-off.png', full_page=False)

        # ---- 3. agents 模板页:选择器禁用未安装项 ----
        await page.goto(BASE + '/workshop/agents', wait_until='domcontentloaded', timeout=90000)
        await page.click('button:has-text("新建模板")')
        await page.wait_for_selector('.ant-modal .ant-select', timeout=10000)
        await page.click('.ant-modal .ant-select')
        await page.wait_for_selector('.ant-select-dropdown .ant-select-item-option', timeout=10000)
        opts = await page.locator('.ant-select-dropdown .ant-select-item-option').all_inner_texts()
        disabled = page.locator('.ant-select-dropdown .ant-select-item-option-disabled')
        dis_n = await disabled.count()
        if EXPECT_OFF:
            ok(any('未安装' in o for o in opts), f'下拉含(未安装)标记:{[o for o in opts if "未安装" in o]!r}')
            ok(dis_n == 1, f'禁用选项=1(实际 {dis_n})')
            if dis_n == 1:
                ok('dsh' in (await disabled.first.inner_text()), '禁用项为 dsh')
        else:
            print(f'  · 下拉选项={len(opts)},禁用={dis_n}(全部安装时为 0)', flush=True)
        await page.screenshot(path=f'{SHOT}/harness-2-agent-select-disabled.png', full_page=False)
        await page.keyboard.press('Escape')

        # ---- 4. teams 页:成员选择禁用 dsh 模板(视觉记录)----
        await page.goto(BASE + '/workshop/teams', wait_until='domcontentloaded', timeout=90000)
        await page.wait_for_timeout(1500)
        await page.screenshot(path=f'{SHOT}/harness-3-teams.png', full_page=False)

        await browser.close()

    fails = [r for r in results if not r[0]]
    print(f'\nUI RESULT: {len(results) - len(fails)} pass / {len(fails)} fail')
    sys.exit(1 if fails else 0)

asyncio.run(main())
