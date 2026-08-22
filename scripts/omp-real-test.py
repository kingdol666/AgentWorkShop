# -*- coding: utf-8 -*-
"""真实 OMP 多 Agent 验收测试(python -u 运行,需已启动服务端 3001 + omp CLI)。

三个真实场景(全部走真实 omp 子进程 + 真实 LLM):
  场景 A —— 简单任务执行:lead 自动分解 → worker 执行 → 父任务 COMPLETED
  场景 B —— A2A 通信:worker1 ↔ worker2 经 send_message_to_agent / poll_messages 往返一问一答
  场景 C —— 多任务队列:FIFO 队列 + 单 WORKING 不变量(每个 worker 串行消费,顺序完成)

用法:
  python -u scripts/omp-real-test.py            # 全部场景
  python -u scripts/omp-real-test.py simple     # 仅场景 A
  python -u scripts/omp-real-test.py a2a        # 仅场景 B
  python -u scripts/omp-real-test.py queue      # 仅场景 C
环境变量: AW_BASE / AW_MODEL_PROVIDER / AW_MODEL(缺省 zhipu-coding-plan/glm-5-turbo)
"""
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

BASE = os.environ.get('AW_BASE', 'http://127.0.0.1:3001')
PROVIDER = os.environ.get('AW_MODEL_PROVIDER', 'zhipu-coding-plan')
MODEL = os.environ.get('AW_MODEL', 'glm-5-turbo')

PASS = 0
FAIL = 0
CHANNEL_IDS = []


def check(name, ok, detail=''):
    global PASS, FAIL
    tag = 'PASS' if ok else 'FAIL'
    if ok:
        PASS += 1
    else:
        FAIL += 1
    print(f'  [{tag}]  {name}{f" — {detail}" if detail else ""}', flush=True)


def log(msg):
    print(f'[{time.strftime("%H:%M:%S")}] {msg}', flush=True)


def api(method, path, body=None, token=None, timeout=30):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers=headers,
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        d = json.loads(resp.read().decode())
    if isinstance(d, dict) and d.get('code') not in (None, 0, 'ok', 'success'):
        raise RuntimeError(f'{method} {path} -> {str(d)[:240]}')
    return d.get('data', d) if isinstance(d, dict) else d


def ptext(parts):
    if not isinstance(parts, list):
        return ''
    return ' '.join(p.get('text', '') for p in parts if isinstance(p, dict) and p.get('text'))


def wait_until(name, cond, timeout_s, interval_s=3):
    deadline = time.monotonic() + timeout_s
    last = None
    while time.monotonic() < deadline:
        try:
            last = cond()
            if last:
                return last
        except Exception as e:  # noqa: BLE001
            last = e
        time.sleep(interval_s)
    raise TimeoutError(f'wait_until 超时: {name} (last={str(last)[:200]})')


def all_events(token, channel_id):
    data = api('GET', f'/api/workshop/channels/{channel_id}/events?limit=1000', token=token)
    return data.get('items', [])


def all_tasks(token, channel_id):
    return api('GET', f'/api/workshop/channels/{channel_id}/tasks', token=token)


def all_messages(token, channel_id, limit=500):
    msgs = api('GET', f'/api/workshop/channels/{channel_id}/messages?limit={limit}', token=token)
    return sorted(msgs, key=lambda m: m['createdAt'])


# ═══════════════════════════════════════════════════════════════

