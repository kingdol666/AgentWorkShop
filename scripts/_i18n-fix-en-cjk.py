# Fix residual CJK values in en.ts; delete dead keys from both locale files.
# v2: ns-block-scoped replacement, supports one nesting level (src.user / kind.manual).
import io, re

EN_FIX = {
  'daq': {'k48oi091': 'decimal places'},
  'logs': {
    'title': 'Ops Log',
    'sub': 'One unified record of every operation — what controls were written, what users and agents did; query isolated by line/product/recipe',
    'live': 'Live',
    'liveHint': 'Receives operation events over WS (summary rendering only; full details in the table below)',
    'fSource': 'Source',
    'fKind': 'Category',
    'fKeyword': 'Keyword',
    'fKeywordPh': 'Search summary/action/actor…',
    'thActor': 'Actor',
    'thSummary': 'Event summary',
    'thScope': 'Scope (line/product/recipe)',
    'empty': 'No matching log entries',
    'mSummary': 'Entry content',
    'mSummaryPh': 'e.g. replaced the heater of oven No.3 and extended holding by 10 min for the current batch',
    'mSubmit': 'Record',
    'mOk': 'Recorded',
    'src.user': 'User',
    'kind.manual': 'Manual',
    'kind.rollback': 'Rollback',
  },
  'deviceTwinPanel': {'kxddket010': 'Exceeds {p0}: {p1}'},
  'inspectorPanel': {'k1tqitzl008': 'Syncing members…', 'kks0y5h009': 'Syncing tasks…'},
  'transcriptTimeline': {'k2hda35028': '{p0}/'},
  'ompTerminalPanel': {
    'k14jk3nu001': '  {p0}· dialog cancelled ({p1}){p2}',
    'k68kkpc002': '{p0}── attached to omp process PID {p1} (session replay {p2} frames)──{p3}',
    'k59zj91003': '{p0}✗ terminal not ready; command not sent{p1}',
    'kvzhi95004': '{p0}✔ HITL answered: {p1}{p2}',
  },
}
DEAD = ['kg2slvf042', 'kpr6a3f043', 'k1rrfz5h049', 'k6nzyd3051', 'kp9ap3k007', 'k1688yr4008', 'ke67kwf005']

BS = chr(92)
def ts(v):
    return v.replace(BS, BS + BS).replace("'", BS + "'").replace('@', "{'@'}")

def ns_block(s, ns):
    m = re.search(r'^  %s: \{$' % re.escape(ns), s, re.M)
    assert m, 'ns not found: ' + ns
    start = m.end()
    em = re.compile(r'^  \},', re.M).search(s, start)
    end = em.start() if em else len(s)
    return start, end

p = 'i18n/locales/en.ts'
s = io.open(p, encoding='utf-8').read()
count = 0
for ns, keys in EN_FIX.items():
    start, end = ns_block(s, ns)
    block = s[start:end]
    for k, v in keys.items():
        vts = ts(v)
        if '.' in k:
            parent, leaf = k.split('.', 1)
            pm = re.search(r'^    %s: \{$' % re.escape(parent), block, re.M)
            assert pm, 'sub-block not found: ' + k
            pstart = pm.end()
            pem = re.compile(r'^    \},', re.M).search(block, pstart)
            pend = pem.start() if pem else len(block)
            sub = block[pstart:pend]
            lm = re.search(r"^      %s: '[^']*',$" % re.escape(leaf), sub, re.M)
            assert lm, 'nested key not found: ' + k
            newsub = sub[:lm.start()] + "      %s: '%s'," % (leaf, vts) + sub[lm.end():]
            block = block[:pstart] + newsub + block[pend:]
        else:
            lm = re.search(r"^    %s: '[^']*',$" % re.escape(k), block, re.M)
            assert lm, 'key not found: ' + k
            block = block[:lm.start()] + "    %s: '%s'," % (k, vts) + block[lm.end():]
        count += 1
    s = s[:start] + block + s[end:]
removed = 0
for k in DEAD:
    pat = re.compile(r"^    %s: .*\n" % re.escape(k), re.M)
    s, n = pat.subn('', s)
    assert n == 1, 'dead key %s removed %d times' % (k, n)
    removed += n
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('en.ts: fixed', count, 'removed', removed)

p = 'i18n/locales/zh-CN.ts'
s = io.open(p, encoding='utf-8').read()
removed = 0
for k in DEAD:
    pat = re.compile(r"^    %s: .*\n" % re.escape(k), re.M)
    s, n = pat.subn('', s)
    assert n == 1, 'zh dead key %s removed %d times' % (k, n)
    removed += n
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('zh-CN.ts: removed', removed)
