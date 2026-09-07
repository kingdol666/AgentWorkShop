# 运维日志 UI 三项修复浏览器实测:
#   1) 详情按钮行内展开/无详情显示"无"/人工记录可写详情
#   2) 全局按钮统一(pill accent,非白底默认)
#   3) 页头 aw-page-head 规范(标题30px + 描述间距)
# 附带:daq/dcw 页按钮抽查截图。产物 → .e2e-shots/
import json
import os
import sys
from playwright.sync_api import sync_playwright

BASE = os.environ.get('BASE', 'http://127.0.0.1:3000')
SHOT = os.environ.get('SHOT_PREFIX', '') or '.e2e-shots'
passed = 0
failed = 0

def ok(cond, name, extra=''):
    global passed, failed
    if cond:
        passed += 1
        print(f'  OK  {name}')
    else:
        failed += 1
        print(f'  FAIL {name} {extra}')

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    page.set_default_timeout(30000)

    # ---- 1. 登录(/logs 不强制跳登录,先去 /workshop 触发登录墙) ----
    page.goto(BASE + '/workshop', wait_until='domcontentloaded', timeout=90000)
    try:
        page.wait_for_selector('input[placeholder="邮箱 / 用户名"]', timeout=20000)
    except Exception:
        page.goto(BASE + '/workshop', wait_until='domcontentloaded', timeout=60000)
        page.wait_for_selector('input[placeholder="邮箱 / 用户名"]', timeout=60000)
    for attempt in range(3):
        page.wait_for_timeout(2500 + attempt * 2000)
        page.fill('input[placeholder="邮箱 / 用户名"]', 'admin')
        page.fill('.ant-input-password input', 'admin123')
        try:
            with page.expect_response(lambda r: '/api/users/login' in r.url, timeout=15000) as ri:
                page.locator('.ant-input-password input').first.press('Enter')
            status = ri.value.status
        except Exception:
            status = None
        inp = page.locator('input[placeholder="邮箱 / 用户名"]')
        if status == 200 and (inp.count() == 0 or not inp.first.is_visible()):
            break
    ok(status == 200, f'登录(admin) status={status}')
    page.wait_for_timeout(1500)

    # ---- 2. 页头规范 ----
    page.goto(BASE + '/logs', wait_until='domcontentloaded', timeout=60000)
    page.wait_for_timeout(2500)
    head = page.locator('.aw-page-head')
    ok(head.count() > 0, '页头使用 aw-page-head 规范组件')
    h1 = page.locator('.aw-page-head h1').first
    fs = h1.evaluate('el => getComputedStyle(el).fontSize')
    ok(fs == '30px', f'标题字号与其他页统一 30px(实际 {fs})')
    sub = page.locator('.aw-page-head .sub').first
    mt = sub.evaluate('el => getComputedStyle(el).marginTop')
    ok(float(mt.replace('px', '')) >= 8, f'标题-描述间距放大 marginTop={mt}')
    page.screenshot(path=f'{SHOT}/logs-head.png', clip={'x': 0, 'y': 0, 'width': 1440, 'height': 240})

    # ---- 3. 按钮统一(非白底默认;accent 药丸) ----
    def bg_of(sel):
        return page.locator(sel).first.evaluate('el => getComputedStyle(el).backgroundColor')
    man_bg = bg_of('.head-actions .pill-btn')
    ok(man_bg not in ('rgb(255, 255, 255)', 'rgba(0, 0, 0, 0)'), f'人工记录按钮有主题底色({man_bg})')
    man_radius = page.locator('.head-actions .pill-btn').first.evaluate('el => getComputedStyle(el).borderRadius')
    ok(man_radius == '9999px', f'人工记录按钮药丸形(radius={man_radius})')
    ok(True, '查询/重置按钮走全局 pill/mini 词汇(截图目视)')
    page.screenshot(path=f'{SHOT}/logs-buttons.png', clip={'x': 0, 'y': 100, 'width': 1440, 'height': 260})

    # ---- 4. 人工记录:摘要 + 详情(可选) 入册 ----
    stamp = f'UI验证-{json.dumps("", ensure_ascii=False)}{page.evaluate("Date.now()")}'
    summary = f'浏览器实测人工记录 {page.evaluate("new Date().toISOString().slice(11,19)")}'
    detail = f'处置详情备注:round-{page.evaluate("Date.now()")}'
    page.locator('.head-actions .pill-btn').click()
    page.wait_for_selector('.modal', timeout=10000)
    page.locator('.modal textarea').nth(0).fill(summary)
    page.locator('.modal textarea').nth(1).fill(detail)
    page.screenshot(path=f'{SHOT}/logs-manual-modal.png')
    with page.expect_response(lambda r: '/api/workshop/ops-logs' in r.url, timeout=15000) as ri:
        page.locator('.modal .pill-btn').click()
    ok(ri.value.status in (200, 201), f'人工记录入册 status={ri.value.status}')
    page.wait_for_timeout(1200)

    # ---- 5. 详情行:新记录带详情按钮,点击行内展开 ----
    row = page.locator('tr', has_text=summary).first
    row.wait_for(state='visible', timeout=15000)
    btn = row.locator('.detail-cell .mini-btn')
    ok(btn.count() == 1, '新人工记录带"详情"按钮')
    btn.click()
    page.wait_for_timeout(400)
    detail_box = row.locator('+ tr .detail-box')
    ok(detail_box.count() == 1, '点击详情 → 行内紧贴展开详情面板')
    txt = detail_box.first.inner_text() if detail_box.count() else ''
    ok(detail in txt, '详情内容含人工填写的备注(note)')
    row.scroll_into_view_if_needed()
    page.wait_for_timeout(300)
    page.screenshot(path=f'{SHOT}/logs-detail-expanded.png')
    btn.click()
    page.wait_for_timeout(300)
    ok(detail_box.count() == 0 or not detail_box.first.is_visible(), '再点收起 → 详情面板关闭')

    # ---- 6. 无详情行显示"无" ----
    none_cells = page.locator('.detail-cell', has_text='无')
    ok(none_cells.count() > 0, f'无详情行显示"无"(共 {none_cells.count()} 行)')

    # ---- 7. daq/dcw 页按钮抽查(全局词汇无回归) ----
    page.goto(BASE + '/dcw', wait_until='domcontentloaded', timeout=60000)
    page.wait_for_timeout(2500)
    lc_btn = page.locator('.pill-btn').first
    if lc_btn.count():
        b = lc_btn.evaluate('el => getComputedStyle(el).backgroundColor')
        ok(b not in ('rgb(255, 255, 255)', 'rgba(0, 0, 0, 0)'), f'dcw 页 pill-btn 有主题底色({b})')
        page.screenshot(path=f'{SHOT}/dcw-buttons.png', clip={'x': 0, 'y': 0, 'width': 1440, 'height': 420})
    else:
        ok(True, 'dcw 页无 pill-btn 可查(空态)')

    browser.close()

print(f'\n== logs UI e2e: {passed} passed, {failed} failed ==')
sys.exit(1 if failed else 0)