def make_team(token, name, n_workers=2, worker_prefix='w'):
    """新建 channel:1 lead + n_workers 个 OMP worker,全部真实 omp 子进程。"""
    ch = api('POST', '/api/workshop/channels', body={
        'name': name,
        'description': '真实 OMP 验收测试',
        'leadAgent': {'name': f'{name}-lead', 'harness': 'omp',
                      'config': {'provider': PROVIDER, 'model': MODEL}},
    }, token=token)
    channel_id = ch['channelId']
    CHANNEL_IDS.append(channel_id)
    lead_id = ch.get('leadAgentId')
    workers = []
    for i in range(n_workers):
        w = api('POST', f'/api/workshop/channels/{channel_id}/agents', body={
            'name': f'{worker_prefix}{i + 1}-{name}',
            'harness': 'omp',
            'role': 'worker',
            'config': {'provider': PROVIDER, 'model': MODEL,
                       'systemPromptPrefix': f'你是 worker{i + 1},本场景测试中的执行者。'},
        }, token=token)
        workers.append(w['id'])
    log(f'团队就绪 channel={channel_id[:8]} lead={lead_id[:8]} workers={[w[:8] for w in workers]} '
        f'(模型 {PROVIDER}/{MODEL})')
    return {'channelId': channel_id, 'leadId': lead_id, 'workers': workers}


def submit(token, channel_id, title, description, assignee=None):
    body = {'title': title, 'description': description}
    if assignee:
        body['assigneeId'] = assignee
    t = api('POST', f'/api/workshop/channels/{channel_id}/tasks', body=body, token=token)
    return t['id']


def terminal_state(tasks, tid):
    t = next((x for x in tasks if x['id'] == tid), None)
    return t['state'] if t else None


TERMINAL = ('COMPLETED', 'FAILED', 'CANCELED')


def wait_terminal(token, channel_id, tid, timeout_s):
    """仅当任务进入终态时返回状态字符串,否则返回 None(供 wait_until 轮询)。"""
    st = terminal_state(all_tasks(token, channel_id), tid)
    return st if st in TERMINAL else None


# ═══════════ 场景 A:简单任务执行 ═══════════

def scenario_simple(token, channel_id):
    log('── 场景 A:简单任务执行(lead 自动分解 → worker 执行 → 父任务收口) ──')
    t0 = time.monotonic()
    pid = submit(token, channel_id,
                 '简单任务:法国首都',
                 '请完成这个小任务:写出句子「巴黎是法国的首都」,然后用 complete_task 工具提交交付物(summary=该句子),不要做其他多余操作。')
    final = wait_until('A 父任务终态', lambda: wait_terminal(token, channel_id, pid, 900),
                       timeout_s=900, interval_s=5)
    elapsed = int(time.monotonic() - t0)
    check('父任务 COMPLETED', final == 'COMPLETED', f'state={final} 耗时={elapsed}s')
    tasks = all_tasks(token, channel_id)
    children = [t for t in tasks if t.get('parentId') == pid]
    check('lead 已分解出子任务', len(children) >= 1, f'children={len(children)}')
    done_child = next((c for c in children if c['state'] == 'COMPLETED'), None)
    check('子任务完成且带交付', done_child is not None and len(done_child.get('artifacts', [])) > 0,
          f"child={done_child['id'][:8] if done_child else '-'} artifacts={len(done_child.get('artifacts', [])) if done_child else 0}")
    parent = next(t for t in tasks if t['id'] == pid)
    parent_text = json.dumps(parent.get('artifacts', ''), ensure_ascii=False)
    check('父任务含最终交付(含关键词)', '巴黎' in parent_text, parent_text[:100])
    return children, parent


# ═══════════ 场景 B:A2A 通信(worker ↔ worker) ═══════════

