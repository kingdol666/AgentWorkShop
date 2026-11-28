/**
 * 本地检索模型回归（2026-11-28）：
 *  1) WordPiece 分词器：CJK 单字、## 续词、未登录 → [UNK]、大小写、batch padding、maxLength 截断；
 *  2) 注册表安装判定：文件齐全才算装好，截断文件不认；
 *  3) 下载安全边界：只允许 https + 白名单域名，拒绝 IP 字面量/环回/私网/任意站点；
 *  4) ONNX 推理（需真实模型文件，缺失则跳过）：维度、L2 归一化、语义可分。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
const HOME = mkdtempSync(join(tmpdir(), 'aw-local-embed-'))
process.env.AW_HOME = HOME
delete process.env.AW_BENCH_MODE
process.env.AW_MEMORY_GRAPH_RETRIEVAL = '0'

const { WordPieceTokenizer } = await import('../server/services/workshop/memory/local-embedding/tokenizer')
const { installedModel, findLocalEmbeddingModel } = await import('../server/services/workshop/memory/local-embedding/registry')
const { assertAllowedUrl } = await import('../server/services/workshop/memory/local-embedding/download')

const SYNTH_VOCAB = [
  '[PAD]', '[UNK]', '[CLS]', '[SEP]',
  '冷', '却', '水', '流', '量', '调', '整', '压', '力',
  'cool', '##ing', 'cooling', 'flow', 'rate',
  ',', '.',
].join('\n')

function tokenizer(opts?: Partial<{ lowercase: boolean, maxLength: number }>): InstanceType<typeof WordPieceTokenizer> {
  return new WordPieceTokenizer(SYNTH_VOCAB, { lowercase: opts?.lowercase ?? false, maxLength: opts?.maxLength ?? 512 })
}

test('WordPiece: CJK 单字切分 + [CLS]/[SEP] 包裹', () => {
  const tk = tokenizer()
  const { ids, attention } = tk.encode('冷却水流量')
  assert.deepEqual(ids, [2, 4, 5, 6, 7, 8, 3], '中文按单字入词表')
  assert.deepEqual(attention, [1, 1, 1, 1, 1, 1, 1])
})

test('WordPiece: ## 续词 + 整词命中 + 未登录 → [UNK] + 标点独立', () => {
  const tk = tokenizer()
  assert.deepEqual(tk.encode('cooling').ids, [2, 15, 3], '整词命中优先于拆分')
  // 'coolflow' 不在词表 → 贪心最长匹配失败 → UNK
  assert.deepEqual(tk.encode('coolflow').ids, [2, 1, 3], '未登录词整体退化为 [UNK]')
  const withPunct = tk.encode('流量,压力')
  assert.ok(withPunct.ids.includes(18), '逗号必须独立成 token')
})

test('WordPiece: 小写化开关与 maxLength 截断保留 [SEP]', () => {
  const cased = tokenizer({ lowercase: false })
  assert.deepEqual(cased.encode('cool').ids, [2, 13, 3])
  const lowered = tokenizer({ lowercase: true })
  assert.deepEqual(lowered.encode('COOL').ids, [2, 13, 3], '小写化后命中同一词条')
  const tiny = tokenizer({ maxLength: 4 })
  const out = tiny.encode('冷却水流量压力')
  assert.equal(out.ids.length, 4, '截断到 maxLength')
  assert.equal(out.ids[0], 2)
  assert.equal(out.ids[out.ids.length - 1], 3, '截断后仍以 [SEP] 结尾')
})

test('WordPiece: batch padding 对齐 + attention 0 填充', () => {
  const tk = tokenizer()
  const { ids, attention, length } = tk.encodeBatch(['冷却', '冷却水流量'])
  assert.equal(length, 7, '批内最长 5 token + CLS/SEP')
  assert.equal(ids.length, 2)
  assert.equal(attention[0]!.length, 7)
  assert.equal(ids[0]!.length, 7)
  assert.deepEqual(attention[0]!.slice(4), [0n, 0n, 0n], '短句尾部 attention=0')
  assert.deepEqual(ids[0]!.slice(4), [0n, 0n, 0n], 'PAD id=0')
})

test('注册表：文件齐全才算安装，截断文件不认', () => {
  const def = findLocalEmbeddingModel('bge-small-zh-v1.5')
  assert.ok(def)
  assert.equal(installedModel('bge-small-zh-v1.5'), null, '未下载 → 未安装')
  const dir = join(HOME, 'models', 'embedding', 'bge-small-zh-v1.5')
  mkdirSync(dir, { recursive: true })
  // 按声明体积写满（内容不参与判定，只看存在性与体积）→ 视为已安装
  for (const f of def!.files) writeFileSync(join(dir, f.name), Buffer.alloc(f.bytes))
  assert.equal(installedModel('bge-small-zh-v1.5')?.def.id, 'bge-small-zh-v1.5')
  // 截断到 1 字节 → 未安装（防止"下载中断但目录存在"被当成可用模型）
  const onnx = def!.files.find(f => f.name.endsWith('.onnx'))!
  writeFileSync(join(dir, onnx.name), 'x')
  assert.equal(installedModel('bge-small-zh-v1.5'), null, '截断模型文件不得视为已安装')
  rmSync(join(HOME, 'models'), { recursive: true, force: true })
})

test('下载安全边界：仅 https + 白名单域名，拒绝私网/任意站点', () => {
  assert.equal(assertAllowedUrl('https://huggingface.co/a/b/resolve/main/c').hostname, 'huggingface.co')
  assert.equal(assertAllowedUrl('https://hf-mirror.com/a/b').hostname, 'hf-mirror.com')
  // HF 官方域族后缀匹配：Xet CAS 桥（实机 302 目标）必须可过，同形域必须被拒
  assert.equal(assertAllowedUrl('https://cas-bridge.xethub.hf.co/x').hostname, 'cas-bridge.xethub.hf.co')
  assert.equal(assertAllowedUrl('https://cdn-lfs.huggingface.co/x').hostname, 'cdn-lfs.huggingface.co')
  assert.throws(() => assertAllowedUrl('https://evil-huggingface.co/x'), /不在白名单/, '同形域不得借后缀匹配混入')
  assert.throws(() => assertAllowedUrl('https://evil.hf.co.evil.com/x'), /不在白名单/)
  assert.throws(() => assertAllowedUrl('http://huggingface.co/x'), /仅允许 https/)
  assert.throws(() => assertAllowedUrl('https://evil.example.com/x'), /不在白名单/)
  assert.throws(() => assertAllowedUrl('https://127.0.0.1/x'), /不在白名单|私网/)
  assert.throws(() => assertAllowedUrl('https://localhost/x'), /不在白名单|私网/)
  assert.throws(() => assertAllowedUrl('https://192.168.1.10/x'), /不在白名单|私网/)
})

test('ONNX 本地推理（需真实模型，缺失则跳过）：维度 + L2 + 语义可分', async (t) => {
  const def = findLocalEmbeddingModel('bge-small-zh-v1.5')!
  // 真实模型由外部预置（CI 不联网）；缺失时跳过而不是失败
  const realHome = process.env.AW_LOCAL_EMBED_MODEL_HOME
  if (!realHome) {
    t.skip('AW_LOCAL_EMBED_MODEL_HOME 未设置（无真实模型文件）')
    return
  }
  process.env.AW_HOME = realHome
  const { embedWithLocalModel } = await import('../server/services/workshop/memory/local-embedding/onnx')
  const [q, related, unrelated] = await embedWithLocalModel(def.id, [
    '冷却水流量怎么调',
    '冷却水流量控制在 32 L/min 时良率最优',
    '本月财务报表与应收账款',
  ], 'query')
  assert.equal(q!.length, def.dims, `维度应为 ${def.dims}`)
  const norm = Math.sqrt(q!.reduce((s, x) => s + x * x, 0))
  assert.ok(Math.abs(norm - 1) < 1e-3, `L2 范数应≈1，实际 ${norm}`)
  const dot = (a: Float32Array, b: Float32Array): number => {
    let s = 0
    for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!
    return s
  }
  assert.ok(dot(q!, related!) > dot(q!, unrelated!), '相关句相似度必须高于无关句')
})

// ── backfill 游标语义（评审发现 3/4 回归，2026-11-28）────────────────────────
// 旧实现按 updated_at 固定窗口 + pending 空即报 0：rebuild 原地重编同一批、
// eligible 超窗时窗口外永不回填。现在 rowid 游标翻页 + remaining=max(0, eligible-vectorRows)。
test('backfill 游标：多轮覆盖全部行；rebuild 后向量行数=可编码行数', async () => {
  process.env.AW_HOME = HOME
  const { openWorkshopDb } = await import('../server/services/workshop/db/database')
  const { TEAM_AGENT_ID } = await import('../server/services/workshop/db/memory.repo')
  const { backfillEmbeddings } = await import('../server/services/workshop/memory/local-embedding/backfill')
  const { invalidateRuntimeSettingsCache } = await import('../server/services/workshop/settings')
  invalidateRuntimeSettingsCache()
  const db = openWorkshopDb(':memory:')
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, workspace, enabled, version, line_id, owner_user_id, memory_access_mode, created_at, updated_at)
    VALUES ('c1', '回填游标验收', '', '', '', '{}', 1, 1, '', 'u1', 'inherit', ?, ?)`).run(now, now)
  // 50 行、每轮 limit=8：旧实现按 updated_at 固定窗口会反复重编同一批；
  // 新实现 rowid 游标必须恰好覆盖全部 50 行
  const ins = db.prepare(`INSERT INTO agent_memories(id, channel_id, agent_id, kind, title, title_fts, content, importance,
      task_id, session_id, dedup_key, status, created_at, updated_at)
    VALUES (?, 'c1', ?, 'semantic', ?, ?, ?, 0.5, NULL, '', ?, 'active', ?, ?)`)
  for (let i = 0; 50 > i; i++) {
    ins.run(`bf-row-${i}`, TEAM_AGENT_ID, `回填行${i}`, `回 填 行 ${i}`, `回填正文${i}`, `bf:${i}`, now, now)
  }
  const stub = {
    dims: () => 4,
    describe: () => ({ model: 'stub' }),
    embed: async (texts: string[]) => texts.map(() => new Float32Array([1, 0, 0, 0])),
  } as never
  const r1 = await backfillEmbeddings(db, { limit: 8, rebuild: true, provider: stub })
  assert.equal(r1.embedded, 8, `单轮 limit=8 应只编 8 行，实际 ${r1.embedded}`)
  assert.equal(r1.remaining, 42, `remaining 应为 42（50-8），实际 ${r1.remaining}（旧实现会报 0）`)
  let total = r1.embedded
  let rounds = 1
  while (30 > rounds) {
    const r = await backfillEmbeddings(db, { limit: 8, provider: stub })
    if (r.embedded === 0) break
    total += r.embedded
    rounds++
    if (r.remaining === 0) break
  }
  assert.equal(total, 50, `多轮游标应恰好覆盖全部 50 行，实际 ${total}（rounds=${rounds}）`)
  const vecRows = Number((db.prepare('SELECT COUNT(*) AS n FROM agent_memories_vec').get() as { n: number }).n)
  assert.equal(vecRows, 50, `向量行应为 50，实际 ${vecRows}`)
  const rLast = await backfillEmbeddings(db, { limit: 8, provider: stub })
  assert.equal(rLast.embedded, 0, '全部编完后应为 0 新增')
  assert.equal(rLast.remaining, 0, '全部编完后 remaining=0')
  // rebuild 全量语义：清空后重编同样游标推进，不原地打转
  const rr = await backfillEmbeddings(db, { limit: 8, rebuild: true, provider: stub })
  assert.equal(rr.embedded, 8)
  assert.equal(rr.remaining, 42, `rebuild 后 remaining 应从 42 起，实际 ${rr.remaining}`)
  db.close()
})
