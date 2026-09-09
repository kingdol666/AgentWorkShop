"""按 eslint JSON 输出批量清除未用 import 名(一次性工具)。"""
import json
import io
import re
import collections
import os

data = json.load(open(r'C:\Users\87287\AppData\Local\Temp\eslint.json', encoding='utf-8'))
per_file = collections.defaultdict(set)
for f in data:
    for m in f.get('messages', []):
        if m.get('ruleId') == '@typescript-eslint/no-unused-vars':
            name = m['message'].split("'")[1]
            per_file[f['filePath']].add(name)

state = {'changed': False}
for path, names in per_file.items():
    p = path.replace(os.sep, '/')
    s = io.open(p, encoding='utf-8').read()
    state['changed'] = False

    def clean_block(match):
        block = match.group(0)
        inner = match.group(1)
        parts = [x.strip() for x in inner.split(',') if x.strip()]
        kept = [x for x in parts if x.split()[0] not in names]
        if len(kept) == len(parts):
            return block
        state['changed'] = True
        from_part = block[block.index('}'):]
        if not kept:
            return ''
        clause = 'import type { ' if block.startswith('import type') else 'import { '
        return clause + ', '.join(kept) + ' ' + from_part

    s = re.sub(r'import type \{([^}]*)\} from[^\n]*\n', clean_block, s)
    s = re.sub(r'import \{([^}]*)\} from[^\n]*\n', clean_block, s)
    s = re.sub(r'\n{3,}', '\n\n', s)
    if state['changed']:
        io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
    print(os.path.basename(p), sorted(names))
