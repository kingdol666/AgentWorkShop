# 全站 UI 普查:登录后逐页截图,供美化前诊断(BASE/OUT/THEME 可参)
import os
import sys
from playwright.sync_api import sync_playwright

BASE = os.environ.get('BASE', 'http://127.0.0.1:3000')
OUT = os.environ.get('OUT', '.e2e-shots/survey')
PAGES = ['/', '/workshop', '/daq', '/dcw', '/logs', '/users', '/permissions', '/plugins', '/monitor', '/settings', '/tokens', '/town']

os.makedirs(OUT, exist_ok=True)
with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_page(viewport={'width': 1600, 'height': 1000})
    pg.set_default_timeout(30000)
    pg.goto(BASE + '/workshop', wait_until='domcontentloaded', timeout=90000)
    try:
        pg.wait_for_selector('input[placeholder="邮箱 / 用户名"]', timeout=20000)
    except Exception:
        pg.goto(BASE + '/workshop', wait_until='domcontentloaded', timeout=60000)
        pg.wait_for_selector('input[placeholder="邮箱 / 用户名"]', timeout=60000)
    for attempt in range(3):
        pg.wait_for_timeout(2500 + attempt * 2000)
        pg.fill('input[placeholder="邮箱 / 用户名"]', 'admin')
        pg.fill('.ant-input-password input', 'admin123')
        try:
            with pg.expect_response(lambda r: '/api/users/login' in r.url, timeout=15000):
                pg.locator('.ant-input-password input').first.press('Enter')
        except Exception:
            pass
        inp = pg.locator('input[placeholder="邮箱 / 用户名"]')
        if inp.count() == 0 or not inp.first.is_visible():
            break
    print('logged in, theme:', pg.evaluate('document.documentElement.className'))

    # 主题:dark 需要时点主题钮(runtime 插件可能按服务端设置强制 light)
    want = os.environ.get('THEME', 'dark')
    is_dark = 'dark' in (pg.evaluate('document.documentElement.className') or '')
    if (want == 'dark') != is_dark:
        btn = pg.locator('button.icon-btn', has=pg.locator('.i-tabler-sun-high, .i-tabler-moon-stars')).first
        if btn.count():
            btn.click()
            pg.wait_for_timeout(1200)
        print('toggled theme →', pg.evaluate('document.documentElement.className'))

    for path in PAGES:
        pg.goto(BASE + path, wait_until='domcontentloaded', timeout=60000)
        pg.wait_for_timeout(3200)
        name = path.strip('/').replace('/', '-') or 'home'
        pg.screenshot(path=f'{OUT}/{name}.png')
        print('shot', path)
    b.close()
print('done →', OUT)
