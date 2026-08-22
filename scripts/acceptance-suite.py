# -*- coding: utf-8 -*-
"""AgentWorkShop 全功能综合验收(真实 omp + 真实 LLM,5 场景):

  A 简单任务      —— lead 分解 → worker 执行 → 父任务收口(回归)
  B A2A 通信      —— w2 阻塞 poll_messages 期间 w1 require-reply 提问(信箱优先路径)
  C 多任务队列    —— 4 任务直发 2 worker:FIFO + 单 WORKING 不变量
  D busy-peer     —— w1 执行长任务期间 w2 发 require-reply 消息 → turn 结束 peer 回合处理
  E 任务取消      —— 提交后立即取消 → CANCELED + 无交付浪费 + 信箱排空

终局:token 经济性指标(supervise 轮次/LLM 回合数/防重复命中/空轮询计数)。
"""
import json, os, sys, time, urllib.request
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
BASE = os.environ.get('AW_BASE', 'http://127.0.0.1:3000')
PROVIDER, MODEL = 'zhipu-coding-plan', 'glm-5-turbo'
PASS = FAIL = 0

def check(name, ok, detail=''):
    global PASS, FAIL
    print(f'  [{"PASS" if ok else "FAIL"}] {name}{f" — {detail}" if detail else ""}', flush=True)
    PASS, FAIL = PASS + (1 if ok else 0), FAIL + (0 if ok else 1)

def log(m): print(f'[{time.strftime("%H:%M:%S")}] {m}', flush=True)