def scenario_a2a(token, channel_id, workers):
    w1, w2 = workers[0], workers[1]
    log('── 场景 B:A2A 通信(w1 向空闲 w2 发起 require_reply 提问,w2 回执,验证 in_reply_to 关联) ──')
    base_msgs = {m['id'] for m in all_messages(token, channel_id)}
    t0 = time.monotonic()

    # 仅给 w1 派任务;w2 保持空闲(idle 时收到消息 → 独立 peer 回合 → 自动回执关联)
    t1 = submit(token, channel_id, 'A2A-发送方:向同事提问并回报',
                f'你是 A2A 通信测试的发起方。步骤:\n'
                f'1. 用 send_message_to_agent 发消息给同事 <{w2}>,参数 message="请只回复:RED-77",'
                f'require_reply=true(要求对方回执)。\n'
                f'2. 调用 poll_messages(wait_seconds=90) 阻塞等待对方回复。\n'
                f'3. 收到回复后调用 complete_task,summary 参数填你收到的回复全文。\n'
                f'只与同事 [{w2}] 通信,不要联系 lead。',
                assignee=w1)

    # w1 完成即结束(同步检查 reply 链路证据)
    wait_until('A2A 发送方任务终态', lambda: wait_terminal(token, channel_id, t1, 900),
               timeout_s=900, interval_s=5)
    elapsed = int(time.monotonic() - t0)
    st = terminal_state(all_tasks(token, channel_id), t1)
    check('发送方任务 COMPLETED(拿到回执后收口)', st == 'COMPLETED', f'state={st} 耗时={elapsed}s')

    # 通信链路证据:w1 → w2 提问(带 require_reply)+ w2 → w1 回复(带 in_reply_to 关联)
    msgs = [m for m in all_messages(token, channel_id) if m['id'] not in base_msgs]
    asked = [m for m in msgs if m.get('fromAgentId') == w1 and m.get('toAgentId') == w2]
    replies = [m for m in msgs if m.get('fromAgentId') == w2 and m.get('toAgentId') == w1
               and m.get('metadata', {}).get('x-aw-in-reply-to')]
    check('w1→w2 提问已投递(带 require_reply)',
          len(asked) >= 1 and any(m.get('metadata', {}).get('x-aw-require-reply') == 'true' for m in asked),
          f'asked={len(asked)}')
    check('w2→w1 回执已投递(带 in_reply_to 关联)', len(replies) >= 1, f'replies={len(replies)}')
    if asked and replies:
        check('回执内容含 RED-77', 'RED-77' in ptext(replies[-1].get('parts', [])),
              ptext(replies[-1].get('parts', []))[:60])
        check('in_reply_to 精确关联提问消息',
              replies[-1].get('metadata', {}).get('x-aw-in-reply-to') == asked[-1]['id'],
              f"reply→{str(replies[-1].get('metadata', {}).get('x-aw-in-reply-to'))[:8]} ask={asked[-1]['id'][:8]}")
    # 信箱排空:新消息最终全部消费(轮询直到无 pending)
    wait_until('A2A 信箱排空', lambda: not [m for m in all_messages(token, channel_id, 500)
                                            if m['id'] not in base_msgs and m.get('state') in ('pending', 'consuming')],
               timeout_s=120, interval_s=3)
    msgs_final = [m for m in all_messages(token, channel_id, 500) if m['id'] not in base_msgs]
    check('全部新消息已消费(无残留 pending)', all(m.get('state') == 'consumed' for m in msgs_final),
          f'consumed={sum(1 for m in msgs_final if m.get("state") == "consumed")}/{len(msgs_final)}')
    return msgs_final


# ═══════════ 场景 C:多任务队列 ═══════════

