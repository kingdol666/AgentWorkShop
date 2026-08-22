# -*- coding: utf-8 -*-
"""通信 + 多 Agent 协作实测(python -u 运行)。

阶段 A:人类 immediate 消息(requireReply)→ 出谜者回复,测往返时延与可追溯投递。
阶段 B:速决海龟汤任务(1 轮问答)→ 全程双流监控(事件 + 信箱状态)。
终局:延迟矩阵 + 消息全文 + 任务时间线。
"""
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

BASE = os.environ.get('AW_BASE', 'http://127.0.0.1:3001')
TOKEN = os.environ.get('AW_TOKEN', 'ut-636e563104b844b591de8aadf6071aea')
CID = '4b4d742d-2e27-4f2d-a2c9-c1ce9ceb0411'
LEAD = 'b0de4cfa-42eb-4c64-90d1-c571bdd069f6'
WORKER = '9e4e0b76-3f10-41a6-b355-3d2560008592'
NAME = {LEAD[:8]: '出谜者', WORKER[:8]: '猜谜者'}


def who(a):
    return NAME.get((a or '')[:8], (a or 'sys')[:8])


def api(method, path, body=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        d = json.loads(resp.read().decode())
    if isinstance(d, dict) and d.get('code') not in (None, 0, 'ok'):
        raise RuntimeError(f'{path} -> {str(d)[:200]}')
    return d.get('data', d) if isinstance(d, dict) else d


def ptext(parts):
    return ' '.join(p.get('text', '') for p in parts if isinstance(p, dict)) if isinstance(parts, list) else ''


def ts(iso):
    return datetime.fromisoformat(iso.replace('Z', '+00:00')).astimezone(timezone.utc).timestamp()


def log(msg):
    print(f'[{time.strftime("%H:%M:%S")}] {msg}', flush=True)


def main():
    t0 = time.monotonic()

    # ---- 基线 ----
    base_msgs = {m['id'] for m in api('GET', f'/api/workshop/channels/{CID}/messages?limit=300')}
    last_seq = api('GET', f'/api/workshop/channels/{CID}/events?limit=1')['maxSeq']
    log(f'基线: maxSeq={last_seq}, 既有消息 {len(base_msgs)} 条')

    # ---- 阶段 A:人类实时消息往返 ----
    log('=== 阶段 A:通信测试(人类 → 出谜者,requireReply) ===')
    a_sent = api('POST', f'/api/workshop/channels/{CID}/messages', {
        'toAgentId': LEAD,
        'text': '【通信测试】请立即只回复一句「通信正常,信箱可查」,不要做其他任何事。此消息带 requireReply。',
        'fromLabel': 'e2e-collab',
        'priority': 'immediate',
        'requireReply': True,
    })
    a_mid = a_sent['messageId']
    log(f'A 消息已发送 {a_mid[:8]}(REST 回执=真送达,信箱必有)')

    reply_seen = None
    deadline = time.monotonic() + 420
    while time.monotonic() < deadline and not reply_seen:
        for e in sorted(api('GET', f'/api/workshop/channels/{CID}/events?limit=100')['items'], key=lambda x: x['seq']):
            p = e.get('payload') or {}
            if e['type'] == 'a2a.message':
                meta = p.get('metadata') or {}
                if meta.get('x-aw-in-reply-to') == a_mid:
                    reply_seen = (time.monotonic() - t0, ptext(p.get('parts')))
        time.sleep(2)
    if reply_seen:
        log(f'A 回复到达: 「{reply_seen[1][:60]}」(往返含 LLM 回合耗时见终局分析)')
    else:
        log('A 7 分钟内未见 in_reply_to 关联回复(继续阶段 B,不影响协作测试)')

    # ---- 阶段 B:速决海龟汤 ----
    log('=== 阶段 B:多 Agent 协作(速决海龟汤 · 1 轮问答) ===')
    task = api('POST', f'/api/workshop/channels/{CID}/tasks', {
        'title': '协作验证:速决海龟汤(1轮)',
        'description': (
            '开一局速决迷你海龟汤(全程只用 1 轮问答,10 分钟内收口,双方都要快):\n'
            '1. 出谜者:立即用 send_message_to_agent 给「猜谜者」发一个原创短谜面(require_reply=true)。\n'
            '2. 发完立刻 poll_messages(wait_seconds=90) 阻塞等待对方提问;猜谜者提问 1 个封闭问题(只用是/否)。\n'
            '3. 出谜者只答「是/否/与此无关」,答完立即用 send_message_to_agent 揭晓汤底并道别。\n'
            '4. 双方所有对白必须走 send_message_to_agent;出谜者最后 complete_task。\n'
            '速战速决,不要长篇分析。'
        ),
    })
    task_id = task['id']
    log(f'B 任务已下发 {task_id[:8]}(投递回执校验通过 → lead 信箱必有 assign)')

    # ---- 双流监控 ----
    states = {}
    done = False
    delta_n = 0
    last_event_at = time.monotonic()
    deadline = time.monotonic() + 18 * 60
    while time.monotonic() < deadline:
        for e in sorted(api('GET', f'/api/workshop/channels/{CID}/events?limit=120')['items'], key=lambda x: x['seq']):
            if e['seq'] <= last_seq:
                continue
            last_seq = e['seq']
            last_event_at = time.monotonic()
            et, p = e['type'], e.get('payload') or {}
            ag = (e.get('agentId') or '')[:8]
            if et == 'agent.delta':
                delta_n += 1
                continue
            if et == 'a2a.message':
                meta = p.get('metadata') or {}
                body = ptext(p.get('parts'))[:80].replace('\n', ' ')
                log(f"  seq={e['seq']} ✉ {who(meta.get('x-aw-from-agent'))} → {who(meta.get('x-aw-target-agent'))}: {body}")
            elif et == 'task.status':
                st = p.get('state') or str(p)[:40]
                log(f"  seq={e['seq']} ▣ 任务 {str(e.get('taskId'))[:8]} → {st}")
                if e.get('taskId') == task_id and st in ('COMPLETED', 'CANCELED', 'FAILED'):
                    done = True
            elif et == 'agent.status':
                if p.get('state') != 'stopped':
                    log(f"  seq={e['seq']} ● {who(ag)} {p.get('state')}")
            elif et == 'memory.saved':
                log(f"  seq={e['seq']} ◆ {who(ag)} 记忆沉淀")
        # 信箱状态流
        for m in api('GET', f'/api/workshop/channels/{CID}/messages?limit=100'):
            if m['id'] in base_msgs:
                continue
            st = m['state']
            if m['id'] not in states:
                states[m['id']] = st
                log(f"  ☑ 信箱 {m['id'][:8]} {who(m['fromAgentId'])} → {who(m['toAgentId'])} = {st} @{m['createdAt'][11:19]}")
            elif st != states[m['id']]:
                log(f"  ☀ 信箱 {m['id'][:8]} {states[m['id']]} → {st}")
                states[m['id']] = st
        if done and time.monotonic() - last_event_at > 8:
            break
        if time.monotonic() - last_event_at > 240:
            log('  事件静默 4 分钟,提前收束监控')
            break
        time.sleep(1.5)

    # ---- 终局分析 ----
    log('=== 终局分析 ===')
    rows = [m for m in api('GET', f'/api/workshop/channels/{CID}/messages?limit=200') if m['id'] not in base_msgs]
    rows.sort(key=lambda m: m['createdAt'])
    log(f'-- 延迟矩阵({len(rows)} 条新消息,REST 信箱可查) --')
    for m in rows:
        d = f"{ts(m['consumedAt']) - ts(m['createdAt']):6.1f}s" if m.get('consumedAt') else '  未消费'
        st = {'pending': '未读', 'consuming': '处理中', 'consumed': '已读'}.get(m['state'], m['state'])
        log(f"  {m['id'][:8]} {who(m['fromAgentId']):<5}→{who(m['toAgentId']):<5} {m['createdAt'][11:19]} {st} 送达耗时 {d}")
    log('-- 消息全文(理解证据) --')
    for m in rows:
        body = ptext(m.get('parts'))[:110].replace('\n', ' ')
        log(f"  [{m['createdAt'][11:19]}] {who(m['fromAgentId'])}→{who(m['toAgentId'])}: {body}")
    if a_mid in {m['id'] for m in rows}:
        am = next(m for m in rows if m['id'] == a_mid)
        if am.get('consumedAt'):
            log(f'阶段 A 人类消息:创建→消费 {ts(am["consumedAt"]) - ts(am["createdAt"]):.1f}s')
    log(f'任务终态: {"COMPLETED" if done else "未完成(超时)"} | agent.delta 流片 x{delta_n}')
    log('DONE' if done else 'TIMEOUT')


if __name__ == '__main__':
    main()
