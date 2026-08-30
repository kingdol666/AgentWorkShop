"""一次性:把 en.ts 里仍为中文回退的词条,用 i18n/dicts/_en.json 的规范匹配英文替换。"""
import io, re, json

BS = chr(92)  # 反斜杠
en = json.load(io.open('i18n/dicts/_en.json', encoding='utf-8'))
norm = lambda s: re.sub(r'\s+', ' ', s).strip()

p = 'i18n/locales/en.ts'
s = io.open(p, encoding='utf-8').read()
out = []
fixed = 0
for line in s.split('\n'):
    m = re.match(r"    (k\w+): '(.*)',\s*$", line)
    if m:
        key, cur = m.group(1), m.group(2)
        # 还原 TS 转义 → 真实值(顺序安全:先还原转义符,最后还原 \n 与 \')
        cur_real = cur.replace(BS + BS, chr(0))
        cur_real = cur_real.replace(BS + 'n', chr(10)).replace(BS + "'", "'")
        cur_real = cur_real.replace(chr(0), BS)
        hit = en.get(norm(cur_real))
        if hit is not None:
            ts = hit.replace(BS, BS + BS).replace("'", BS + "'").replace(chr(10), BS + 'n')
            out.append(f"    {key}: '{ts}',")
            fixed += 1
            continue
    out.append(line)
io.open(p, 'w', encoding='utf-8', newline='').write('\n'.join(out))
print('fixed:', fixed)
