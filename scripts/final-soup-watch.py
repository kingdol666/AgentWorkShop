# -*- coding: utf-8 -*-
"""监控模式:双流追踪事件 + 信箱状态流转(用 python -u 运行)。"""
import json
import os
import sys
import time
import urllib.request

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

BASE = os.environ.get('AW_BASE', 'http://127.0.0.1:3001')
TOKEN = os.environ.get('AW_TOKEN', 'ut-636e563104b844b591de8aadf6071aea')
CID = '4b4d742d-2e27-4f2d-a2c9-c1ce9ceb0411'
NAME = {'b0de4cfa': '出谜者(lead)', '9e4e0b76': '猜谜者(worker)'}
SINCE = '2026-08-21T'  # 只显示今天的新消息;精确过滤用分钟


def who(a):
    return NAME.get((a or '')[:8], (a or '?')[:8])


def api(path):
    req = urllib.request.Request(BASE + path, headers={'Authorization': 'Bearer ' + TOKEN})
    d = json.loads(urllib.request.urlopen(req, timeout=15).read())
    if d.get('code') not in (0, None):
        raise RuntimeError(str(d)[:200])
    return d['data']


def ptext(parts):
    return ' '.join(p.get('text', '') for p in parts if isinstance(p, dict)) if isinstance(parts, list) else ''


def main():
    t0 = time.monotonic()
    ev = api(f'/api/workshop/channels/{CID}/events?limit=1')
    last_seq = ev['maxSeq']
    states, delta_n, done = {}, 0, False
    # 开局即纳入近3分钟内的未消费消息(含刚下发的任务指派)
    cutoff = time.time() - 180
    print(f'[{0.0:6.1f}s] 监控启动 maxSeq={last_seq}', flush=True)
    while time.monotonic() - t0 < 540:
        for e in sorted(api(f'/api/workshop/channels/{CID}/events?limit=200')['items'], key=lambda x: x['seq']):
            if e['seq'] <= last_seq:
                continue
            last_seq = e['seq']
            et, p = e['type'], e.get('payload') or {}
            if et == 'agent.delta':
                delta_n += 1
                continue
            if et == 'a2a.message':
                meta = p.get('metadata') or {}
                body = ptext(p.get('parts'))[:88].replace('\n', ' ')
                note = f"{who(meta.get('x-aw-from-agent'))} > {who(meta.get('x-aw-target-agent')) or '频道'}: {body}"
            elif et == 'agent.status':
                note = f"状态 {p.get('state')}"
                if p.get('state') == 'stopped':
                    continue
            elif et == 'task.status':
                note = f"任务 {str(e.get('taskId'))[:8]} {p.get('state')}"
            else:
                note = str(p)[:70].replace('\n', ' ')
            print(f"[{time.monotonic()-t0:6.1f}s] seq={e['seq']:<4}{et:<20}{who(e.get('agentId')):<13}{note}", flush=True)

        for m in api(f'/api/workshop/channels/{CID}/messages?limit=100'):
            from datetime import datetime, timezone
            ct = datetime.fromisoformat(m['createdAt'].replace('Z', '+00:00')).timestamp()
            if ct < cutoff:
                continue
            st = m['state']
            if m['id'] not in states:
                if st != 'consumed' or m['id'] not in states:
                    print(f"[{time.monotonic()-t0:6.1f}s] 信箱 {m['id'][:8]} {who(m['fromAgentId'])} > {who(m['toAgentId'])} = {st} @ {m['createdAt'][11:19]}" + (f" (消费于 {m['consumedAt'][11:19]})" if m.get('consumedAt') else ''), flush=True)
                states[m['id']] = st
            elif st != states[m['id']]:
                print(f"[{time.monotonic()-t0:6.1f}s] 信箱~ {m['id'][:8]} {states[m['id']]} -> {st}", flush=True)
                states[m['id']] = st
        time.sleep(1.2)
    print('WATCH_END', flush=True)


if __name__ == '__main__':
    main()
