# -*- coding: utf-8 -*-
"""最终海龟汤链路验证:即时响应 + 信箱可查 + 状态实时流转。

用法: python scripts/final-soup-run.py
依赖: 仅标准库(urllib);环境变量 AW_BASE / AW_TOKEN 可覆盖默认值。
输出: 三段式 —— [下发] [实时监控时间线] [终局分析(延迟矩阵/信箱状态流转/内容理解证据)]
"""
import json
import os
import sys
import time
import urllib.request

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

BASE = os.environ.get('AW_BASE', 'http://127.0.0.1:3001')
TOKEN = os.environ.get('AW_TOKEN', 'ut-636e563104b844b591de8aadf6071aea')
CID = os.environ.get('AW_CID', '4b4d742d-2e27-4f2d-a2c9-c1ce9ceb0411')
NAME = {'b0de4cfa': '出谜者(lead)', '9e4e0b76': '猜谜者(worker)'}


def who(agent_id):
    if not agent_id:
        return '?'
    return NAME.get(agent_id[:8], agent_id[:8])


def api(method, path, body=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={
            'Authorization': 'Bearer ' + TOKEN,
            'Content-Type': 'application/json',
        },
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode())
    if isinstance(data, dict) and data.get('code') not in (None, 0):
        raise RuntimeError(f'{path} -> {data}')
    return data.get('data', data) if isinstance(data, dict) else data


def parts_text(parts):
    if not isinstance(parts, list):
        return ''
    return ' '.join(p.get('text', '') for p in parts if isinstance(p, dict))


def ts(iso):
    """ISO 时间 -> 相对 t0 的秒(用于延迟计算)。"""
    from datetime import datetime, timezone
    dt = datetime.fromisoformat(iso.replace('Z', '+00:00')).astimezone(timezone.utc)
    return dt.timestamp()