def api(method, path, body=None, token=None, timeout=30):
    h = {'Content-Type': 'application/json'}
    if token: h['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, method=method, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        d = json.loads(r.read().decode())
    if isinstance(d, dict) and d.get('code') not in (None, 0, 'ok'):
        raise RuntimeError(f'{path} -> {str(d)[:200]}')
    return d.get('data', d)

def tasks_of(t, cid): return api('GET', f'/api/workshop/channels/{cid}/tasks', token=t)
def events_of(t, cid, n=1000): return api('GET', f'/api/workshop/channels/{cid}/events?limit={n}', token=t)['items']
def msgs_of(t, cid, n=300): return sorted(api('GET', f'/api/workshop/channels/{cid}/messages?limit={n}', token=t), key=lambda m: m['createdAt'])
def ptext(m): return ' '.join(p.get('text', '') for p in (m.get('parts') or []) if isinstance(p, dict))
def wait_task(t, cid, tid, timeout, want=None):
    want = want or ('COMPLETED', 'FAILED', 'CANCELED')
    dl = time.monotonic() + timeout
    while time.monotonic() < dl:
        st = next((x['state'] for x in tasks_of(t, cid) if x['id'] == tid), None)
        if st in want: return st
        time.sleep(4)
    return st

def team(token, name, workers=2):
    ch = api('POST', '/api/workshop/channels', body={'name': name, 'leadAgent': {'name': f'{name}-lead', 'harness': 'omp', 'config': {'provider': PROVIDER, 'model': MODEL}}}, token=token)
    cid = ch['channelId']
    ws = [api('POST', f'/api/workshop/channels/{cid}/agents', body={'name': f'{name}-w{i+1}', 'harness': 'omp', 'role': 'worker', 'config': {'provider': PROVIDER, 'model': MODEL}}, token=token)['id'] for i in range(workers)]
    log(f'团队就绪 {name}: channel={cid[:8]} workers={[w[:8] for w in ws]}')
    return cid, ws

def submit(t, cid, title, desc, assignee=None):
    b = {'title': title, 'description': desc}
    if assignee: b['assigneeId'] = assignee
    return api('POST', f'/api/workshop/channels/{cid}/tasks', body=b, token=t)['id']

# ═══ 场景 A:简单任务 ═══
def scenario_a(token):
    log('── A 简单任务:lead 分解 → worker 执行 → 收口 ──')
    cid, ws = team(token, 'sv-a', workers=1)
    t0 = time.monotonic()
    pid = submit(token, cid, 'A:巴黎问题', '写出句子「巴黎是法国的首都」,调用 complete_task 提交交付物。不要多余操作。')
    st = wait_task(token, cid, pid, 600)
    check('A 父任务 COMPLETED', st == 'COMPLETED', f'state={st} 耗时={int(time.monotonic()-t0)}s')
    ch = [x for x in tasks_of(token, cid) if x.get('parentId') == pid]
    done = next((c for c in ch if c['state'] == 'COMPLETED'), None)
    check('A 子任务完成带交付', done is not None and len(done.get('artifacts', [])) > 0, f'children={len(ch)}')
    return cid

# ═══ 场景 B:A2A(poll 阻塞期 require-reply) ═══
def scenario_b(token):
    log('── B A2A:w2 阻塞 poll 期间 w1 require-reply 提问 ──')
    cid, (w1, w2) = team(token, 'sv-b', workers=2)
    t2 = submit(token, cid, 'B-等待者', f'立即调用 poll_messages(limit=5, wait_seconds=120) 阻塞等待。收到消息后:1) send_message_to_agent 回发送者,message="ANSWER-B-OK"。2) complete_task(summary=已回复)。', assignee=w2)
    log('等 25s 让 w2 进入 poll 阻塞…'); time.sleep(25)
    t1 = submit(token, cid, 'B-提问者', f'立即用 send_message_to_agent 向 <{w2}> 发消息(message="请回复:TOKEN-B9", require_reply=true),然后 complete_task(summary=已发送)。', assignee=w1)
    s1, s2 = wait_task(token, cid, t1, 480), wait_task(token, cid, t2, 480, want=('COMPLETED',))
    check('B 双任务 COMPLETED', s1 == 'COMPLETED' and s2 == 'COMPLETED', f'{s1}/{s2}')
    ms = msgs_of(token, cid)
    ask = [m for m in ms if m.get('fromAgentId') == w1 and m.get('toAgentId') == w2]
    rep = [m for m in ms if m.get('fromAgentId') == w2 and m.get('toAgentId') == w1 and m.get('metadata', {}).get('x-aw-in-reply-to')]
    check('B 回信自动关联 in_reply_to', len(rep) >= 1, f'ask={len(ask)} reply={len(rep)}')
    errs = [e for e in events_of(token, cid) if e['type'] == 'error']
    check('B 无 error 事件(无工具调用被打断)', len(errs) == 0, f'errors={len(errs)}')
    return cid

# ═══ 场景 C:多任务队列 ═══
def scenario_c(token):
    log('── C 多任务队列:4 任务直发 2 worker,FIFO + 单 WORKING ──')
    cid, (w1, w2) = team(token, 'sv-c', workers=2)
    assigns = [w1, w2, w1, w2]
    ids = [submit(token, cid, f'C-队列-{i+1}(回 C{i+1}-OK)', f'只回复一句:C{i+1}-OK,然后 complete_task(summary=该句)。', assignee=assigns[i]) for i in range(4)]
    dl = time.monotonic() + 720
    states = {}
    while time.monotonic() < dl:
        states = {tid: next((x['state'] for x in tasks_of(token, cid) if x['id'] == tid), None) for tid in ids}
        if all(v == 'COMPLETED' for v in states.values()): break
        time.sleep(5)
    check('C 4 任务全部 COMPLETED', all(v == 'COMPLETED' for v in states.values()), f'{list(states.values())}')
    # 单 WORKING 重放
    evs = events_of(token, cid)
    tset = set(ids); sim = {}; mx = 0
    tmap = {x['id']: x for x in tasks_of(token, cid)}
    for e in evs:
        if e['type'] == 'task.status' and e.get('taskId') in tset:
            st = (e.get('payload') or {}).get('state'); ag = e.get('agentId') or ''
            if tmap[e['taskId']]['assigneeId'] != ag: continue
            if st == 'WORKING': sim[ag] = sim.get(ag, 0) + 1; mx = max(mx, sim[ag])
            elif st in ('COMPLETED', 'FAILED', 'CANCELED', 'WAITING'): sim[ag] = max(0, sim.get(ag, 0) - 1)
    check('C 单 WORKING 不变量(并发≤1)', mx <= 1, f'max={mx}')
    per = {}
    for tid in ids:
        a = tmap[tid]['assigneeId']; per.setdefault(a, []).append(tid)
    fifo = all([int(tmap[x]['title'].split('-')[1].split('(')[0]) for x in lst] == sorted(int(tmap[x]['title'].split('-')[1].split('(')[0]) for x in lst) for lst in per.values())
    check('C 每 worker FIFO', fifo, '; '.join(f'{k[:8]}:{len(v)}' for k, v in per.items()))
    return cid

# ═══ 场景 D:busy 期间 peer 消息(turn-end 处理) ═══
def scenario_d(token):
    log('── D busy-peer:w1 长任务执行中收到 w2 require-reply → turn 结束处理 ──')
    cid, (w1, w2) = team(token, 'sv-d', workers=2)
    t1 = submit(token, cid, 'D-长任务', '写一篇 120 字左右的短文(主题:协作),中间调用一次 report_progress(50%),最后 complete_task(summary=短文全文)。', assignee=w1)
    log('等 20s 让 w1 进入执行…'); time.sleep(20)
    t2 = submit(token, cid, 'D-发信者', f'立即用 send_message_to_agent 向 <{w1}> 发消息(message="请回复:D-ACK-55", require_reply=true),然后 complete_task(summary=已发送)。', assignee=w2)
    s1, s2 = wait_task(token, cid, t1, 600), wait_task(token, cid, t2, 600)
    check('D 双任务 COMPLETED', s1 == 'COMPLETED' and s2 == 'COMPLETED', f'{s1}/{s2}')
    dl = time.monotonic() + 300
    rep = []
    while time.monotonic() < dl:
        rep = [m for m in msgs_of(token, cid) if m.get('fromAgentId') == w1 and m.get('toAgentId') == w2 and m.get('metadata', {}).get('x-aw-in-reply-to')]
        if rep: break
        time.sleep(5)
    check('D busy w1 turn 结束后回信(带 in_reply_to)', len(rep) >= 1, f'reply={len(rep)}')
    errs = [e for e in events_of(token, cid) if e['type'] == 'error']
    check('D 无 error 事件', len(errs) == 0, f'errors={len(errs)}')
    return cid

# ═══ 场景 E:任务取消 ═══
def scenario_e(token):
    log('── E 取消:提交后立即取消,不浪费执行 ──')
    cid, ws = team(token, 'sv-e', workers=1)
    tid = submit(token, cid, 'E-应被取消(回 E-NEVER)', '只回复一句:E-NEVER,然后 complete_task。', assignee=ws[0])
    api('POST', f'/api/workshop/tasks/{tid}/cancel', body={}, token=token)
    st = wait_task(token, cid, tid, 180, want=('COMPLETED', 'FAILED', 'CANCELED'))
    task = next(x for x in tasks_of(token, cid) if x['id'] == tid)
    check('E 任务已 CANCELED', st == 'CANCELED', f'state={st}')
    if st == 'CANCELED':
        check('E 取消后无交付(未烧完整回合)', len(task.get('artifacts', [])) <= 1, f'artifacts={len(task.get("artifacts", []))}')
    time.sleep(8)
    pending = [m for m in msgs_of(token, cid) if m.get('state') == 'pending']
    check('E 信箱无 pending 残留(作废投递被清)', len(pending) == 0, f'pending={len(pending)}')
    return cid

# ═══ token 经济性审计 ═══
def audit(token, cids):
    log('── token 经济性审计(全部场景频道) ──')
    total_supervise = 0; total_turns = 0; total_tasks = 0; total_tool = 0; dup_hits = 0
    for cid in cids:
        evs = events_of(token, cid)
        lead = None
        ch = api('GET', f'/api/workshop/channels/{cid}', token=token)
        lead = ch.get('leadAgentId')
        # supervise 轮次 ≈ lead 的 status.message 帧数(每轮 supervise 至少一帧文本)
        supervise = sum(1 for e in evs if e['type'] == 'agent.status.message' and e.get('agentId') == lead)
        # LLM 回合 ≈ agent_end 映射的 artifact 'output' 帧数 + error 帧(近似)
        turns = sum(1 for e in evs if e['type'] == 'a2a.artifact' and (e.get('payload') or {}).get('artifact', {}).get('name') == 'output')
        tools = sum(1 for e in evs if e['type'] == 'agent.status.message' and str((e.get('payload') or {}).get('text', '')).startswith('🔧'))
        errs = [e for e in evs if e['type'] == 'error']
        total_supervise += supervise; total_turns += turns; total_tool += tools
        total_tasks += len([t for t in tasks_of(token, cid)])
        log(f'  {cid[:8]}: tasks={len(tasks_of(token, cid))} lead状态帧={supervise} LLM回合≈{turns} 工具调用={tools} error={len(errs)}')
    log(f'合计: 任务={total_tasks} lead监督帧={total_supervise} LLM回合≈{total_turns} 工具调用={total_tool}')
    ratio = total_turns / max(1, total_tasks)
    check('token 经济性:每任务平均 LLM 回合 ≤ 4', ratio <= 4, f'回合/任务={ratio:.1f}')
    check('token 经济性:lead 监督帧/任务 ≤ 6', total_supervise / max(1, total_tasks) <= 6, f'{total_supervise/max(1,total_tasks):.1f}')

def main():
    which = sys.argv[1] if len(sys.argv) > 1 else 'all'
    user = api('POST', '/api/users/register', body={'name': f'sv-{int(time.time())%1000000}', 'email': f'sv{int(time.time()*1000)%10**10}@t.local', 'password': 'Test1234!'})
    token = user['token']
    cids = []
    if which in ('all', 'a'): cids.append(scenario_a(token))
    if which in ('all', 'b'): cids.append(scenario_b(token))
    if which in ('all', 'c'): cids.append(scenario_c(token))
    if which in ('all', 'd'): cids.append(scenario_d(token))
    if which in ('all', 'e'): cids.append(scenario_e(token))
    audit(token, cids)
    for cid in cids:
        api('DELETE', f'/api/workshop/channels/{cid}', token=token)
    log(f'★ 结果: {PASS} passed, {FAIL} failed(测试频道已清理)')
    sys.exit(1 if FAIL else 0)

main()