def scenario_queue(token, channel_id, workers):
    log('── 场景 C:多任务队列(直发 worker 信箱,验证 FIFO + 单 WORKING 不变量) ──')
    w1, w2 = workers[0], workers[1]
    # 直发:任务绕过 lead,直接进 worker 自己的信箱队列 —— 队列 FIFO 的确定性测试
    assigns = [w1, w2, w1, w2]
    titles = [f'队列任务-{i + 1}(回复 Q{i + 1}-DONE)' for i in range(len(assigns))]
    descs = [f'请只用一句话回复:{f"Q{i + 1}-DONE"}(不要多余文字),然后 complete_task。' for i in range(len(assigns))]
    ids = [submit(token, channel_id, titles[i], descs[i], assignee=assigns[i])
           for i in range(len(assigns))]
    log(f'已直发 {len(ids)} 个任务: w1←[{",".join(str(i + 1) for i, a in enumerate(assigns) if a == w1)}] '
        f'w2←[{",".join(str(i + 1) for i, a in enumerate(assigns) if a == w2)}]')

    t0 = time.monotonic()
    final_states = {}
    deadline = time.monotonic() + 900
    while time.monotonic() < deadline:
        tasks = all_tasks(token, channel_id)
        final_states = {tid: terminal_state(tasks, tid) for tid in ids}
        if all(v == 'COMPLETED' for v in final_states.values()):
            break
        time.sleep(4)
    elapsed = int(time.monotonic() - t0)

    check('全部任务 COMPLETED', all(v == 'COMPLETED' for v in final_states.values()),
          f'states={list(final_states.values())} 耗时={elapsed}s')

    # 单 WORKING 不变量:任一时刻每个 assignee 至多 1 个 WORKING(事件重放)
    evs = all_events(token, channel_id)
    tasks_final = all_tasks(token, channel_id)
    assignee_of = {t['id']: t['assigneeId'] for t in tasks_final}
    sim = {}
    max_concurrent = 0
    for e in evs:
        if e['type'] != 'task.status':
            continue
        payload = e.get('payload') or {}
        state = payload.get('state')
        tid = e.get('taskId')
        ag = e.get('agentId') or ''
        if not tid or not ag or assignee_of.get(tid) != ag:
            continue
        if state == 'WORKING':
            sim[ag] = sim.get(ag, 0) + 1
            max_concurrent = max(max_concurrent, sim[ag])
        elif state in ('COMPLETED', 'FAILED', 'CANCELED', 'WAITING', 'ASSIGNED'):
            sim[ag] = max(0, sim.get(ag, 0) - 1)
    check('单 WORKING 不变量(每 assignee 并发 WORKING≤1)', max_concurrent <= 1,
          f'max_concurrent={max_concurrent}')

    # FIFO 顺序:每个 worker 直发队列按提交序完成(信箱 FIFO)
    tasks = all_tasks(token, channel_id)
    by_assignee = {}
    for t in tasks:
        if t['id'] in ids and t['state'] == 'COMPLETED':
            by_assignee.setdefault(t['assigneeId'], []).append(t)
    fifo_ok = True
    orders = []
    for ag, lst in by_assignee.items():
        order = [int(t['title'].split('-')[1].split('(')[0]) for t in lst]
        orders.append(f"{ag[:8]}:{order}")
        fifo_ok = fifo_ok and order == sorted(order)
    check('每 worker 直发队列 FIFO 顺序完成', fifo_ok, '; '.join(orders) or '无')
    return ids, by_assignee


# ═══════════════════════════════════════════════════════════════

def main():
    which = sys.argv[1] if len(sys.argv) > 1 else 'all'
    log(f'目标: {BASE} | 模型 {PROVIDER}/{MODEL} | 场景: {which}')
    user = api('POST', '/api/workshop/users/register', body={
        'name': f'omp-real-{datetime.now(timezone.utc).strftime("%H%M%S")}',
        'email': f'ompreal{int(time.time() * 1000) % 10**8}@test.local',
        'password': 'Test1234!',
    })
    token = user['token']

    if which in ('all', 'simple'):
        team = make_team(token, 'simple', n_workers=1)
        try:
            scenario_simple(token, team['channelId'])
        finally:
            pass  # 汇聚终局一起清理

    if which in ('all', 'a2a'):
        team = make_team(token, 'a2a', n_workers=2, worker_prefix='w')
        try:
            scenario_a2a(token, team['channelId'], team['workers'])
        finally:
            pass

    if which in ('all', 'queue'):
        team = make_team(token, 'queue', n_workers=2)
        try:
            scenario_queue(token, team['channelId'], team['workers'])
        finally:
            pass

    log(f'★ 结果: {PASS} passed, {FAIL} failed')
    sys.exit(1 if FAIL else 0)


if __name__ == '__main__':
    main()
