"""一次性:重建 en.ts 中 k5q0aqi010 条目(此前坏值含真实换行导致跨行)。"""
import io, re, json

BS = chr(92)
en = json.load(io.open('i18n/dicts/_en.json', encoding='utf-8'))
norm = lambda s: re.sub(r'\s+', ' ', s).strip()
KEY = 'k5q0aqi010'

# 从 zh dict 拿规范 zh,再模糊查 en(键含“产线是节点”)
zh = json.load(io.open('i18n/dicts/dcw.json', encoding='utf-8'))[KEY]
en_key = next(k for k in en if '产线是节点' in k)
hit = en[en_key]
assert 'top-level isolation unit' in hit
ts = hit.replace(BS, BS + BS).replace("'", BS + "'").replace(chr(10), BS + 'n').replace(chr(13), '')

p = 'i18n/locales/en.ts'
lines = io.open(p, encoding='utf-8').read().split('\n')
out = []
skip = False
for line in lines:
    if line.startswith(f'    {KEY}: '):
        out.append(f"    {KEY}: '{ts}',")
        skip = not line.rstrip().endswith("',")
        continue
    if skip:
        if line.rstrip().endswith("',"):
            skip = False
        continue
    out.append(line)
io.open(p, 'w', encoding='utf-8', newline='').write('\n'.join(out))
print('rebuilt', KEY)