def main():
    t0 = time.monotonic()

    def rel():
        return f'[{time.monotonic() - t0:7.1f}s]'

    # ---- Phase 0: 前置快照 ----
    ch = api('GET', f'/api/workshop/channels/{CID}/events?limit=1')
    last_seq = ch['maxSeq']
    seen_msgs = {m['id'] for m in api('GET', f'/api/workshop/channels/{CID}/messages?limit=200')}
    print(f'{rel()} === 最终海龟汤验证 ===')
    print(f'{rel()} 基线: maxSeq={last_seq}, 既有信箱消息 {len(seen_msgs)} 条')

    # ---- Phase 1: 下发迷你对局任务(自动路由 lead=出谜者) ----
    task = api('POST', f'/api/workshop/channels/{CID}/tasks', {
        'title': '最终链路验证:迷你海龟汤(2轮问答)',
        'description': (
            '请立即主持一局快节奏迷你海龟汤(总共最多2轮问答,控制时长):\n'
            '1. 用 send_message_to_agent 把一个原创短谜面发给成员"猜谜者"(require_reply=true)。\n'
            '2. 发完立刻用 poll_messages(wait_seconds=60) 阻塞等待对方的问题;对方提问只答"是/否/与此无关"。\n'
            '3. 最多2轮后,用 send_message_to_agent 主动向对方揭晓汤底,然后标记本任务完成。\n'
            '注意:所有对白必须走 send_message_to_agent 发送(不要只写进最终报告);等回复用 poll_messages 的 wait_seconds 阻塞等待。'
        ),
    })
    task_id = task['task']['id'] if isinstance(task, dict) and 'task' in task else task['id']
    print(f'{rel()} 任务已下发: {task_id} (等待 lead 即时唤醒...)')

    # ---- Phase 2: 双流实时监控 ----
    states = {}          # msgId -> state(实时追踪状态流转)
    msg_meta = {}        # msgId -> row(延迟分析用)
    events_log = []      # (rel_t, type, agentId, taskId, note)
    delta_count = 0
    completed = False
    last_event_at = time.monotonic()
    deadline = time.monotonic() + 9 * 60

    while time.monotonic() < deadline:
        # 事件流
        ev = api('GET', f'/api/workshop/channels/{CID}/events?limit=200')
        for e in sorted(ev['items'], key=lambda x: x['seq']):
            if e['seq'] <= last_seq:
                continue
            last_seq = e['seq']
            last_event_at = time.monotonic()
            etype, p = e['type'], e.get('payload') or {}
            agent = e.get('agentId')
            if etype == 'agent.delta':
                delta_count += 1
                continue
            if etype == 'a2a.message':
                meta = p.get('metadata') or {}
                body = parts_text(p.get('parts'))[:90].replace('\n', ' ')
                note = f"{who(meta.get('x-aw-from-agent'))} -> {who(meta.get('x-aw-target-agent')) or '频道'}: {body}"
                events_log.append((last_event_at - t0, etype, agent, e.get('taskId'), note))
            elif etype == 'agent.status':
                note = f"状态 -> {p.get('status') or p}"
                events_log.append((last_event_at - t0, etype, agent, e.get('taskId'), note))
            elif etype == 'task.status':
                note = f"任务 {str(e.get('taskId'))[:8]} -> {p.get('status') or p}"
                if p.get('status') in ('completed', 'COMPLETED') and e.get('taskId') == task_id:
                    completed = True
                events_log.append((last_event_at - t0, etype, agent, e.get('taskId'), note))
            else:
                events_log.append((last_event_at - t0, etype, agent, e.get('taskId'), str(p)[:70]))
            print(f"{rel()} seq={e['seq']:<4} {etype:<13} {who(agent):<12} {events_log[-1][4]}")

        # 信箱状态流(REST 可查性 + 实时流转证据)
        for m in api('GET', f'/api/workshop/channels/{CID}/messages?limit=100'):
            mid, st = m['id'], m['state']
            if mid in seen_msgs and mid not in states:
                continue
            msg_meta.setdefault(mid, m)
            msg_meta[mid]['state'] = st
            if mid not in states:
                states[mid] = st
                if mid not in seen_msgs:
                    age = ''
                    if m.get('consumedAt'):
                        age = f" (created->consumed {ts(m['consumedAt']) - ts(m['createdAt']):.2f}s)"
                    print(f"{rel()} 信箱+ {mid[:8]} {who(m['fromAgentId'])} -> {who(m['toAgentId'])} state={st}{age}")
            elif st != states[mid]:
                lag = time.monotonic() - t0
                print(f"{rel()} 信箱~ {mid[:8]} {states[mid]} -> {st} (观测于创建后 {lag - 0:.1f}s 窗口内)")
                states[mid] = st

        if completed and time.monotonic() - last_event_at > 6:
            break
        if events_log and time.monotonic() - last_event_at > 150:
            print(f'{rel()} 事件静默150s,提前收束监控')
            break
        if not events_log and time.monotonic() - t0 > 180:
            print(f'{rel()} 3分钟无任何事件,异常退出监控')
            break
        time.sleep(1.2)

    # ---- Phase 3: 终局分析 ----
    print(f'\n{rel()} === 终局分析 ===')
    rows = api('GET', f'/api/workshop/channels/{CID}/messages?limit=100')
    fresh = [m for m in rows if m['id'] not in seen_msgs]
    fresh.sort(key=lambda m: m['createdAt'])
    print(f'\n-- A. 信箱延迟矩阵({len(fresh)} 条新消息,REST 可查) --')
    print(f"{'id':<9} {'from->to':<22} {'created(+s)':<11} {'state':<10} {'created->consumed'}")
    t_submit = None
    for m in fresh:
        if t_submit is None:
            t_submit = ts(m['createdAt']) - 0
        delta = f"{ts(m['consumedAt']) - ts(m['createdAt']):.2f}s" if m.get('consumedAt') else '(未消费)'
        route = f"{who(m['fromAgentId'])}->{who(m['toAgentId'])}"
        print(f"{m['id'][:8]:<9} {route:<22} {m['createdAt'][11:19]:<11} {m['state']:<10} {delta}")

    print(f'\n-- B. a2a 消息时间线(往返延迟) --')
    by_id = {m['id']: m for m in fresh}
    for m in fresh:
        meta = json.loads(m.get('metadataJson')) if isinstance(m.get('metadataJson'), str) else (m.get('metadata') or {})
        rt = meta.get('x-aw-in-reply-to')
        if rt and rt in by_id:
            d = ts(m['createdAt']) - ts(by_id[rt]['createdAt'])
            print(f"  {who(m['fromAgentId'])} 回复 {rt[:8]} 往返 {d:.2f}s")

    print(f'\n-- C. 消息全文(内容理解证据) --')
    for m in fresh:
        body = parts_text(m.get('parts'))[:200].replace('\n', ' ')
        st = {'pending': '未读', 'consuming': '处理中', 'consumed': '已读'}.get(m['state'], m['state'])
        print(f"  [{m['createdAt'][11:19]}] {who(m['fromAgentId'])} -> {who(m['toAgentId'])} ({st}): {body}")

    print(f'\n-- D. 事件统计 --')
    counts = {}
    for _, etype, *_ in events_log:
        counts[etype] = counts.get(etype, 0) + 1
    print(f'  {counts} | agent.delta 流片 x{delta_count} | 任务完成: {completed}')
    print('\nDONE' if completed else '\nTIMEOUT')


if __name__ == '__main__':
    main()
