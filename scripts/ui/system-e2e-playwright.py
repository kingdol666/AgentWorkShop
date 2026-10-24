#!/usr/bin/env python
"""全系统实机 E2E(webapp-testing skill):真实隔离实例 + Playwright 全路由 + 真实交互。

前置:由 with_server.py 启动隔离实例(AW_MODE=home + 临时 AW_HOME + 独立端口)。
本脚本只做 HTTP 种子 + 浏览器交互/断言/取证,不启动、不终止服务。

安全边界:所有 HTTP 只允许发往回环地址的 /api/ 路径(显式 scheme/host 白名单,
阻断 SSRF/DNS rebinding 面),拒绝任何重定向到非白名单主机。

产物:docs/audit/evidence/2026-10-23-system-e2e/{report.json,shots/*.png}
退出码:0 = 全部断言通过。
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout

BASE = os.environ.get('AW_E2E_BASE', 'http://127.0.0.1:3055').rstrip('/')
REPO = Path(__file__).resolve().parents[2]
EVID = Path(os.environ.get('AW_E2E_EVIDENCE_DIR', str(REPO / 'docs' / 'audit' / 'evidence' / '2026-10-23-system-e2e')))
SHOTS = EVID / 'shots'
ADMIN = {'name': os.environ.get('AW_E2E_NAME', '系统验收'), 'email': os.environ.get('AW_E2E_EMAIL', 'system-e2e@awshop.local'), 'password': os.environ.get('AW_E2E_PASSWORD', 'SystemE2E2026')}
ALLOWED_HOSTS = {'127.0.0.1', 'localhost', '::1'}

_parsed_base = urlparse(BASE)
if _parsed_base.scheme != 'http' or _parsed_base.hostname not in ALLOWED_HOSTS:
    raise SystemExit(f'拒绝非回环测试目标:{BASE}(仅允许 http://127.0.0.1|localhost)')
SAFE_ORIGIN = f'http://{_parsed_base.hostname}:{_parsed_base.port}'

results: list[dict[str, object]] = []


def check(cid: str, name: str, cond: bool, detail: str = '') -> bool:
    ok = bool(cond)
    results.append({'id': cid, 'name': name, 'pass': ok, 'detail': str(detail)[:600]})
    print(f"{'PASS' if ok else 'FAIL'} [{cid}] {name}" + (f" — {str(detail)[:220]}" if detail else ''))
    return ok


def http(method: str, path: str, body: dict | None = None, token: str | None = None) -> tuple[int, dict]:
    if not path.startswith('/api/'):
        raise ValueError(f'仅允许 /api/ 路径:{path}')
    target = SAFE_ORIGIN + path
    if urlparse(target).hostname not in ALLOWED_HOSTS:
        raise ValueError(f'目标主机不在白名单:{target}')
    data = json.dumps(body).encode('utf-8') if body is not None else None
    headers = {'content-type': 'application/json'}
    if token:
        headers['authorization'] = f'Bearer {token}'
    req = urllib.request.Request(target, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            raw = res.read().decode('utf-8', 'replace')
            return res.status, json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as err:
        raw = err.read().decode('utf-8', 'replace')
        try:
            return err.code, json.loads(raw) if raw.strip() else {}
        except json.JSONDecodeError:
            return err.code, {'raw': raw[:400]}


def unwrap(payload: dict) -> dict:
    data = payload.get('data')
    return data if isinstance(data, dict) else payload


def wait_health(timeout_s: int = 180) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            status, payload = http('GET', '/api/health')
            state = unwrap(payload).get('status')
            if status == 200 and state in ('ok', 'healthy', True):
                return True
        except Exception:
            pass
        time.sleep(1.0)
    return False


def route_for(page_file: Path, fixture: dict[str, str]) -> str:
    rel = page_file.relative_to(REPO / 'app' / 'pages').with_suffix('')
    parts = list(rel.parts)
    if parts[-1] == 'index':
        parts = parts[:-1]
    if not parts:
        return '/'
    mapped: list[str] = []
    for part in parts:
        if part == '[wsId]':
            mapped.append(fixture['workspaceId'])
        elif part == '[id]' and 'dcw' in parts:
            mapped.append(fixture['lineId'])
        elif part == '[id]' and 'daq' in parts:
            mapped.append(fixture.get('daqNodeId', 'e2e-missing-node'))
        elif part == '[id]':
            mapped.append('e2e-missing-node')
        else:
            mapped.append(part)
    return '/' + '/'.join(mapped)


def safe_name(route: str) -> str:
    if route == '/':
        return 'dashboard'
    return re.sub(r'[^a-zA-Z0-9]+', '-', route).strip('-') or 'root'


def wait_hydrated(page, timeout_ms: int = 120_000) -> bool:
    """<html data-vp-tier> 由 useResponsive 在客户端 setup 写入 = Nuxt 已水合、按钮有监听器。"""
    try:
        page.wait_for_function("() => document.documentElement.hasAttribute('data-vp-tier')", timeout=timeout_ms)
        return True
    except PlaywrightTimeout:
        return False


def _record_failure(request, failed: list[str], cancelled: list[str]) -> None:
    """API 失败分两类:导航取消(ERR_ABORTED,用户不可见)与真实失败(计入断言)。

    可见错误另有 R*.6 断言(页面出现"无法连接服务器"必失败),不靠这里掩盖。
    """
    if '/api/' not in request.url or request.resource_type == 'websocket' or '/api/system/settings/events' in request.url:
        return
    entry = f'{request.url[:200]} {request.failure} [{request.resource_type}]'
    if 'ERR_ABORTED' in str(request.failure):
        cancelled.append(entry)
    else:
        failed.append(entry)


def main() -> int:
    EVID.mkdir(parents=True, exist_ok=True)
    SHOTS.mkdir(parents=True, exist_ok=True)
    if not wait_health():
        check('E0', '隔离实例健康检查', False, f'{BASE}/api/health 未就绪')
        write_report()
        return 1
    check('E0', '隔离实例健康检查', True, BASE)

    status, payload = http('GET', '/api/users/setup-status')
    needs_setup = bool(unwrap(payload).get('needsSetup'))
    if needs_setup:
        status, payload = http('POST', '/api/users/register', ADMIN)
        check('I0', '首启注册管理员(HTTP 种子)', status == 200 and bool(unwrap(payload).get('token')), f'{status}')
    else:
        status, payload = http('POST', '/api/users/login', {'email': ADMIN['email'], 'password': ADMIN['password']})
        check('I0', '已初始化实例登录(HTTP 种子)', status == 200 and bool(unwrap(payload).get('token')), f'{status}')
    token = str(unwrap(payload).get('token') or '')

    # ── 业务夹具:真实产线 + 工作区(让动态路由与列表页有真实对象) ──
    status, payload = http('POST', '/api/workshop/dcw/lines', {'name': '系统验收线', 'simulated': True}, token)
    line = unwrap(payload).get('line') or {}
    line_id = str(line.get('id') or '')
    check('I0', '夹具:创建模拟产线', status == 200 and bool(line_id), f'{status} {line_id}')
    status, payload = http('POST', '/api/workshop/workspaces', {'name': '系统验收工作区'}, token)
    workspace = unwrap(payload)
    workspace_id = str(workspace.get('id') or (workspace.get('workspace') or {}).get('id') or '')
    check('I0', '夹具:创建工作区', status == 200 and bool(workspace_id), f'{status} {workspace_id}')
    status, payload = http('POST', '/api/workshop/daq', {'name': '系统验收数采节点', 'templateRef': 'temp-tc', 'lineId': line_id}, token)
    daq_node = unwrap(payload).get('node') or {}
    daq_node_id = str(daq_node.get('id') or '')
    check('I0', '夹具:创建数采节点', status == 200 and bool(daq_node_id), f'{status} {daq_node_id}')
    fixture = {'lineId': line_id or 'e2e-missing-line', 'workspaceId': workspace_id or 'e2e-missing-ws', 'daqNodeId': daq_node_id or 'e2e-missing-node'}

    routes = [route_for(path, fixture) for path in sorted((REPO / 'app' / 'pages').rglob('*.vue'))]
    routes = sorted(dict.fromkeys(routes), key=lambda r: (r != '/', r.count('/'), r))
    check('R0', '页面路由发现', len(routes) >= 21, f'{len(routes)} routes: {",".join(routes)}')

    page_errors: list[str] = []
    console_errors: list[str] = []
    http_5xx: list[str] = []
    failed_api: list[str] = []
    cancelled_api: list[str] = []
    current_step = {'name': 'boot'}
    benign = ('unhead', 'Hydration', 'hydrat', 'favicon', 'WebSocket', 'ResizeObserver', 'net::ERR_ABORTED')

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--disable-dev-shm-usage'])
        context = browser.new_context(viewport={'width': 1600, 'height': 1000}, locale='zh-CN')
        page = context.new_page()

        page.on('pageerror', lambda err: page_errors.append(f"[{current_step['name']}] {str(err)[:400]}"))
        page.on('console', lambda msg: console_errors.append(f"[{current_step['name']}] {msg.text[:400]}") if msg.type == 'error' else None)
        page.on('response', lambda res: http_5xx.append(f'{res.status} {res.url[:200]}') if res.status >= 500 else None)
        page.on('requestfailed', lambda req: _record_failure(req, failed_api, cancelled_api))

        # ── 真实 UI 登录(表单,不是 cookie 注入) ──
        page.goto(BASE + '/workshop', wait_until='domcontentloaded', timeout=120_000)
        page.wait_for_selector('.auth-gate', timeout=120_000)
        hydrated = wait_hydrated(page)
        check('I0.5', '登录门前端已水合(按钮可用)', hydrated, str(hydrated))
        page.wait_for_timeout(500)
        # 匿名访问时全局登录弹窗可能已打开:优先操作最上层(modal 内)的登录门
        modal_gate = page.locator('.ant-modal .auth-gate:visible')
        gate = modal_gate.first if modal_gate.count() > 0 else page.locator('.auth-gate:visible').last
        login_status = 0
        login_url = ''
        if gate.count() > 0 and gate.is_visible():
            gate.locator('input[type="email"]').first.fill(ADMIN['email'])
            gate.locator('input[type="password"]').first.fill(ADMIN['password'])
            with page.expect_response(lambda r: '/api/users/login' in r.url or '/api/users/register' in r.url, timeout=60_000) as login_wait:
                gate.locator('button.ant-btn-primary').first.click()
            login_url = login_wait.value.url
            login_status = login_wait.value.status
            page.wait_for_timeout(2500)
        check('I1.0', '登录表单提交 API 成功', login_status == 200 and '/api/users/login' in login_url,
              f'status={login_status} url={login_url[-60:]}')
        cookie_ok = page.evaluate("() => document.cookie.includes('token=')")
        if not cookie_ok:
            # 若登录门未出现(老实例已有会话门),走用户菜单 → 登录弹窗
            chip = page.locator('.user-chip').first
            if chip.count() > 0:
                chip.click()
                page.wait_for_timeout(400)
                login_item = page.locator('.ant-dropdown-menu-item', has_text='登录').first
                if login_item.count() > 0:
                    login_item.click()
                    page.wait_for_timeout(500)
                    modal = page.locator('.ant-modal:visible').first
                    if modal.count() > 0:
                        modal.locator('input[type="email"]').first.fill(ADMIN['email'])
                        modal.locator('input[type="password"]').first.fill(ADMIN['password'])
                        modal.locator('button.ant-btn-primary').first.click()
                        page.wait_for_timeout(2500)
            cookie_ok = page.evaluate("() => document.cookie.includes('token=')")
        check('I1.1', '登录态写入 token cookie', cookie_ok, str(cookie_ok))
        if not cookie_ok and token:
            # 受控恢复:HTTP 种子 token 注入(仅测试;正常路径必须由表单登录产生 cookie)
            context.add_cookies([{'name': 'token', 'value': token, 'url': BASE}])
            page.reload(wait_until='domcontentloaded', timeout=90_000)
            page.wait_for_timeout(1500)
            check('I1.2', '登录态恢复(HTTP 种子 token 注入)', page.evaluate("() => document.cookie.includes('token=')"), 'recovery path')
        page.wait_for_selector('.user-name', timeout=60_000)
        page.wait_for_timeout(600)
        user_name = page.locator('.user-name').first.inner_text()
        check('I1', 'UI 表单登录成功(用户铭牌为管理员)', ADMIN['name'] in user_name, user_name)
        logged_in = page.evaluate("() => document.cookie.includes('token=') || Boolean(localStorage.getItem('token'))")
        check('I2', '登录态落到浏览器上下文(cookie/localStorage)', logged_in, str(logged_in))
        # 关闭可能残留的登录弹窗(401 拦截器/访客横幅),避免遮罩拦截后续点击
        page.keyboard.press('Escape')
        page.wait_for_timeout(300)
        # 匿名启动期的 401 属预期(无会话);此后所有断言只针对已登录会话
        page_errors.clear()
        console_errors.clear()
        http_5xx.clear()
        failed_api.clear()
        cancelled_api.clear()

        # ── 全路由渲染矩阵 ──
        for idx, route in enumerate(routes):
            current_step['name'] = f'route {route}'
            start_page = len(page_errors)
            start_console = len(console_errors)
            start_5xx = len(http_5xx)
            start_failed = len(failed_api)
            doc_status = 0
            try:
                response = page.goto(BASE + route, wait_until='domcontentloaded', timeout=90_000)
                doc_status = response.status if response else 0
                wait_hydrated(page, 30_000)
                if route.startswith('/workshop/w/'):
                    page.wait_for_function("() => document.title.includes('系统验收工作区')", timeout=30_000)
                elif route.startswith('/dcw/'):
                    page.wait_for_function("() => { const h = document.querySelector('.aw-page-head h1'); return !!h && h.textContent.includes('系统验收线') }", timeout=30_000)
                elif route.startswith('/daq/'):
                    page.wait_for_function("() => { const h = document.querySelector('.aw-page-head h1'); return !!h && h.textContent.includes('系统验收数采节点') }", timeout=30_000)
                else:
                    page.wait_for_timeout(1200)
                body_text = page.locator('body').inner_text()
                if route == '/town':
                    main_text = body_text
                else:
                    main_text = page.locator('.app-content').inner_text() if page.locator('.app-content').count() else ''
                title = page.title()
                shot = SHOTS / f'{idx:02d}-{safe_name(route)}.png'
                page.screenshot(path=str(shot), full_page=True)
                errs = page_errors[start_page:]
                new_5xx = http_5xx[start_5xx:]
                new_failed = failed_api[start_failed:]
                new_console = [c for c in console_errors[start_console:] if not any(b.lower() in c.lower() for b in benign)]
                check(f'R{idx + 1}.1', f'{route} HTTP 正常', doc_status < 400, f'status={doc_status}')
                check(f'R{idx + 1}.2', f'{route} 标题与主内容渲染', bool(title.strip()) and len(main_text.strip()) > 30, f'title={title[:60]} main={len(main_text)}')
                check(f'R{idx + 1}.3', f'{route} 无未捕获 pageerror', len(errs) == 0, ' | '.join(errs[:2]))
                check(f'R{idx + 1}.4', f'{route} 无 5xx / 失败 API', len(new_5xx) == 0 and len(new_failed) == 0, ' | '.join((new_5xx + new_failed)[:2]))
                check(f'R{idx + 1}.5', f'{route} 无控制台错误', len(new_console) == 0, ' | '.join(new_console[:2]))
                check(f'R{idx + 1}.6', f'{route} 无可见网络失败提示', '无法连接服务器' not in body_text and 'Failed to fetch' not in body_text,
                      body_text[body_text.find('无法连接服务器'):][:100] if '无法连接服务器' in body_text else '')
            except PlaywrightTimeout as err:
                check(f'R{idx + 1}.0', f'{route} 页面加载', False, str(err)[:200])
            except Exception as err:  # noqa: BLE001 - 单路由失败不得中断整套
                check(f'R{idx + 1}.0', f'{route} 页面加载', False, f'{type(err).__name__}: {err}')

        # ── 真实交互 1:侧栏导航 → 优化器 ──
        current_step['name'] = 'interaction:sidebar'
        page.goto(BASE + '/', wait_until='domcontentloaded', timeout=90_000)
        wait_hydrated(page, 30_000)
        page.wait_for_timeout(1200)
        nav_item = page.locator('.app-menu .menu-item', has_text='优化器').first
        check('I3.1', '侧栏存在「优化器」入口', nav_item.count() == 1 and nav_item.is_visible())
        nav_item.click()
        page.wait_for_function("() => location.pathname === '/optimizer'", timeout=30_000)
        page.wait_for_timeout(1200)
        check('I3.2', '侧栏点击后路由到 /optimizer', page.url.rstrip('/').endswith('/optimizer'), page.url)

        # ── 真实交互 2:优化器五 tab 全点击 ──
        current_step['name'] = 'interaction:optimizer-tabs'
        tabs = page.locator('.tabs .pill-btn')
        count = tabs.count()
        check('I4.1', '优化器五 tab 渲染', count == 5, f'tabs={count}')
        for i in range(count):
            tabs.nth(i).click()
            page.wait_for_timeout(350)
            active = tabs.nth(i).get_attribute('class') or ''
            panel = page.locator('section.panel').first
            check(f'I4.{i + 2}', f'优化器 tab#{i + 1} 可切换且面板可见', 'active' in active and panel.is_visible(),
                  f'class={active} panel={panel.count()}')

        # ── 真实交互 3:主题切换 ──
        current_step['name'] = 'interaction:theme'
        before = page.evaluate("() => localStorage.getItem('app')")
        accent_before = page.evaluate("() => getComputedStyle(document.documentElement).getPropertyValue('--accent')")
        theme_btn = page.locator('.app-header .icon-btn').last
        check('I5.1', '页头主题按钮存在', theme_btn.count() == 1 and theme_btn.is_visible())
        theme_btn.click()
        page.wait_for_timeout(700)
        after = page.evaluate("() => localStorage.getItem('app')")
        accent_after = page.evaluate("() => getComputedStyle(document.documentElement).getPropertyValue('--accent')")
        check('I5.2', '主题切换改变主题令牌(--accent)', accent_before != accent_after, f'{accent_before} -> {accent_after}')
        check('I5.3', '主题偏好持久化(localStorage)', bool(after) and (after != before), f'{before} -> {after}')

        # ── 真实交互 4:数据中台三 tab + 查询动作 ──
        current_step['name'] = 'interaction:data-studio'
        page.goto(BASE + '/data', wait_until='domcontentloaded', timeout=90_000)
        page.wait_for_timeout(1800)
        data_tabs = page.locator('.tabs .tab')
        check('I6.1', '数据中台三 tab 渲染', data_tabs.count() == 3, f'tabs={data_tabs.count()}')
        for i in range(min(3, data_tabs.count())):
            data_tabs.nth(i).click()
            page.wait_for_timeout(700)
            panel_visible = page.locator('[data-test="data-nodes"], [data-test="data-preview"], .ant-table, .empty').count() > 0
            check(f'I6.{i + 2}', f'数据中台 tab#{i + 1} 切换且面板可见', 'on' in (data_tabs.nth(i).get_attribute('class') or '') and panel_visible)
        data_tabs.first.click()
        page.wait_for_timeout(400)
        query_btn = page.locator('[data-test="data-query"]').first
        check('I7.1', '数据中台查询按钮存在', query_btn.count() == 1 and query_btn.is_visible())
        query_btn.click()
        page.wait_for_timeout(1500)
        nodes = page.locator('[data-test="data-nodes"]').first
        err_box = page.locator('[data-test="data-error"]').first
        check('I7.2', '空数据集查询给出节点区或明确错误态(不崩溃)',
              nodes.count() > 0 or err_box.count() > 0, f'nodes={nodes.count()} err={err_box.count()}')

        # ── 真实交互 5:日志筛选 ──
        current_step['name'] = 'interaction:logs-filter'
        page.goto(BASE + '/logs', wait_until='domcontentloaded', timeout=90_000)
        page.wait_for_timeout(1800)
        keyword = page.locator('input.inp-sel[type="search"]').first
        check('I8.1', '日志关键字筛选框存在', keyword.count() == 1 and keyword.is_visible())
        keyword.fill('系统验收')
        keyword.press('Enter')
        page.wait_for_timeout(1500)
        table_visible = page.locator('.log-table').count() > 0 and page.locator('.log-table').first.is_visible()
        log_error = page.locator('.table-card .err').count() > 0
        check('I8.2', '日志筛选提交后有结果表/空态且无错误', table_visible and not log_error and len(page_errors) == 0,
              f'table={table_visible} err={log_error} value={keyword.input_value()}')

        # ── 真实交互 6:设置三分组 ──
        current_step['name'] = 'interaction:settings'
        page.goto(BASE + '/settings', wait_until='domcontentloaded', timeout=90_000)
        page.wait_for_timeout(1500)
        settings_tabs = page.locator('.settings-nav .nav-item')
        check('I9.1', '设置页三分组渲染', settings_tabs.count() == 3, f'groups={settings_tabs.count()}')
        for i in range(min(3, settings_tabs.count())):
            settings_tabs.nth(i).click()
            page.wait_for_timeout(450)
            check(f'I9.{i + 2}', f'设置分组#{i + 1} 激活', 'active' in (settings_tabs.nth(i).get_attribute('class') or ''))

        # ── 真实交互 7:工具搜索(admin) ──
        current_step['name'] = 'interaction:tools-search'
        page.goto(BASE + '/tools', wait_until='domcontentloaded', timeout=90_000)
        page.wait_for_timeout(1800)
        total_rows = page.locator('.ant-table-tbody tr').count()
        search = page.locator('input[placeholder="搜索工具名 / 说明 / 插件"]').first
        check('I10.1', '工具目录有行且搜索框存在', total_rows > 0 and search.count() == 1, f'rows={total_rows}')
        if search.count() == 1:
            search.fill('optimizer')
            page.wait_for_timeout(800)
            filtered_rows = page.locator('.ant-table-tbody tr').count()
            check('I10.2', '工具搜索收窄结果(非零且少于总数)', 0 < filtered_rows < total_rows, f'{total_rows}->{filtered_rows}')

        # ── 真实交互 8:产线列表 → 产线详情(真实 line id) ──
        current_step['name'] = 'interaction:dcw-lines'
        page.goto(BASE + '/dcw', wait_until='domcontentloaded', timeout=90_000)
        page.wait_for_timeout(1800)
        list_heading = page.locator('.aw-page-head h1').first.inner_text() if page.locator('.aw-page-head h1').count() else ''
        check('I11.1', '产线列表页渲染', '产线' in list_heading or page.locator('body').inner_text().count('系统验收线') > 0, list_heading[:80])
        page.goto(BASE + '/dcw/' + fixture['lineId'], wait_until='domcontentloaded', timeout=90_000)
        wait_hydrated(page, 30_000)
        page.wait_for_function("() => { const h = document.querySelector('.aw-page-head h1'); return !!h && h.textContent.includes('系统验收线') }", timeout=30_000)
        line_heading = page.locator('.aw-page-head h1').first.inner_text()
        check('I11.2', '产线详情页标题渲染产线对象', '系统验收线' in line_heading, line_heading[:80])

        # ── 真实交互 9:工作区页面(真实 ws id) ──
        current_step['name'] = 'interaction:workspace'
        page.goto(BASE + '/workshop/w/' + fixture['workspaceId'], wait_until='domcontentloaded', timeout=90_000)
        wait_hydrated(page, 30_000)
        page.wait_for_function("() => document.title.includes('系统验收工作区')", timeout=30_000)
        ws_heading = page.locator('.console-topbar, .harness').first.inner_text()
        check('I12.1', '工作区页面渲染工作区名', '系统验收工作区' in ws_heading, ws_heading[:120].replace('\n', ' '))

        check('E1', '登录后全程无未捕获 pageerror', len(page_errors) == 0, ' | '.join(page_errors[:3]))
        check('E2', '全程无 5xx', len(http_5xx) == 0, ' | '.join(http_5xx[:3]))
        check('E3', '登录后无真实失败 API(导航取消单列)', len(failed_api) == 0, f'{len(cancelled_api)} nav-cancelled | ' + ' | '.join(failed_api[:3]))
        console_fatal = [
            c for c in console_errors
            if 'Failed to load resource' not in c and not any(b.lower() in c.lower() for b in benign)
        ]
        check('E4', '无 JS 运行时控制台错误(资源 4xx 属受控业务错误)', len(console_fatal) == 0, ' | '.join(console_fatal[:3]))

        context.close()
        browser.close()

    write_report()
    passed = sum(1 for r in results if r['pass'])
    print(f'\n=== system-e2e: {passed}/{len(results)} PASS ===')
    return 0 if passed == len(results) else 1


def write_report() -> None:
    passed = sum(1 for r in results if r['pass'])
    report = {
        'at': time.strftime('%Y-%m-%dT%H:%M:%S'),
        'base': BASE,
        'total': len(results),
        'pass': passed,
        'fail': len(results) - passed,
        'results': results,
    }
    (EVID / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - 任何异常都必须留下取证报告
        check('X1', '脚本异常', False, f'{type(exc).__name__}: {exc}')
        write_report()
        raise
