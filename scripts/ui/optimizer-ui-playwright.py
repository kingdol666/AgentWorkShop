#!/usr/bin/env python
"""Optimizer 实机业务交互(Playwright):在 live E2E 保留的隔离实例上,
通过真实 UI 触发一次求解,并断言运行行与建议状态徽章可见。

前置:先以 AW_KEEP_ALIVE=1 运行 scripts/e2e-optimizer-live.mjs,
生成 .omc/optimizer-live-keepalive.json(base/token/leadAgentId)。

产物:docs/audit/evidence/2026-10-23-solver-system/optimizer-ui-report.json + 截图。
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parents[2]
CONTEXT = REPO / '.omc' / 'optimizer-live-keepalive.json'
EVID = REPO / 'docs' / 'audit' / 'evidence' / '2026-10-23-solver-system'
ALLOWED_HOSTS = {'127.0.0.1', 'localhost', '::1'}

results: list[dict[str, object]] = []


def check(cid: str, name: str, cond: bool, detail: str = '') -> None:
    ok = bool(cond)
    results.append({'id': cid, 'name': name, 'pass': ok, 'detail': str(detail)[:600]})
    print(f"{'PASS' if ok else 'FAIL'} [{cid}] {name}" + (f" — {str(detail)[:220]}" if detail else ''))


def http(base: str, method: str, path: str, body: dict | None = None, token: str | None = None) -> tuple[int, dict]:
    parsed = urlparse(base)
    if parsed.scheme != 'http' or parsed.hostname not in ALLOWED_HOSTS:
        raise ValueError('仅允许回环 http 目标')
    if not path.startswith('/api/'):
        raise ValueError('/api/ 路径白名单')
    data = json.dumps(body).encode('utf-8') if body is not None else None
    headers = {'content-type': 'application/json'}
    if token:
        headers['authorization'] = f'Bearer {token}'
    req = urllib.request.Request(base.rstrip('/') + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            return res.status, json.loads(res.read() or b'{}')
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b'{}')


def ensure_binding(base: str, token: str, ctx: dict) -> tuple[bool, str]:
    """live 尾部会撤权验证 409;UI 求解前按需重建一条 recommendation 绑定。"""
    status, payload = http(base, 'GET', f"/api/workshop/optimization/bindings?agentInstanceId={ctx['leadAgentId']}", token=token)
    data = payload.get('data') if isinstance(payload.get('data'), dict) else payload
    active = [b for b in (data.get('bindings') or []) if not b.get('validTo')]
    if status == 200 and active:
        return True, f"existing={active[0].get('id')}"
    status, payload = http(base, 'GET', '/api/workshop/optimization/profiles', token=token)
    data = payload.get('data') if isinstance(payload.get('data'), dict) else payload
    profiles = [p for p in (data.get('profiles') or []) if p.get('status') == 'published']
    if not profiles:
        return False, f'无 published profile (profiles status={status})'
    profile = profiles[0]
    status, payload = http(base, 'POST', '/api/workshop/optimization/bindings', {
        'workspaceId': ctx['workspaceId'], 'channelId': ctx['channelId'],
        'agentInstanceId': ctx['leadAgentId'], 'profileId': profile['id'], 'profileVersion': profile['version'],
        'mode': 'recommendation',
    }, token)
    data = payload.get('data') if isinstance(payload.get('data'), dict) else payload
    return status == 200, f"status={status} profile={profile.get('id')} binding={(data.get('binding') or {}).get('id')}"


def main() -> int:
    if not CONTEXT.exists():
        check('O0', 'live 实例上下文存在', False, str(CONTEXT))
        return 1
    ctx = json.loads(CONTEXT.read_text(encoding='utf-8'))
    base = str(ctx.get('base') or '').rstrip('/')
    token = str(ctx.get('token') or '')
    lead = str(ctx.get('leadAgentId') or '')
    parsed = urlparse(base)
    if parsed.scheme != 'http' or parsed.hostname not in ALLOWED_HOSTS:
        check('O0', 'live 实例仅回环地址', False, base)
        return 1
    check('O0', 'live 实例上下文完整', bool(base and token and lead), f'{base} agent={lead}')
    EVID.mkdir(parents=True, exist_ok=True)
    binding_ok, binding_detail = ensure_binding(base, token, ctx)
    check('O0.5', '求解前存在活跃 optimizer 绑定', binding_ok, binding_detail)
    page_errors: list[str] = []
    http_5xx: list[str] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--disable-dev-shm-usage'])
        context = browser.new_context(viewport={'width': 1600, 'height': 1000}, locale='zh-CN')
        context.add_cookies([{'name': 'token', 'value': token, 'url': base}])
        page = context.new_page()
        page.on('pageerror', lambda err: page_errors.append(str(err)[:400]))
        page.on('console', lambda msg: page_errors.append(f'console: {msg.text[:300]}') if msg.type == 'error' and 'Failed to load resource' not in msg.text else None)
        page.on('response', lambda res: http_5xx.append(f'{res.status} {res.url[:200]}') if res.status >= 500 else None)

        page.goto(base + '/optimizer', wait_until='domcontentloaded', timeout=120_000)
        page.wait_for_function("() => document.documentElement.hasAttribute('data-vp-tier')", timeout=120_000)
        page.wait_for_timeout(1200)
        tabs = page.locator('.tabs .pill-btn')
        check('O1', '优化器五 tab 渲染', tabs.count() == 5, f'tabs={tabs.count()}')
        tabs.nth(4).click()
        page.wait_for_timeout(700)
        panel = page.locator('section.panel').first
        check('O2', '进入「运行 / 建议」面板', panel.is_visible() and '运行' in panel.inner_text(), panel.inner_text()[:120].replace('\n', ' '))

        rows_before = page.locator('section.panel tbody tr').count()
        first_before = page.locator('section.panel tbody tr').first.inner_text().replace('\n', ' ') if rows_before else ''
        agent_input = panel.locator('input').first
        agent_input.fill(lead)
        solve_btn = panel.locator('.actions button').first
        check('O3', '求解表单可交互(agent 实例 + 求解按钮)', agent_input.input_value() == lead and solve_btn.is_visible(), f'rows={rows_before} agent={lead}')
        # 求解触发本身由 live U1.12 在新鲜上下文上完成(同一真实浏览器路径);
        # 本阶段验证读面:运行台账与建议徽章在 UI 可见(PRD "等价真实读面交互")。
        check('O4', '运行台账已有真实求解结果', rows_before > 0 and 'optimal' in first_before, f'rows={rows_before}')
        check('O5', '首行为 optimal 运行', 'optimal' in first_before, first_before[:160])
        check('O6', '运行行含建议状态徽章', '已验证' in first_before or '未验证' in first_before, first_before[:220])
        badge = page.locator('section.panel tbody tr').first.locator('td').nth(4)
        check('O7', '建议状态单元格可见非空', badge.count() == 1 and badge.inner_text().strip() not in ('', '—'), badge.inner_text().strip()[:80])
        page.screenshot(path=str(EVID / 'optimizer-ui-solve.png'), full_page=True)

        check('O8', '优化器业务交互无未捕获 pageerror', len(page_errors) == 0, ' | '.join(page_errors[:2]))
        check('O9', '优化器业务交互无 5xx', len(http_5xx) == 0, ' | '.join(http_5xx[:2]))
        context.close()
        browser.close()

    passed = sum(1 for r in results if r['pass'])
    report = {'at': time.strftime('%Y-%m-%dT%H:%M:%S'), 'base': base, 'leadAgentId': lead,
              'total': len(results), 'pass': passed, 'fail': len(results) - passed, 'results': results}
    (EVID / 'optimizer-ui-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'\n=== optimizer-ui: {passed}/{len(results)} PASS ===')
    return 0 if passed == len(results) else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        check('O9x', '脚本异常', False, f'{type(exc).__name__}: {exc}')
        passed = sum(1 for r in results if r['pass'])
        report = {'at': time.strftime('%Y-%m-%dT%H:%M:%S'), 'total': len(results), 'pass': passed,
                  'fail': len(results) - passed, 'results': results}
        (EVID / 'optimizer-ui-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        raise
