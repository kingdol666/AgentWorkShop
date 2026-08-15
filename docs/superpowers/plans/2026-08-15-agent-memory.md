# Agent 持久记忆系统(AgentMemory)Implementation Plan — v2 完整版

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每个 AgentRuntime 装配 harness 无关的完整持久记忆系统:run 结束零成本沉淀经验,run/supervise 前按 bm25+向量混合检索、token 预算注入;含团队共享域、人工策展写入口、Ebbinghaus 式衰减清理。

**Architecture:** 三层算法借鉴——MemGPT/Letta 分层(工作记忆归 harness,长期记忆落库按预算召回);Mem0 harvest(蒸馏源 = `complete_task(summary)` 自产物 + `(agent_id, dedup_key)` 去重);agent-memory(ivanzwb)排序装配(`0.5×相关性+0.3×时近性+0.2×重要性`,贪心预算填充,访问衰减)。检索 = FTS5 bm25(中文单字切分)+ sqlite-vec 向量(partition key 域隔离)混合,`max()` 融合。存储 = 现有 node:sqlite 单库,`agent_memories` 表 + FTS5 触发器同步 + vec0 延迟建表(维度由 embedding provider 实测决定)。

**Tech Stack:** 唯一新依赖 `sqlite-vec`(npm,MIT,180 万周下载,本机 Windows + node:sqlite 实测可用)。embedding 走 OpenAI 兼容 HTTP 端点(env 配置,零 SDK,未配置则纯 FTS 优雅降级)。其余零新依赖。

## Global Constraints

- **新依赖仅 `sqlite-vec`**;embedding 用原生 fetch 调 OpenAI 兼容端点,不引入任何 SDK
- **harness 无关**:`AgentRunRequest.memory?` / `AgentRunContext.memory?`(supervise 专用)可选字段;harness 自主决定注入与否(mock/claude 骨架零改动)
- **记忆主路径零强制 LLM**:harvest 源是 harness 自产 summary;embedding 是可选增强(未配置 env 即关闭)
- **记忆失败永不阻塞执行**:recall/record/embed/maintenance 全部 try-catch,异常只 console.error
- **node:sqlite 同步 API**:repo 层全同步;`AgentMemory.recall/record*` 返回 **Promise**(P0 即定型,P1 加 embedding 不改调用点)
- **BigInt 绑定坑(实测)**:node:sqlite 把 JS number 绑定为 REAL;vec0 辅助列/mem_rowid 一律 `BigInt(n)` 传入(实测 number → "Auxiliary column type mismatch")
- **vec0 建表绝不进 SCHEMA_SQL**:vec0 DDL 需扩展已加载且维度运行时才知;延迟到向量服务初始化(provider 首次成功 embed 实测维度)时 `CREATE IF NOT EXISTS`
- **FTS5 中文**:存储与查询两侧 CJK 单字切分;查询词 **OR 连接**(实测空格连接 = 短语查询漏召回)
- **commitlint**:subject 小写无 PascalCase(如 `feat(workshop): agent 记忆向量检索`)
- 测试:`scripts/test-*.ts` + `check()` + `:memory:` db,`npx tsx` 直跑;SQL 双落 `schema.sql`(文档)与 `database.ts` SCHEMA_SQL(运行时权威)
- 记忆域隔离:`agent_id` 过滤;团队共享行 `agent_id = '__team__'`(常量 `TEAM_AGENT_ID`),UNIQUE(agent_id, dedup_key) 天然覆盖团队去重
- kind 枚举:`'episodic-task' | 'episodic-peer' | 'semantic'`(REST 人工策展)

## 已实测验证的算法事实(实现不得偏离)

| # | 事实 | 验证结论 |
|---|---|---|
| V1 | FTS5 + bm25 in node:sqlite | 可用,`rank` 升序 = 越负越相关 |
| V2 | CJK 单字切分 + OR 连接 | 混合中英检索命中;空格连接漏召回 |
| V3 | `ON CONFLICT DO UPDATE` → AFTER UPDATE 触发器 | FTS 同步正确(upsert 刷新可检索新内容) |
| V4 | vec0 `partition key` + `+mem_rowid` 辅助列 + BigInt | 建表/插入/域隔离 kNN/按 mem_rowid 刷新全通 |
| V5 | `SELECT rowid FROM v WHERE mem_rowid = ?` → DELETE → 重插 | 刷新语义成立,互不干扰 |
| V6 | node:sqlite number→REAL / BigInt→INTEGER | vec0 整数列必须 BigInt 绑定 |
| V7 | `DatabaseSync(path, { allowExtension: true })` + loadExtension | Windows 本机实测 OK |

**V8-V11 复核补充事实(对照真实代码,实现不得偏离):**

| # | 事实 | 设计后果 |
|---|---|---|
| V8 | FTS5 默认 tokenizer 不切 CJK:**title 原样入库则 CJK 标题不可检索**(title 是任务记忆的主要查询面) | 主表加 `title_fts` 列(写入侧切分),FTS 触发器索引用 `new.title_fts`;`title` 保留原文供展示 |
| V9 | omp run 路径**从不产出** `{kind:'message'}` 事件——assistant 文本走 `status.message`(message_end)与终态 `artifact name='output'`(agent_end) | replyText 收集必须聚合三类源:`message` 事件 + `status.message` + 终态 artifact('output')文本 |
| V10 | `messages.channel_id REFERENCES channels(id)` 且 `PRAGMA foreign_keys=ON` | 测试落消息前必须先 `seedChannel`(照抄 test-agent-runtime.ts:55-60) |
| V11 | `AgentInfo` 字段名是 `id`(**非 agentId**);既有测试惯例 = `makeFakeEngine()`/`mkAgent`/`mkMessage`(test-agent-runtime.ts:62-146) | 讋试一律照抄该惯例;fake engine 的 `complete()` 会 throw,完成态经 `transition(taskId,'COMPLETED')` 驱动 |

**排序**:`score = 0.5×rel + 0.3×recency + 0.2×importance`;`recency = exp(-ageDays/7)`;`importance = min(1, row.importance + accessCount×0.05)`。存储 importance:task COMPLETED=0.8 / FAILED=0.55 / peer=0.4 / semantic(REST)=0.9。

**混合融合**:单条记忆 `rel = max(rel_fts, sim_vec)`,`sim_vec = clamp(1 - distance, 0, 1)`(cosine)。FTS 归一:首名 1.0 按 `-bm25/best` 比例,`rel<0.1` 弱命中只留前 3;vector 命中天然有 sim。任一源不可用则退化为另一源。

**兜底召回**:FTS+vec 之外并取该 agent 最近 5 条(rel=0.15),冷启动也有上下文;按 id 去重。

**token 预算**:默认 800(`AW_MEMORY_BUDGET_TOKENS`);`estimateTokens = ceil(ascii/4) + cjk`;贪心整行取舍不截半句;命中行 touch()。

**注入格式**:
```
## 相关记忆(本 Agent 历史作业沉淀;与当前任务冲突时,以当前任务为准)
- [3天前·任务] 实现登录页面:用OAuth2方案完成了登录…
- [2小时前·协作] 来自 w1 的消息:问:… 答:…
- [共享] 本channel代码风格:全部使用 TypeScript strict 模式
```

**衰减清理**(Task 11):episodic 类(`episodic-*`)180 天未访问(`last_accessed_at ?? created_at`)→ 删除;每 agent 上限 500 条,超限按 effectiveScore 升序淘汰;`semantic` 与团队行豁免(人工策展)。定时 6h(可配)+ REST 手动触发。

**embedding provider**(Task 7):env `AW_MEMORY_EMBED_BASE_URL` / `AW_MEMORY_EMBED_API_KEY` / `AW_MEMORY_EMBED_MODEL`;OpenAI 兼容 `POST {base}/embeddings` `{input: string[], model}` → `{data: [{embedding: number[]}]}`。batch、10s 超时、**熔断**:连续 3 次失败禁用 10 分钟。未配置 env → 向量分支整体关闭(纯 FTS)。维度以首次成功返回的向量长度为准,延迟建 vec0 表;已存表维度不符 → 禁用向量 + error log(不重建不静默)。

**supervise 注入**(Task 12):query 由 snapshot 构造(非终态任务标题 + 失败任务 + 成员名),`recall(query, { touch: false })`(防每 tick 通胀 access_count);经 `AgentRunContext.memory` 传给 impl.supervise;omp 的 buildSupervisePrompt 注入。

**Out of scope**:procedural 记忆、LLM 自动事实蒸馏、记忆自动重压缩、跨 channel 记忆迁移、记忆编辑端点。

---

# Phase P0 —— 基础管线(schema/模块/运行时/注入/装配)

### Task 1: v6 schema + memory.repo.ts(预埋 semantic/team/delete)

**Files:**
- Modify: `server/services/workshop/db/schema.sql`(尾部)
- Modify: `server/services/workshop/db/database.ts`(SCHEMA_SQL + MemoryRow + 注释)
- Create: `server/services/workshop/db/memory.repo.ts`
- Create: `scripts/test-memory.ts`

**Interfaces:**
- Produces: `TEAM_AGENT_ID = '__team__'`;`createMemoryRepo(db)` 返回:`upsert(input: MemoryUpsertInput): void`、`search(agentId, matchQuery, limit): Array<MemoryRow & { bm25: number }>`(FTS 查询恒含 team 行:`m.agent_id IN (?, '__team__')`)、`listRecent(agentId, limit)`(严格本人)、`listByAgent(agentId, limit)`、`findByAgentDedup(agentId, dedupKey): { id: string, rowid: number } | null`(供向量写回)、`touch(id)`、`delete(id): boolean`(FTS 触发器自动清理;vec 由上层先 `vecDelete`)、`listMemoryAgentIds(): string[]`(维护任务迭代,排除 team);`MemoryRow`(database.ts 导出)

- [ ] **Step 1: 写失败测试**

创建 `scripts/test-memory.ts`:

```ts
/**
 * AgentMemory P0 测试:repo(FTS/去重/touch/delete/team 预埋)→ 模块(排序/预算/格式)→ 运行时集成。
 * 运行: npx tsx scripts/test-memory.ts
 */
import type { DatabaseSync } from 'node:sqlite'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createMemoryRepo, TEAM_AGENT_ID } from '../server/services/workshop/db/memory.repo'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const db: DatabaseSync = openWorkshopDb(':memory:')
const repo = createMemoryRepo(db)
const seg = (s: string): string => s.replace(/([\u4e00-\u9fff])/g, ' $1 ')

// ---- repo:写入 + CJK FTS 检索(title 经 titleFts 切分入索引;content 切分传入)----
repo.upsert({ channelId: 'ch1', agentId: 'a1', kind: 'episodic-task', title: '实现登录页面', titleFts: seg('实现登录页面'), content: seg('用OAuth2方案完成了登录鉴权'), importance: 0.8, taskId: 't1', dedupKey: 'task:t1' })
repo.upsert({ channelId: 'ch1', agentId: 'a1', kind: 'episodic-task', title: '数据库调研', titleFts: seg('数据库调研'), content: seg('最终选择SQLite因为轻量嵌入式'), importance: 0.8, taskId: 't2', dedupKey: 'task:t2' })
repo.upsert({ channelId: 'ch1', agentId: 'a2', kind: 'episodic-task', title: '他人记忆', titleFts: seg('他人记忆'), content: seg('别的agent的登录杂事'), importance: 0.8, taskId: 't3', dedupKey: 'task:t3' })

const hit = repo.search('a1', `${seg('登录').trim()} OR oauth`, 5)
check('FTS 中英混合检索命中(经 titleFts)', hit.length >= 1 && hit[0].title === '实现登录页面', `hits=${hit.length}`)
check('展示 title 保持原文(未切分)', hit[0]?.title === '实现登录页面')
check('FTS 不串他人私有记忆', hit.every(r => r.agentId === 'a1'))

// ---- repo:team 域预埋(search 恒含 team 行)----
repo.upsert({ channelId: 'ch1', agentId: TEAM_AGENT_ID, kind: 'semantic', title: 'channel 代码风格', titleFts: seg('channel 代码风格'), content: seg('全部使用TypeScript strict模式'), importance: 0.9, taskId: null, dedupKey: 'style:ts' })
const teamQuery = seg('代码风格').trim().split(/\s+/).join(' OR ')  // → '代 OR 码 OR 风 OR 格'
const teamHit = repo.search('a1', teamQuery, 5)
check('team 记忆对所有 agent 可见(经 titleFts 命中)', teamHit.some(r => r.agentId === TEAM_AGENT_ID))
check('listRecent 严格本人(不含 team)', !repo.listRecent('a1', 10).some(r => r.agentId === TEAM_AGENT_ID))

// ---- repo:去重 upsert ----
repo.upsert({ channelId: 'ch1', agentId: 'a1', kind: 'episodic-task', title: '实现登录页面', titleFts: seg('实现登录页面'), content: seg('重跑后改用JWT方案'), importance: 0.8, taskId: 't1', dedupKey: 'task:t1' })
check('同 dedupKey 去重', repo.listByAgent('a1', 10).length === 2)
check('upsert 刷新后 FTS 同步', repo.search('a1', 'jwt', 5).length === 1)
const dedup = repo.findByAgentDedup('a1', 'task:t1')
check('findByAgentDedup 返回 id+rowid', dedup !== null && typeof dedup.rowid === 'number')

// ---- repo:touch + delete ----
repo.touch(dedup!.id)
check('touch 递增 access_count', repo.listByAgent('a1', 10).find(r => r.id === dedup!.id)!.accessCount >= 1)
const teamDel = repo.findByAgentDedup(TEAM_AGENT_ID, 'style:ts')!
check('team 行去重键独立', teamDel !== null)
check('delete 返回 true 且 FTS 同步清理', repo.delete(dedup!.id) === true && repo.search('a1', 'jwt', 5).length === 0)
check('listMemoryAgentIds 排除 team', repo.listMemoryAgentIds().includes(TEAM_AGENT_ID) === false)

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx scripts/test-memory.ts`
Expected: FAIL —— `Cannot find module '../server/services/workshop/db/memory.repo'`

- [ ] **Step 3: schema 两处同步**

`schema.sql` 尾部追加(同时原样追加到 `database.ts` 的 `SCHEMA_SQL` 尾部):

```sql

-- v6:Agent 持久记忆(agent_memories)+ FTS5 全文索引。
-- per-agent 记忆域(agent_id 过滤隔离);团队共享行 agent_id='__team__'(常量 TEAM_AGENT_ID)。
-- dedup_key 唯一约束去重:任务 'task:<id>' / 协作 'peer:<msgId>' / 策展 'manual:<uuid>' / 团队任意。
-- kind:episodic-task/episodic-peer(harvest)/semantic(REST 人工策展,衰减豁免)。
-- vec0 向量表不在此建:需 sqlite-vec 扩展且维度运行时才知(P1 Task 7 延迟建)。

CREATE TABLE IF NOT EXISTS agent_memories (
  id               TEXT PRIMARY KEY,
  channel_id       TEXT NOT NULL,
  agent_id         TEXT NOT NULL,
  kind             TEXT NOT NULL,
  title            TEXT NOT NULL,               -- 原文,供展示
  title_fts        TEXT NOT NULL DEFAULT '',    -- CJK 切分副本,FTS 索引用(V8)
  content          TEXT NOT NULL,               -- 已 CJK 切分的存储文本
  importance       REAL NOT NULL DEFAULT 0.5,
  task_id          TEXT,
  dedup_key        TEXT NOT NULL,
  access_count     INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT,
  created_at       TEXT NOT NULL,
  UNIQUE(agent_id, dedup_key)
);
CREATE INDEX IF NOT EXISTS idx_memories_agent ON agent_memories(agent_id, created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS agent_memories_fts USING fts5(
  title, content, agent_id UNINDEXED, memory_rowid UNINDEXED
);
CREATE TRIGGER IF NOT EXISTS trg_agent_memories_ai AFTER INSERT ON agent_memories BEGIN
  INSERT INTO agent_memories_fts(title, content, agent_id, memory_rowid)
  VALUES (new.title_fts, new.content, new.agent_id, new.rowid);
END;
CREATE TRIGGER IF NOT EXISTS trg_agent_memories_ad AFTER DELETE ON agent_memories BEGIN
  DELETE FROM agent_memories_fts WHERE memory_rowid = old.rowid;
END;
CREATE TRIGGER IF NOT EXISTS trg_agent_memories_au AFTER UPDATE ON agent_memories BEGIN
  DELETE FROM agent_memories_fts WHERE memory_rowid = old.rowid;
  INSERT INTO agent_memories_fts(title, content, agent_id, memory_rowid)
  VALUES (new.title_fts, new.content, new.agent_id, new.rowid);
END;
```

`database.ts`:文件头注释加 `* - agent_memories: Agent 持久记忆(FTS5 索引,per-agent 域 + team 共享)`;`TeamMemberRow` 后加:

```ts
/** agent_memories 表行(content 为已 CJK 切分存储文本;agentId='__team__' 为团队共享行) */
export interface MemoryRow {
  id: string
  channelId: string
  agentId: string
  kind: 'episodic-task' | 'episodic-peer' | 'semantic'
  title: string
  content: string
  importance: number
  taskId: string | null
  accessCount: number
  lastAccessedAt: string | null
  createdAt: string
}
```

- [ ] **Step 4: 写 memory.repo.ts**

```ts
/**
 * Memory 仓储:agent_memories(持久记忆)+ FTS5 全文索引。
 * upsert 经 (agent_id, dedup_key) 去重(AFTER UPDATE 触发器同步 FTS);
 * search 的 bm25 检索恒含团队共享行(agent_id='__team__');list* 严格本人。
 * 向量方法(vec*)在 P1 扩展;本文件保持纯 node:sqlite 同步。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { MemoryRow } from './database'

/** 团队共享记忆域 sentinel(单 channel 内全员可读) */
export const TEAM_AGENT_ID = '__team__'

export interface MemoryUpsertInput {
  channelId: string
  agentId: string
  kind: 'episodic-task' | 'episodic-peer' | 'semantic'
  title: string
  /** title 的 CJK 切分副本(FTS 索引用;调用方经 AgentMemory.segmentCJK 处理,V8) */
  titleFts: string
  /** 已 CJK 单字切分的存储文本(AgentMemory.segmentCJK 处理) */
  content: string
  importance: number
  taskId?: string | null
  dedupKey: string
}

export type MemoryRepo = ReturnType<typeof createMemoryRepo>

const COLS = `m.id, m.channel_id AS channelId, m.agent_id AS agentId, m.kind, m.title, m.content,
  m.importance, m.task_id AS taskId, m.access_count AS accessCount,
  m.last_accessed_at AS lastAccessedAt, m.created_at AS createdAt`

export function createMemoryRepo(db: DatabaseSync) {
  const upsertStmt = db.prepare(
    `INSERT INTO agent_memories
       (id, channel_id, agent_id, kind, title, title_fts, content, importance, task_id, dedup_key, access_count, last_accessed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
     ON CONFLICT(agent_id, dedup_key) DO UPDATE SET
       kind = excluded.kind, title = excluded.title, title_fts = excluded.title_fts,
       content = excluded.content, importance = excluded.importance, created_at = excluded.created_at`,
  )
  const searchStmt = db.prepare(
    `SELECT ${COLS}, f.rank AS bm25
     FROM agent_memories_fts f
     JOIN agent_memories m ON m.rowid = f.memory_rowid
     WHERE agent_memories_fts MATCH ? AND m.agent_id IN (?, ?)
     ORDER BY f.rank LIMIT ?`,
  )
  const listRecentStmt = db.prepare(
    `SELECT id, channel_id AS channelId, agent_id AS agentId, kind, title, content,
            importance, task_id AS taskId, access_count AS accessCount,
            last_accessed_at AS lastAccessedAt, created_at AS createdAt
     FROM agent_memories WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`,
  )
  const findByDedupStmt = db.prepare(
    `SELECT id, rowid FROM agent_memories WHERE agent_id = ? AND dedup_key = ?`,
  )
  const touchStmt = db.prepare(
    `UPDATE agent_memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`,
  )
  const deleteStmt = db.prepare(`DELETE FROM agent_memories WHERE id = ?`)
  const agentIdsStmt = db.prepare(
    `SELECT DISTINCT agent_id FROM agent_memories WHERE agent_id != ?`,
  )

  return {
    upsert(input: MemoryUpsertInput): void {
      upsertStmt.run(
        randomUUID(), input.channelId, input.agentId, input.kind,
        input.title, input.titleFts, input.content, input.importance,
        input.taskId ?? null, input.dedupKey, new Date().toISOString(),
      )
    },

    /** bm25 检索(恒含 team 共享行;matchQuery 为 OR 连接切分词) */
    search(agentId: string, matchQuery: string, limit: number): Array<MemoryRow & { bm25: number }> {
      return searchStmt.all(matchQuery, agentId, TEAM_AGENT_ID, limit)
        as unknown as Array<MemoryRow & { bm25: number }>
    },

    listRecent(agentId: string, limit: number): MemoryRow[] {
      return listRecentStmt.all(agentId, limit) as unknown as MemoryRow[]
    },

    listByAgent(agentId: string, limit: number): MemoryRow[] {
      return listRecentStmt.all(agentId, limit) as unknown as MemoryRow[]
    },

    /** upsert 后取定位置(供向量写回 rowid) */
    findByAgentDedup(agentId: string, dedupKey: string): { id: string, rowid: number } | null {
      return (findByDedupStmt.get(agentId, dedupKey) as { id: string, rowid: number } | undefined) ?? null
    },

    touch(id: string): void {
      touchStmt.run(new Date().toISOString(), id)
    },

    /** 删除(FTS 触发器自动清理;向量行由上层先 vecDelete);返回是否删除 */
    delete(id: string): boolean {
      return deleteStmt.run(id).changes > 0
    },

    /** 有记忆的 agent 清单(维护任务迭代;排除 team) */
    listMemoryAgentIds(): string[] {
      return (agentIdsStmt.all(TEAM_AGENT_ID) as Array<{ agent_id: string }>).map(r => r.agent_id)
    },
  }
}
```

注意:`listRecentStmt` 的 COLS 复用拼接以可读为先——若模板串拼接出错,直接写完整列名(实现时以实际列别名对齐 MemoryRow 为准,tsc 会兜底)。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx tsx scripts/test-memory.ts`
Expected: `ALL PASS`(13 项)

- [ ] **Step 6: Commit**

```bash
git add server/services/workshop/db/schema.sql server/services/workshop/db/database.ts server/services/workshop/db/memory.repo.ts scripts/test-memory.ts
git commit -m "feat(workshop): v6 agent_memories 表与 FTS5 仓储(预埋 team 域与 semantic 类)"
```

---

### Task 2: AgentMemory 模块(async 签名定型)

**Files:**
- Create: `server/services/workshop/runtime/memory.ts`
- Modify: `scripts/test-memory.ts`(追加模块段)

**Interfaces:**
- Consumes: Task 1 `MemoryRepo`、`TEAM_AGENT_ID`
- Produces: `new AgentMemory(repo, { channelId, agentId, budgetTokens?, embedder? })`;`recall(query: string, opts?: { touch?: boolean }): Promise<string | null>`;`recordTaskOutcome(task: WorkspaceTask): Promise<void>`;`recordPeerExchange(msg: A2AMessage, replyText: string): Promise<void>`;导出 `buildMatchQuery/estimateTokens/segmentCJK`(P1 再扩 `EmbeddingProvider` 注入位,P0 embedder 参数预留但默认无)

- [ ] **Step 1: 写失败测试(模块段,插在汇总块前)**

```ts
// ═══════════ 模块:AgentMemory ═══════════
console.log('\n--- AgentMemory 模块 ---')
import { AgentMemory, buildMatchQuery, estimateTokens, segmentCJK } from '../server/services/workshop/runtime/memory'

check('segmentCJK 汉字间加空格', segmentCJK('登录oauth') === ' 登 录 oauth')
check('buildMatchQuery OR 连接 + 剔除操作符/保留词', buildMatchQuery('登录 (页面) AND not') === '登 OR 录 OR 页 OR 面')
check('buildMatchQuery 空查询 null', buildMatchQuery('   ') === null)
check('buildMatchQuery ASCII 单字词过滤', buildMatchQuery('a b oauth') === 'oauth')
check('estimateTokens 中英混合', estimateTokens('登录ab') === 3)

const memA = new AgentMemory(repo, { channelId: 'ch1', agentId: 'a1' })
// 查询同时含本人记忆与 team 记忆的词(两者都经 FTS 命中;listRecent 兜底不含 team)
const block = await memA.recall('登录页面 代码风格')
check('recall 含本人相关记忆', block !== null && block.includes('实现登录页面'))
check('recall 含 team 共享记忆', block !== null && block.includes('channel 代码风格'), block?.slice(0, 100))
check('recall 不含他人私有记忆', block !== null && !block.includes('他人记忆'))
const t1row = repo.listByAgent('a1', 10).find(r => r.title === '实现登录页面')
check('recall 默认 touch', t1row !== undefined && t1row.accessCount >= 1)
await memA.recall('数据库', { touch: false })
check('touch:false 不改 access_count', repo.listByAgent('a1', 10).find(r => r.title === '数据库调研')!.accessCount === 0)

const memTiny = new AgentMemory(repo, { channelId: 'ch1', agentId: 'a1', budgetTokens: 5 })
const tiny = await memTiny.recall('登录 数据库')
check('极小预算整行取舍', tiny === null || tiny.split('\n').length <= 3)

const memEmpty = new AgentMemory(repo, { channelId: 'ch1', agentId: 'nobody' })
check('无记忆 recall 返回 null', (await memEmpty.recall('任意')) === null)
```

(汇总 `console.log/exit` 块移到最后;`process.exit` 前需 `await` 已完成的 Promise——recall 均已 await,无需改动进程退出。)

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx scripts/test-memory.ts` → FAIL: `Cannot find module '../server/services/workshop/runtime/memory'`

- [ ] **Step 3: 写 memory.ts**

```ts
/**
 * AgentMemory — AgentRuntime 的持久记忆模块(harness 无关)。
 * MemGPT 分层(长期记忆落库+预算召回)/ Mem0 harvest(complete_task 自产摘要零 LLM 成本)/
 * agent-memory 排序装配(0.5×相关性+0.3×时近性+0.2×重要性,贪心预算)。
 * P1 注入 embedder 后 recall 升级混合检索;P0 纯 FTS。全部方法 async(async 签名 P0 定型)。
 */
import type { MemoryRepo } from '../db/memory.repo'
import type { MemoryRow } from '../db/database'
import type { WorkspaceTask } from '../types/task'
import type { A2AMessage, Part } from '../types/a2'

const W_RELEVANCE = 0.5
const W_RECENCY = 0.3
const W_IMPORTANCE = 0.2
const RECENCY_DAYS = 7
const RECENT_FALLBACK = 5
const WEAK_HIT_KEEP = 3
const MAX_TERMS = 12
const CONTENT_STORE_LIMIT = 800

export interface AgentMemoryOptions {
  channelId: string
  agentId: string
  budgetTokens?: number
}

export interface RecallOptions {
  /** 默认 true;supervise 每 tick 调用应传 false 防 access_count 通胀 */
  touch?: boolean
}

export function segmentCJK(text: string): string {
  return text.replace(/([\u4e00-\u9fff])/g, ' $1 ')
}

export function buildMatchQuery(text: string): string | null {
  const cleaned = text.replace(/["'*():+-]/g, ' ').toLowerCase()
  const terms = segmentCJK(cleaned)
    .split(/\s+/)
    .filter(Boolean)
    .filter(t => /[\u4e00-\u9fff]/.test(t) || t.length >= 2)
    .filter(t => !['and', 'or', 'not', 'near'].includes(t))
    .slice(0, MAX_TERMS)
  return terms.length > 0 ? terms.join(' OR ') : null
}

export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  return Math.ceil((text.length - cjk) / 4) + cjk
}

function partsText(parts: Part[]): string {
  return parts.map(p => ('text' in p ? p.text : '')).filter(Boolean).join('\n')
}

function humanAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  if (Number.isNaN(ms)) return '?'
  if (ms < 60_000) return '刚刚'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}分钟前`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}小时前`
  return `${Math.floor(ms / 86_400_000)}天前`
}

export class AgentMemory {
  constructor(
    private repo: MemoryRepo,
    private opts: AgentMemoryOptions,
  ) {}

  /** run/supervise 前:混合检索+排序+预算装配 → 记忆块(null=无记忆不注入) */
  async recall(query: string, recallOpts: RecallOptions = {}): Promise<string | null> {
    const doTouch = recallOpts.touch !== false
    const budget = this.opts.budgetTokens ?? Number(process.env.AW_MEMORY_BUDGET_TOKENS ?? 800)
    const hits = new Map<string, { row: MemoryRow, relevance: number }>()

    const match = buildMatchQuery(query)
    if (match) {
      const found = this.repo.search(this.opts.agentId, match, MAX_TERMS)
      const best = found.length > 0 ? Math.max(-found[0].bm25, 0.001) : 1
      found.forEach((row, i) => {
        const rel = Math.min(1, -row.bm25 / best)
        if (rel >= 0.1 || i < WEAK_HIT_KEEP) hits.set(row.id, { row, relevance: rel })
      })
    }
    for (const row of this.repo.listRecent(this.opts.agentId, RECENT_FALLBACK)) {
      if (!hits.has(row.id)) hits.set(row.id, { row, relevance: 0.15 })
    }
    if (hits.size === 0) return null

    const scored = [...hits.values()]
      .map(h => ({ ...h, score: this.score(h.row, h.relevance) }))
      .sort((a, b) => b.score - a.score)

    const lines: string[] = []
    const touched: string[] = []
    let used = 0
    for (const s of scored) {
      const line = this.formatLine(s.row)
      const cost = estimateTokens(line)
      if (used + cost > budget) continue
      used += cost
      lines.push(line)
      if (doTouch) touched.push(s.row.id)
    }
    if (lines.length === 0) return null
    for (const id of touched) this.repo.touch(id)
    return [`## 相关记忆(本 Agent 历史作业沉淀;与当前任务冲突时,以当前任务为准)`, ...lines].join('\n')
  }

  /** run 后(任务路径;仅终态调用):harvest TaskEngine 终态 + deliverable */
  async recordTaskOutcome(task: WorkspaceTask): Promise<void> {
    const deliverable = task.artifacts
      .filter(a => a.name === 'deliverable' || a.name === 'summary')
      .flatMap(a => a.parts)
      .map(p => ('text' in p ? p.text : ''))
      .join(' ')
      .trim()
    const content = deliverable || task.description || task.title
    this.repo.upsert({
      channelId: this.opts.channelId,
      agentId: this.opts.agentId,
      kind: 'episodic-task',
      title: task.title,
      titleFts: segmentCJK(task.title),
      content: segmentCJK(content).slice(0, CONTENT_STORE_LIMIT),
      importance: task.state === 'COMPLETED' ? 0.8 : 0.55,
      taskId: task.id,
      dedupKey: `task:${task.id}`,
    })
  }

  /** run 后(点对点路径):请求 + 我方回复摘要 */
  async recordPeerExchange(msg: A2AMessage, replyText: string): Promise<void> {
    const ask = partsText(msg.parts).slice(0, 150)
    const content = replyText ? `问:${ask} 答:${replyText.slice(0, 250)}` : ask
    const title = `来自 ${msg.fromAgentId ?? 'unknown'} 的消息`
    this.repo.upsert({
      channelId: this.opts.channelId,
      agentId: this.opts.agentId,
      kind: 'episodic-peer',
      title,
      titleFts: segmentCJK(title),
      content: segmentCJK(content).slice(0, 600),
      importance: 0.4,
      taskId: msg.taskId ?? null,
      dedupKey: `peer:${msg.messageId}`,
    })
  }

  private score(row: MemoryRow, relevance: number): number {
    const ageDays = (Date.now() - Date.parse(row.createdAt)) / 86_400_000
    const recency = Math.exp(-ageDays / RECENCY_DAYS)
    const importance = Math.min(1, row.importance + row.accessCount * 0.05)
    return W_RELEVANCE * relevance + W_RECENCY * recency + W_IMPORTANCE * importance
  }

  private formatLine(row: MemoryRow): string {
    const tag = row.kind === 'episodic-task' ? '任务'
      : row.kind === 'episodic-peer' ? '协作' : '共享'
    const content = row.content.length > 240 ? `${row.content.slice(0, 240)}…` : row.content
    return `- [${humanAgo(row.createdAt)}·${tag}] ${row.title}:${content}`
  }
}
```

- [ ] **Step 4: 跑测试通过 → Step 5: Commit**

```bash
git add server/services/workshop/runtime/memory.ts scripts/test-memory.ts
git commit -m "feat(workshop): agentmemory 模块(排序/预算/装配,async 签名定型)"
```

---

### Task 3: 契约 + AgentRuntime 召回/沉淀

**Files:**
- Modify: `server/services/workshop/agents/agent-interface.ts`(AgentRunRequest.memory)
- Modify: `server/services/workshop/runtime/agent-runtime.ts`(deps.memory + await recall + 回复收集 + 沉淀)
- Modify: `scripts/test-memory.ts`(追加运行时段)

**Interfaces:**
- Produces: `AgentRunRequest.memory?: string`;`AgentRuntimeDeps.memory?: AgentMemory`(可选,零记忆向后兼容)
- [ ] **Step 1: 写失败测试(运行时段;照抄 test-agent-runtime.ts 惯例,V10/V11)**

`scripts/test-memory.ts` 追加(汇总块前)。关键点:先 `seedChannel`(messages 外键,V10);`AgentInfo` 用 `id` 字段;fake engine 照抄 `makeFakeEngine`(test-agent-runtime.ts:88-146);**workspace 不能是 `{}`**——EchoImpl 会调 `ctx.workspace.completeTask`,用 stub 经 fake engine `transition` 驱动 COMPLETED:

```ts
// ═══════════ 运行时集成:召回注入 + 结束沉淀 ═══════════
console.log('\n--- AgentRuntime 记忆集成 ---')
import { Mailbox } from '../server/services/workshop/runtime/mailbox'
import { AgentRuntime } from '../server/services/workshop/runtime/agent-runtime'
import type { ChannelBus, TaskEngine } from '../server/services/workshop/runtime/agent-runtime'
import type { AgentEvent, AgentInterface, AgentInfo, AgentRunContext, AgentRunRequest, AgentWorkspace } from '../server/services/workshop/agents/agent-interface'
import type { WorkspaceTask, TaskState, AgentTaskQueueView } from '../server/services/workshop/types/task'
import type { Part } from '../server/services/workshop/types/a2'
import { AgentMemory } from '../server/services/workshop/runtime/memory'

seedChannel(db, 'ch-mem')  // messages.channel_id 外键依赖(V10);seedChannel 照抄 test-agent-runtime.ts:55-60

const memBus: ChannelBus = {
  emit: () => {}, onEvent: () => () => {}, notifyTask: () => {}, onTaskEvent: () => () => {},
  notifyAgent: () => {}, onAgentStatus: () => () => {}, wakeScheduler: () => {},
}
// fake engine(照抄 makeFakeEngine 惯例;complete() 会 throw → 完成态经 transition 驱动)
const memTasks = new Map<string, WorkspaceTask>()
const fakeEngine: TaskEngine = {
  create: (input: { channelId: string, creatorId: string, assigneeId: string, title: string }) => {
    const t: WorkspaceTask = { id: randomUUID(), channelId: input.channelId, assigneeId: input.assigneeId, creatorId: input.creatorId, title: input.title, state: 'SUBMITTED', progress: 0, retryCount: 0, artifacts: [], history: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    memTasks.set(t.id, t)
    return t
  },
  dispatch: () => { throw new Error('unused') },
  transition: (taskId: string, state: TaskState) => { const t = memTasks.get(taskId); if (t) t.state = state; return t! },
  applyEvent: () => {},
  list: () => [...memTasks.values()],
  get: (id: string) => memTasks.get(id),
  complete: () => { throw new Error('unused') },
  reassign: () => { throw new Error('unused') },
  cancel: () => { throw new Error('unused') },
  onChildCompleted: () => {},
  queueViewOf: (channelId: string, agentId: string): AgentTaskQueueView => ({ agentId, channelId, queued: [], completed: [] }),
} as TaskEngine
// workspace stub:EchoImpl 的 completeTask 经 transition 落 COMPLETED(终态判定依赖)
const wsStub = (agentId: string): AgentWorkspace => ({
  completeTask: async (taskId: string, artifacts) => {
    const t = memTasks.get(taskId)
    if (t) { t.artifacts = [...t.artifacts, ...artifacts]; t.progress = 100; fakeEngine.transition(taskId, 'COMPLETED') }
    return t!
  },
}) as AgentWorkspace
void wsStub

class MemoryEchoImpl implements AgentInterface {
  readonly captured: AgentRunRequest[] = []
  async *run(request: AgentRunRequest, ctx: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown> {
    this.captured.push(request)
    const taskId = request.taskId ?? (request.message.metadata?.['x-aw-task-id'] as string | undefined)
    if (taskId && ctx.role === 'worker') {
      yield { kind: 'status', status: { state: 'WORKING', timestamp: new Date().toISOString() } }
      await (ctx.workspace as { completeTask: (id: string, arts: unknown[]) => Promise<unknown> }).completeTask(taskId, [])
      yield { kind: 'artifact', artifact: { artifactId: randomUUID(), name: 'deliverable', parts: [{ text: `memory-seen:${request.memory ?? 'NONE'}` }] }, lastChunk: true, totalChunks: 1 }
      yield { kind: 'done', final: { taskId } }
    }
  }
}

const mkRt = (id: string): { rt: AgentRuntime, echo: MemoryEchoImpl } => {
  const info: AgentInfo = { id, channelId: 'ch-mem', name: id, harness: 'mock', role: 'worker', config: {} }
  const echo = new MemoryEchoImpl()
  const rt = new AgentRuntime(info, echo, {
    mailbox: new Mailbox(createMessageRepo(db), 'ch-mem', id, () => {}),
    taskEngine: fakeEngine,
    bus: memBus,
    workspace: wsStub(id),
    memory: new AgentMemory(repo, { channelId: 'ch-mem', agentId: id }),
  })
  rt.start()
  return { rt, echo }
}
const mkAssign = (task: WorkspaceTask): Part[] => [{ text: task.title }]
const enqueueAssign = (rt: AgentRuntime, task: WorkspaceTask): void => {
  rt.enqueue({ messageId: randomUUID(), contextId: 'ch-mem', role: 'ROLE_AGENT', taskId: task.id, fromAgentId: 'lead', parts: mkAssign(task), metadata: { 'x-aw-task-kind': 'assign', 'x-aw-task-id': task.id } })
}

const { rt: rtA, echo: echoA } = mkRt('w-mem')
const taskA = fakeEngine.create({ channelId: 'ch-mem', creatorId: 'lead', assigneeId: 'w-mem', title: '实现登录页面' })
enqueueAssign(rtA, taskA)
await new Promise<void>(r => setTimeout(r, 300))
check('任务 A 首跑无记忆注入', echoA.captured.at(-1)?.memory === undefined)
const aRow = repo.listByAgent('w-mem', 10).find(r => r.taskId === taskA.id)
check('任务 A 完成后沉淀记忆(含 deliverable)', aRow !== undefined && aRow.content.includes('memory-seen:NONE'), aRow?.content.slice(0, 60))
check('任务 A 记忆 importance=0.8(COMPLETED)', aRow?.importance === 0.8)

const taskB = fakeEngine.create({ channelId: 'ch-mem', creatorId: 'lead', assigneeId: 'w-mem', title: '登录模块优化' })
enqueueAssign(rtA, taskB)
await new Promise<void>(r => setTimeout(r, 300))
const secondReq = echoA.captured.at(-1)
check('任务 B 召回注入 A 的记忆(经 title_fts 相关命中)', secondReq?.memory !== undefined && secondReq.memory.includes('实现登录页面'), secondReq?.memory?.slice(0, 80))
check('记忆块带 prompt 标题头', (secondReq?.memory ?? '').startsWith('## 相关记忆'))

const { rt: rtO, echo: echoO } = mkRt('w-other')
const taskC = fakeEngine.create({ channelId: 'ch-mem', creatorId: 'lead', assigneeId: 'w-other', title: '登录鉴权怎么做' })
enqueueAssign(rtO, taskC)
await new Promise<void>(r => setTimeout(r, 300))
check('跨 agent 记忆隔离(w-other 召回不到 w-mem)', echoO.captured.at(-1)?.memory === undefined)

await rtA.stop()
await rtO.stop()
```

(TaskEngine 接口若与上面 stub 有签名出入,以 `agent-runtime.ts` 的 `TaskEngine` interface 为准补齐成员;断言不变。)


- [ ] **Step 2: 跑测试确认失败** → `AgentRuntimeDeps` 无 `memory`

- [ ] **Step 3: 实现**

`agent-interface.ts` AgentRunRequest 尾部:

```ts
  /** 平台记忆系统装配的历史上下文块(可选;harness 自主决定是否注入 prompt) */
  memory?: string
```

`agent-runtime.ts`:
1. `import type { AgentMemory } from './memory'`;deps 加 `memory?: AgentMemory`
2. 类外 helper:`function partsToText(parts: Part[]): string { return parts.map(p => ('text' in p ? p.text : '')).filter(Boolean).join('\n') }`
3. `processMessage` 内 `toRequest` 前:

```ts
      // 记忆召回(异常不阻塞)
      let memoryBlock: string | undefined
      try {
        memoryBlock = (await this.deps.memory?.recall(partsToText(msg.parts))) ?? undefined
      }
      catch (err) {
        console.error(`[AgentRuntime:${this.agentId}] 记忆召回失败:`, err)
      }
      const request: AgentRunRequest = this.toRequest(msg, memoryBlock)
```

4. 事件循环收集回复文本(**V9:omp 不产 message 事件,须聚合三类源**——`message` 事件 / `status.message` / 终态 artifact 'output'):

```ts
      let replyText = ''
      const cap = (text: string): void => {
        if (replyText.length < 400) replyText += text.slice(0, 400 - replyText.length)
      }
      for await (const event of this.impl.run(request, ctx)) {
        this.deps.bus.emit(event, enrichedSource)
        if (taskId) await this.deps.taskEngine.applyEvent(taskId, event)
        if (event.kind === 'message') cap(partsToText(event.message.parts))
        else if (event.kind === 'status' && event.status.message) cap(partsToText(event.status.message.parts))
        else if (event.kind === 'artifact' && event.artifact.name === 'output') cap(partsToText(event.artifact.parts))
      }
```


5. 隐式收口块之后、try 尾部:

```ts
      // 记忆沉淀:终态任务 harvest;无 taskId 的点对点消息记协作(异常不阻塞)
      if (this.deps.memory) {
        try {
          const task = taskId ? this.deps.taskEngine.get(taskId) : undefined
          if (task && TERMINAL_TASK_STATES[task.state]) {
            await this.deps.memory.recordTaskOutcome(task)
          }
          else if (!taskId && msg.fromAgentId) {
            await this.deps.memory.recordPeerExchange(msg, replyText)
          }
        }
        catch (err) {
          console.error(`[AgentRuntime:${this.agentId}] 记忆写入失败:`, err)
        }
      }
```

6. `toRequest(msg, memory?)` 实现带 `memory` 字段(v1 plan 原文)。

- [ ] **Step 4: `npx tsx scripts/test-memory.ts` → ALL PASS**
- [ ] **Step 5: `npx tsx scripts/test-agent-runtime.ts` → ALL PASS(回归)**
- [ ] **Step 6: Commit**

```bash
git add server/services/workshop/agents/agent-interface.ts server/services/workshop/runtime/agent-runtime.ts scripts/test-memory.ts
git commit -m "feat(workshop): 运行时记忆召回注入与终态沉淀(request.memory 契约)"
```

---

### Task 4: omp-agent run 路径注入

**Files:** Modify: `server/services/workshop/agents/omp-agent.ts`

- [ ] **Step 1:** `workerRun` 传 `request.memory` → `buildWorkerPrompt(taskId, taskText, memory)`;prompt 构造在 prefix 后插 `if (memory) parts.push(memory)`(v1 plan Task 4 原文)
- [ ] **Step 2:** `peerMessageRun` 的 `lines` 中 roleLine 后插 `...(request.memory ? ['', request.memory] : [])`
- [ ] **Step 3:** 验证:`npx tsc --noEmit -p .nuxt/tsconfig.server.json` 0 error;`npx tsx scripts/test-agent-runtime.ts` ALL PASS
- [ ] **Step 4: Commit** `feat(workshop): omp harness run 路径注入记忆块`

---

### Task 5: Manager 装配 + REST 读端点 + scripts codemod

**Files:**
- Modify: `server/services/workshop/runtime/manager.ts`(AllRepos.memories + wireMember + listMemories)
- Modify: `server/plugins/workshop.ts`(repos 装配)
- Modify: `scripts/*.ts`(~20 处,EOL 感知 codemod:属性 `memories: createMemoryRepo(db)` + import)
- Create: `server/api/workshop/channels/[id]/agents/[agentId]/memories/index.get.ts`

**要点(沿用 v1 plan Task 5 全部步骤,差异如下):**
- `AllRepos` 加 `memories: MemoryRepo`(import `createMemoryRepo`/`MemoryRepo` from `../db/memory.repo`)
- `wireMember`:`const memory = new AgentMemory(this.deps.repos.memories, { channelId: m.channelId, agentId: agent.id })` 传入 runtime deps
- `listMemories(channelId, agentId, limit = 50): MemoryRow[]`:实例存在校验(AppError 404)+ `repos.memories.listByAgent(agentId, limit)`
- REST GET 端点:先 `resolveCallerOrNull`;有 token 且为本 channel 成员 → 返回列表(私有观察面);无 token → 401(与 mailbox.get.ts 同语义;import 深度参照同目录现有文件)
- codemod 脚本:EOL 感知(`\r\n` 检测),属性插入 + import 插入一次完成;执行后 `grep -c 'createMemoryRepo(' scripts/*.ts | grep -v ':0'` 核对(注意 import 行含 1 次、属性 1 次,每文件应为 2)
- 回归:`npx tsx scripts/test-full-system.ts && npx tsx scripts/test-memory.ts` 全 PASS + server tsc 0 error
- Commit: `feat(workshop): manager 装配 agentmemory 与记忆只读端点`

---

### Task 6: P0 收尾回归

- [ ] `npx tsx scripts/test-memory.ts && npx tsx scripts/test-full-system.ts && npx tsx scripts/test-orchestration.ts` 全 PASS
- [ ] 可选真实冒烟:`npx tsx scripts/e2e-omp-workspace.ts`(观察 prompt 出现 `## 相关记忆`)
- [ ] Commit: `test(workshop): 记忆管线 P0 全量回归`

---

# Phase P1 —— 向量语义检索(sqlite-vec + embedding provider)

### Task 7: sqlite-vec 加载 + repo vec 方法 + embedding provider

**Files:**
- Modify: `package.json`(`pnpm add sqlite-vec`)
- Modify: `server/services/workshop/db/database.ts`(openWorkshopDb 允许扩展 + 尝试加载)
- Modify: `server/services/workshop/db/memory.repo.ts`(vec* 方法)
- Create: `server/services/workshop/runtime/embedding-provider.ts`
- Create: `scripts/test-memory-vector.ts`

**Interfaces:**
- Produces: `openWorkshopDb(path)` 内部 `{ allowExtension: true }` + try loadExtension(失败静默降级);repo 增:`vecInit(dims: number): boolean`(建 vec0 表;已存在且维度不符返回 false)、`vecSet(rowid: number, agentId: string, vec: Float32Array): void`(按 mem_rowid 刷新语义)、`vecDelete(rowid: number): void`、`vecSearch(agentId: string, vec: Float32Array, k: number): Array<{ memRowid: number, distance: number }>`、`vecReady: boolean`(只读状态);`embedding-provider.ts` 导出 `EmbeddingProvider` 接口 `{ embed(texts: string[]): Promise<Float32Array[]>, dims(): number | null }`、`createEnvEmbeddingProvider(): EmbeddingProvider | null`(env 未配置返回 null)、`createHashEmbeddingProvider(dims: number): EmbeddingProvider`(测试用确定性 provider)

**已实测的关键实现事实(V4-V7,写死在代码注释):**
- vec0 DDL:`CREATE VIRTUAL TABLE agent_memories_vec USING vec0(embedding float[?], agent_id TEXT partition key, +mem_rowid INTEGER)` — 显式 rowid 插入在分区表**不可用**,必须辅助列映射
- 一切整数绑定必须 `BigInt(n)`(node:sqlite number→REAL)
- 刷新 = `SELECT rowid FROM vec WHERE mem_rowid = ?` → DELETE → 重插
- kNN = `SELECT mem_rowid, distance FROM vec WHERE agent_id = ? AND embedding MATCH ? AND k = ?`

- [ ] **Step 1: 安装依赖 + 写失败测试**

```bash
pnpm add sqlite-vec
```

`scripts/test-memory-vector.ts` 核心(用 hash provider 不打真 API):

```ts
/**
 * 向量记忆管线测试:repo vec 方法(BigInt/分区/刷新)+ AgentMemory 混合召回。
 * 用确定性 hash provider(不打真 API);真实 provider 由 env 配置,e2e 可选验证。
 * 运行: npx tsx scripts/test-memory-vector.ts
 */
import type { DatabaseSync } from 'node:sqlite'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createMemoryRepo, TEAM_AGENT_ID } from '../server/services/workshop/db/memory.repo'
import { AgentMemory, segmentCJK } from '../server/services/workshop/runtime/memory'
import { createHashEmbeddingProvider } from '../server/services/workshop/runtime/embedding-provider'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const db: DatabaseSync = openWorkshopDb(':memory:')
const repo = createMemoryRepo(db)
const embedder = createHashEmbeddingProvider(8)

// vec 延迟建表(首次 embed 维度)
check('vecInit 首次建表', repo.vecInit(8) === true)
check('vecInit 幂等(同维度)', repo.vecInit(8) === true)
check('vecInit 维度不符拒绝(不重建)', repo.vecInit(4) === false)

const seed = async (agentId: string, title: string, content: string, key: string): Promise<void> => {
  repo.upsert({ channelId: 'ch1', agentId, kind: 'episodic-task', title, titleFts: segmentCJK(title), content: segmentCJK(content), importance: 0.8, taskId: key, dedupKey: `task:${key}` })
  const at = repo.findByAgentDedup(agentId, `task:${key}`)!
  const vec = (await embedder.embed([content]))[0]
  repo.vecSet(at.rowid, agentId, vec)
}
await seed('a1', '登录鉴权', '用OAuth2做了登录鉴权组件', 't1')
await seed('a1', '数据库调研', '选择SQLite作为存储', 't2')
await seed('a2', '他人登录杂事', '别的agent的登录内容', 't3')
await seed(TEAM_AGENT_ID, '团队规范', '本团队代码必须写测试', 'g1')

// 域隔离 kNN
const [qv] = await embedder.embed(['登录鉴权'])
const a1hits = repo.vecSearch('a1', qv, 5)
check('a1 向量命中本人记忆', a1hits.length >= 1 && a1hits.every(h => h.distance >= 0))
const teamHits = repo.vecSearch(TEAM_AGENT_ID, (await embedder.embed(['团队规范 测试']))[0], 5)
check('team 向量域命中', teamHits.length >= 1)

// 刷新语义:重写 t1 内容 + vecSet 覆盖

repo.upsert({ channelId: 'ch1', agentId: 'a1', kind: 'episodic-task', title: '登录鉴权', titleFts: segmentCJK('登录鉴权'), content: segmentCJK('重写为JWT方案'), importance: 0.8, taskId: 't1', dedupKey: 'task:t1' })
const refreshed = repo.vecSearch('a1', (await embedder.embed(['JWT方案']))[0], 5)
check('vecSet 刷新后旧向量被替换', refreshed.length >= 1)
const oldQ = repo.vecSearch('a1', (await embedder.embed(['OAuth2登录鉴权组件']))[0], 5)
check('旧向量不再命中(已替换)', oldQ.length === 0, `hits=${oldQ.length}`)

// vecDelete(删除记忆联动)
const t2at = repo.findByAgentDedup('a1', 'task:t2')!
repo.vecDelete(t2at.rowid)
check('vecDelete 后不命中', repo.vecSearch('a1', (await embedder.embed(['SQLite存储']))[0], 5).every(h => h.memRowid !== t2at.rowid))

// ---- AgentMemory 混合召回(embedder 注入)----
const mem = new AgentMemory(repo, { channelId: 'ch1', agentId: 'a1', budgetTokens: 2000, embedder })
const block = await mem.recall('登录鉴权怎么做的')
check('混合召回含相关本人记忆', block !== null && block.includes('登录鉴权'))
check('混合召回含 team 共享记忆', block !== null && block.includes('团队规范'))

// 语义召回(hash provider 下同词命中;真实 provider 下同义不同词也命中——管线同一条)
const sem = await mem.recall('鉴权 auth')
check('查询与记忆词面不同仍可召回(向量路径)', sem !== null)

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
```

(hash provider 说明:按词 hash 到定长向量,相同词集 → 相近向量;`鉴权 auth` 与 `鉴权` 共享"鉴权"维度 → 命中。设计为**词袋 hash**:每个词 hash 到一维 +1,归一化。)

- [ ] **Step 2: 跑测试确认失败** → `vecInit is not a function`

- [ ] **Step 3: 实现**

`database.ts` `openWorkshopDb`:

```ts
export function openWorkshopDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { allowExtension: true })
  // 尝试加载 sqlite-vec(向量检索);失败静默降级纯 FTS(受控环境可能禁扩展)
  try {
    const { getLoadablePath } = require('sqlite-vec') as typeof import('sqlite-vec')
    db.loadExtension(getLoadablePath())
  }
  catch {
    // 扩展不可用:记忆系统自动退化为 FTS-only(不做向量)
  }
  initWorkshopDb(db)
  return db
}
```

(注:若 lint 禁 `require`,改为顶部静态 `import { getLoadablePath } from 'sqlite-vec'` + try-catch 包 loadExtension;import 失败会导致整个模块崩,故用 require 动态引入保降级——以仓库 lint 规则定,二选一。)

`memory.repo.ts` 增(vec 分支,全部 BigInt):

```ts
  // ===== 向量方法(P1;vec0 分区表 + mem_rowid 辅助列映射,BigInt 绑定)=====
  let vecDims: number | null = null

  function vecEnsureTable(dims: number): boolean {
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS agent_memories_vec USING vec0(
        embedding float[${dims}], agent_id TEXT partition key, +mem_rowid INTEGER)`)
      // 维度校验:已存表若维度不同,INSERT 时会炸;建后试插试删探针
      db.prepare(`INSERT INTO agent_memories_vec(embedding, agent_id, mem_rowid) VALUES (?, ?, ?)`)
        .run(new Float32Array(dims), '__probe__', BigInt(-1))
      db.prepare(`DELETE FROM agent_memories_vec WHERE mem_rowid = ?`).run(BigInt(-1))
      return true
    }
    catch {
      return false
    }
  }

  // return 对象内追加:
  vecInit(dims: number): boolean {
    if (vecDims === dims) return true
    if (vecDims !== null) return false        // 已按其它维度建表,拒绝(禁用向量并 log)
    vecDims = dims
    return vecEnsureTable(dims)
  },
  get vecReady(): boolean { return vecDims !== null },
  vecSet(memRowid: number, agentId: string, vec: Float32Array): void {
    if (vecDims === null) return
    try {
      const old = db.prepare(`SELECT rowid FROM agent_memories_vec WHERE mem_rowid = ?`).get(BigInt(memRowid))
      if (old) db.prepare(`DELETE FROM agent_memories_vec WHERE rowid = ?`).run(BigInt((old as { rowid: number | bigint }).rowid))
      db.prepare(`INSERT INTO agent_memories_vec(embedding, agent_id, mem_rowid) VALUES (?, ?, ?)`)
        .run(vec, agentId, BigInt(memRowid))
    }
    catch { /* 向量写失败不阻塞主流程 */ }
  },
  vecDelete(memRowid: number): void {
    if (vecDims === null) return
    try {
      const old = db.prepare(`SELECT rowid FROM agent_memories_vec WHERE mem_rowid = ?`).get(BigInt(memRowid))
      if (old) db.prepare(`DELETE FROM agent_memories_vec WHERE rowid = ?`).run(BigInt((old as { rowid: number | bigint }).rowid))
    }
    catch { /* 同上 */ }
  },
  vecSearch(agentId: string, vec: Float32Array, k: number): Array<{ memRowid: number, distance: number }> {
    if (vecDims === null) return []
    try {
      const rows = db.prepare(
        `SELECT mem_rowid, distance FROM agent_memories_vec WHERE agent_id = ? AND embedding MATCH ? AND k = ?`,
      ).all(agentId, vec, BigInt(k)) as Array<{ mem_rowid: number | bigint, distance: number }>
      return rows.map(r => ({ memRowid: Number(r.mem_rowid), distance: r.distance }))
    }
    catch { return [] }
  },
```

`embedding-provider.ts`:

```ts
/**
 * Embedding provider — OpenAI 兼容 /embeddings 端点(env 驱动,零 SDK)。
 * 未配置 env → 返回 null(向量分支整体关闭,纯 FTS 降级)。
 * 熔断:连续 3 次失败禁用 10 分钟(避免每个任务都白等超时)。
 * 维度:首次成功 embed 的返回长度(不信任配置,以实测为准)。
 */
export interface EmbeddingProvider {
  embed(texts: string[]): Promise<Float32Array[]>
  /** 已知维度(首次成功 embed 前 null) */
  dims(): number | null
}

const FAIL_THRESHOLD = 3
const COOLDOWN_MS = 10 * 60_000

export function createEnvEmbeddingProvider(): EmbeddingProvider | null {
  const baseUrl = process.env.AW_MEMORY_EMBED_BASE_URL
  const model = process.env.AW_MEMORY_EMBED_MODEL
  if (!baseUrl || !model) return null
  const apiKey = process.env.AW_MEMORY_EMBED_API_KEY ?? ''
  let dims: number | null = null
  let fails = 0
  let disabledUntil = 0

  return {
    dims: () => dims,
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (Date.now() < disabledUntil) throw new Error('embedding provider 冷却中')
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ input: texts, model }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        if (++fails >= FAIL_THRESHOLD) { disabledUntil = Date.now() + COOLDOWN_MS; fails = 0 }
        throw new Error(`embedding HTTP ${res.status}`)
      }
      const json = await res.json() as { data: Array<{ embedding: number[] }> }
      dims = json.data[0]?.embedding.length ?? dims
      fails = 0
      return json.data.map(d => Float32Array.from(d.embedding))
    },
  }
}

/** 测试用确定性词袋 hash provider:相同词集 → 相近向量(零网络) */
export function createHashEmbeddingProvider(dims: number): EmbeddingProvider {
  return {
    dims: () => dims,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((t) => {
        const v = new Float32Array(dims)
        for (const w of t.toLowerCase().split(/\s+/).filter(Boolean)) {
          let h = 2166136261
          for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619)
          v[Math.abs(h) % dims] += 1
        }
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
        return v.map(x => x / norm) as Float32Array
      })
    },
  }
}
```

- [ ] **Step 4: 跑测试确认通过** → ALL PASS
- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml server/services/workshop/db/database.ts server/services/workshop/db/memory.repo.ts server/services/workshop/runtime/embedding-provider.ts scripts/test-memory-vector.ts
git commit -m "feat(workshop): sqlite-vec 向量层与 embedding provider(分区隔离/BigInt/熔断)"
```

---

### Task 8: AgentMemory 混合召回 + 写入向量化

**Files:**
- Modify: `server/services/workshop/runtime/memory.ts`
- Modify: `scripts/test-memory-vector.ts`(追加融合断言)

**Interfaces:**
- Consumes: Task 7 `EmbeddingProvider`、repo vec* 方法
- Produces: `AgentMemoryOptions.embedder?: EmbeddingProvider`;recall 升级 `max(rel_fts, sim_vec)` 融合;record* 成功后异步向量化(vecSet;失败静默留 FTS)

- [ ] **Step 1: 失败测试(追加)**

```ts
// 融合语义:FTS 词面 miss 但向量 hit(hash provider 构造:内容词与查询词部分重叠但 FTS 被切词规则过滤)
repo.upsert({ channelId: 'ch1', agentId: 'a1', kind: 'episodic-task', title: '登陆', titleFts: segmentCJK('登陆'), content: segmentCJK('用户登陆入口跳转处理'), importance: 0.8, taskId: 'tf1', dedupKey: 'task:tf1' })
const at = repo.findByAgentDedup('a1', 'task:tf1')!
repo.vecSet(at.rowid, 'a1', (await embedder.embed(['用户登陆入口跳转处理']))[0])
const fused = await mem.recall('entry login 用户')
check('向量兜底语义召回(FTS 弱命中时 vector 补足)', fused !== null && fused.includes('登陆'))

// 写入向量化:recordTaskOutcome 后向量自动就位(fakeTask 按 WorkspaceTask 全字段,types/task.ts:20-41)
const fakeTask: WorkspaceTask = {
  id: 'tv1', channelId: 'ch1', assigneeId: 'a1', creatorId: 'lead',
  title: '向量写入验证', state: 'COMPLETED', progress: 100, retryCount: 0,
  artifacts: [{ artifactId: 'x', name: 'deliverable', parts: [{ text: '记忆写入后应自动向量化' }] }],
  history: [],
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
}
await mem.recordTaskOutcome(fakeTask)
const vat = repo.findByAgentDedup('a1', 'task:tv1')!
const vhit = repo.vecSearch('a1', (await embedder.embed(['记忆写入后应自动向量化']))[0], 3)
check('recordTaskOutcome 自动向量化', vhit.some(h => h.memRowid === vat.rowid))
```

(fakeTask 字段以 `WorkspaceTask` 真实类型修正——先读 `types/task.ts`;断言不变。)

- [ ] **Step 2: 实现**

`memory.ts` 改造:
1. `import type { EmbeddingProvider } from './embedding-provider'`;options 加 `embedder?: EmbeddingProvider`
2. 构造时 `this.embedder = opts.embedder ?? null`;**惰性 vecInit**:首个 embed 成功后 `repo.vecInit(provider.dims()!)`,返回 false → 置 `this.embedder = null`(一次性禁用)
3. recall FTS 分支后追加向量分支:

```ts
    // 向量分支:查询向量 + agent/team 两域 kNN,与 FTS 按 id 融合(rel 取 max)
    if (this.embedder) {
      try {
        const [qv] = await this.embedder.embed([query])
        if (qv) {
          await this.ensureVec()
          const ids = [...hits.values()] // 先建 id→rowid 映射需主表;直接按 rowid 反查主表
          const byRowid = new Map<number, MemoryRow>()
          for (const h of hits.values()) {
            const at = this.repo.findByAgentDedup(h.row.agentId, '') // 占位,实际见下
            void at
          }
          void ids
          // 正确实现:vec 命中 memRowid → 主表取行(一次性 IN 查询见 repo.listByRowids)
          const vHitsAgent = this.repo.vecSearch(this.opts.agentId, qv, 10)
          const vHitsTeam = this.repo.vecSearch(TEAM_AGENT_ID, qv, 5)
          for (const { memRowid, distance } of [...vHitsAgent, ...vHitsTeam]) {
            const row = this.repo.listByRowids([memRowid]).find(r => r.id !== undefined)
            if (!row) continue
            const sim = Math.min(1, Math.max(0, 1 - distance))
            const prev = hits.get(row.id)
            hits.set(row.id, { row, relevance: prev ? Math.max(prev.relevance, sim) : sim })
          }
        }
      }
      catch { /* 向量不可用退化为 FTS */ }
    }
```

**实现注意(把上面伪码落干净):**
- repo 增加 `listByRowids(rowids: number[]): MemoryRow[]`(`SELECT … WHERE rowid IN (…)` 动态占位符;空数组返回 [])
- 删除占位 `byRowid/ids` 段,直接用 `listByRowids(vAll.map(h => h.memRowid))` 一次取回再匹配
- `ensureVec()`:`if (vecReady) return; const d = embedder.dims(); if (d && !repo.vecInit(d)) this.embedder = null`
- recordTaskOutcome / recordPeerExchange 的 upsert 后追加:

```ts
    if (this.embedder) {
      try {
        await this.ensureVec()
        const at = this.repo.findByAgentDedup(this.opts.agentId, dedupKey)
        const [vec] = await this.embedder.embed([plainContent])   // 未切分原文,语义质量优先
        if (at && vec) this.repo.vecSet(at.rowid, this.opts.agentId, vec)
      }
      catch { /* 向量化失败留 FTS */ }
    }
```

(`plainContent` = 切分前 content 变量;dedupKey 各自方法的字面量。)

- [ ] **Step 3:** `npx tsx scripts/test-memory-vector.ts` → ALL PASS;`npx tsx scripts/test-memory.ts` → ALL PASS(P0 无 embedder 不受影响)
- [ ] **Step 4: Commit** `feat(workshop): 混合召回融合与写入自动向量化`

---

# Phase P2 —— 系统完整性(团队域/REST 写/衰减/supervise)

### Task 9: 团队共享记忆域(manager + REST)

**Files:**
- Modify: `server/services/workshop/runtime/manager.ts`
- Create: `server/api/workshop/channels/[id]/memories/index.get.ts`
- Create: `server/api/workshop/channels/[id]/memories/index.post.ts`
- Create: `server/api/workshop/channels/[id]/memories/[memoryId].delete.ts`
- Modify: `scripts/test-memory.ts`(追加 team 段)

**语义:** 团队行 = `agent_id='__team__'`,channel 级全员可读(recall 已预埋);写/删仅 lead;读任意本 channel 成员 token。dedupKey 由调用方给(`style:ts` 这类稳定键 = 天然幂等更新)或缺省 `manual:<uuid>`。

- [ ] **Step 1: manager 方法(先写,测试直打 manager 层)**

```ts
  /** 团队共享记忆列表(channel 级;任意成员可读) */
  listTeamMemories(channelId: string, limit = 50): MemoryRow[] {
    const m = this.deps.repos.channelAgents.findByChannelAgent(channelId, TEAM_AGENT_ID)
    void m // team 行不要求实例存在;仅校验 channel
    const channel = this.deps.repos.channels.findById(channelId)
    if (!channel) throw new AppError(404, 'NOT_FOUND', `channel 不存在: ${channelId}`)
    return this.deps.repos.memories.listByAgent(TEAM_AGENT_ID, limit)
      .filter(r => r.channelId === channelId)
  }

  /** 写/更新团队记忆(仅 lead;稳定 dedupKey 幂等刷新) */
  addTeamMemory(channelId: string, callerAgentId: string, input: { title: string, content: string, importance?: number, dedupKey?: string }): MemoryRow[] {
    const caller = this.deps.repos.channelAgents.findByChannelAgent(channelId, callerAgentId)
    if (!caller || caller.role !== 'lead') throw new AppError(403, 'SCOPE_VIOLATION', '仅 lead 可写团队记忆')
    this.deps.repos.memories.upsert({
      channelId,
      agentId: TEAM_AGENT_ID,
      kind: 'semantic',
      title: input.title,
      titleFts: segmentCJK(input.title),
      content: segmentCJK(input.content).slice(0, 800),

      importance: input.importance ?? 0.9,
      taskId: null,
      dedupKey: input.dedupKey ?? `manual:${randomUUID()}`,
    })
    return this.listTeamMemories(channelId)
  }

  /** 删团队记忆(仅 lead) */
  deleteTeamMemory(channelId: string, callerAgentId: string, memoryId: string): void {
    const caller = this.deps.repos.channelAgents.findByChannelAgent(channelId, callerAgentId)
    if (!caller || caller.role !== 'lead') throw new AppError(403, 'SCOPE_VIOLATION', '仅 lead 可删团队记忆')
    const row = this.deps.repos.memories.listByAgent(TEAM_AGENT_ID, 1000).find(r => r.id === memoryId && r.channelId === channelId)
    if (!row) throw new AppError(404, 'NOT_FOUND', `团队记忆不存在: ${memoryId}`)
    this.deps.repos.memories.delete(memoryId)
  }
```

(manager import 增 `TEAM_AGENT_ID`/`segmentCJK`/`randomUUID` 按需;删除时 vec 行残留无害——vecSearch 反查主表 miss 即跳过,Task 11 维护统一清理孤儿 vec 行:`DELETE FROM vec WHERE mem_rowid NOT IN (SELECT rowid FROM agent_memories)`,加进维护函数。)

- [ ] **Step 2: REST 三端点**

`GET /channels/:id/memories`:`resolveCaller` → caller.channelId 校验 → `manager.listTeamMemories(channelId)`。
`POST /channels/:id/memories`:zod `{ title: z.string().min(1), content: z.string().min(1), importance: z.number().min(0).max(1).optional(), dedupKey: z.string().optional() }` → `resolveCaller` + `manager.addTeamMemory(channelId, caller.agentId, body)`。
`DELETE /channels/:id/memories/:memoryId`:`resolveCaller` + `manager.deleteTeamMemory(...)`。
(import 深度参照 `channels/[id]/queue.get.ts` 同层文件;zValidator 用法照 `tasks/index.post.ts`。)

- [ ] **Step 3: 测试(test-memory.ts 追加 team 段)**

最小 manager 构造(照 `scripts/test-dual-drive.ts` 的 manager 装配,`:memory:` db):lead+worker 两实例;断言:
1. `addTeamMemory` lead 写入成功,worker 调用抛 `SCOPE_VIOLATION`
2. 同 dedupKey 二次写 = 刷新(listTeamMemories 仍 1 条,content 为新)
3. `deleteTeamMemory` lead 成功;不存在 id 抛 404
4. worker 的 AgentMemory.recall 能看到团队行(借 Task 3 已有断言模式)

- [ ] **Step 4:** `npx tsx scripts/test-memory.ts` ALL PASS + server tsc 0 error
- [ ] **Step 5: Commit** `feat(workshop): 团队共享记忆域(lead 策展,全员召回)`

---

### Task 10: REST 写端点(agent 私有记忆策展)

**Files:**
- Modify: `server/services/workshop/runtime/manager.ts`(`addAgentMemory`/`deleteAgentMemory`)
- Create: `server/api/workshop/channels/[id]/agents/[agentId]/memories/index.post.ts`
- Create: `server/api/workshop/channels/[id]/agents/[agentId]/memories/[memoryId].delete.ts`
- Modify: `scripts/test-memory.ts`(追加)

**语义:** POST/DELETE 鉴权 = caller 是本 channel 成员且(`caller.agentId === agentId` 或 `caller.role === 'lead'`);kind 固定 `'semantic'`(人工策展);importance 默认 0.9;body 同 Task 9 zod。删除校验行属该 agent。

**manager 方法(照 Task 9 模式):**

```ts
  addAgentMemory(channelId: string, callerAgentId: string, targetAgentId: string, input: { title: string, content: string, importance?: number, dedupKey?: string }): void {
    const caller = this.deps.repos.channelAgents.findByChannelAgent(channelId, callerAgentId)
    if (!caller || (callerAgentId !== targetAgentId && caller.role !== 'lead')) {
      throw new AppError(403, 'SCOPE_VIOLATION', '仅本人或 lead 可策展 Agent 记忆')
    }
    if (!this.deps.repos.channelAgents.findByChannelAgent(channelId, targetAgentId)) {
      throw new AppError(404, 'NOT_FOUND', `Agent 实例不存在: ${targetAgentId}`)
    }
    this.deps.repos.memories.upsert({
      channelId, agentId: targetAgentId, kind: 'semantic',
      title: input.title, titleFts: segmentCJK(input.title),
      content: segmentCJK(input.content).slice(0, 800),
      importance: input.importance ?? 0.9, taskId: null,
      dedupKey: input.dedupKey ?? `manual:${randomUUID()}`,
    })
  }

  deleteAgentMemory(channelId: string, callerAgentId: string, targetAgentId: string, memoryId: string): void {
    const caller = this.deps.repos.channelAgents.findByChannelAgent(channelId, callerAgentId)
    if (!caller || (callerAgentId !== targetAgentId && caller.role !== 'lead')) {
      throw new AppError(403, 'SCOPE_VIOLATION', '仅本人或 lead 可删除 Agent 记忆')
    }
    const row = this.deps.repos.memories.listByAgent(targetAgentId, 10_000)
      .find(r => r.id === memoryId && r.channelId === channelId && r.agentId === targetAgentId)
    if (!row) throw new AppError(404, 'NOT_FOUND', `记忆不存在: ${memoryId}`)
    this.deps.repos.memories.delete(memoryId)
  }
```

**测试断言:** 本人写成功;他人(非 lead)写 → SCOPE_VIOLATION;lead 代写 worker → 成功;删不存在 → 404;写后该 agent recall 命中。
**验证:** `npx tsx scripts/test-memory.ts` + tsc 0 error → Commit `feat(workshop): agent 记忆策展写端点(本人或 lead)`

---

### Task 11: 衰减清理(维护函数 + 定时器 + REST 触发)

**Files:**
- Modify: `server/services/workshop/runtime/memory.ts`(文件级 `runMemoryMaintenance`)
- Modify: `server/services/workshop/runtime/manager.ts`(定时器 + shutdown 清理)
- Create: `server/api/workshop/memories/maintenance.post.ts`
- Create: `scripts/test-memory-maintenance.ts`

**策略(写死):**
- episodic 类(`kind LIKE 'episodic%'`)且 `now - (lastAccessedAt ?? createdAt) > 180 天` → 删除(FTS 触发器联动;vec 行随孤儿清理)
- 每 agent 超 `AW_MEMORY_CAP`(默认 500)条 → 按 `effectiveScore = importance + accessCount×0.05` 升序淘汰至 cap(保留高分)
- `semantic` 与 team 行:全部豁免(人工策展)
- 孤儿 vec 清理:`DELETE FROM agent_memories_vec WHERE mem_rowid NOT IN (SELECT rowid FROM agent_memories)`(vecReady 时)
- 返回 `{ deletedExpired, evicted, cleanedVec }`

- [ ] **Step 1: 失败测试**

`scripts/test-memory-maintenance.ts`(`:memory:` db;老数据用 repo 直插 + raw UPDATE created_at/last_accessed_at 伪造):

断言:
1. episodic 200 天未访问 → 删除;semantic 200 天 → 保留;team 200 天 → 保留
2. 同 agent 600 条 episodic(近期)→ 淘汰至 500,留下的是 effectiveScore 高的(构造 importance 差异验证)
3. 删除后 FTS 检索不再命中
4. 维护幂等(跑两遍第二遍 deletedExpired=0)

- [ ] **Step 2: 实现**

`memory.ts` 文件级导出:

```ts
export interface MaintenanceResult { deletedExpired: number, evicted: number, cleanedVec: number }

export function runMemoryMaintenance(repo: MemoryRepo, opts: { expireDays?: number, cap?: number } = {}): MaintenanceResult {
  const expireDays = opts.expireDays ?? Number(process.env.AW_MEMORY_EXPIRE_DAYS ?? 180)
  const cap = opts.cap ?? Number(process.env.AW_MEMORY_CAP ?? 500)
  const expireMs = expireDays * 86_400_000
  let deletedExpired = 0
  let evicted = 0
  const now = Date.now()

  for (const agentId of repo.listMemoryAgentIds()) {
    const rows = repo.listByAgent(agentId, 1_000_000)
    // ① 过期删除(仅 episodic)
    for (const r of rows) {
      if (!r.kind.startsWith('episodic')) continue
      const last = Date.parse(r.lastAccessedAt ?? r.createdAt)
      if (now - last > expireMs) {
        repo.vecDelete(rowidOf(r)) // rowid 获取:维护路径改用 repo.listByAgentWithRowid(见下)
        repo.delete(r.id)
        deletedExpired++
      }
    }
    // ② 容量淘汰(仅 episodic)
    const remaining = repo.listByAgent(agentId, 1_000_000).filter(r => r.kind.startsWith('episodic'))
    if (remaining.length > cap) {
      const sorted = remaining
        .map(r => ({ r, s: r.importance + r.accessCount * 0.05 }))
        .sort((a, b) => b.s - a.s)
      for (const { r } of sorted.slice(cap)) { repo.vecDelete(rowidOf(r)); repo.delete(r.id); evicted++ }
    }
  }
  // ③ 孤儿 vec 清理
  let cleanedVec = 0
  try { repo.vecCleanOrphans && (cleanedVec = repo.vecCleanOrphans()) } catch { /* vec 未启用 */ }
  return { deletedExpired, evicted, cleanedVec }
}
```

**repo 需补:** `listByAgentWithRowid(agentId, limit): Array<MemoryRow & { rowid: number }>`(维护专用,含 rowid);`vecCleanOrphans(): number`(上述 DELETE,vecReady 才执行,返回 changes;`vecInit` 未调用过则 0)。实现时把 `rowidOf(r)` 替换为该方法的 rowid 字段。

`manager.ts`:
- 构造器尾:`this.memoryTimer = setInterval(() => { try { runMemoryMaintenance(this.deps.repos.memories) } catch (err) { console.error('[memory] 维护失败:', err) } }, Number(process.env.AW_MEMORY_MAINTENANCE_MS ?? 6 * 3600_000)); this.memoryTimer.unref?.()`
- `shutdown()` 首:`if (this.memoryTimer) { clearInterval(this.memoryTimer); this.memoryTimer = undefined }`
- 公开 `runMemoryMaintenanceNow(): MaintenanceResult`(REST 触发透传)

REST `POST /api/workshop/memories/maintenance`(注意路径在 `workshop/memories/` 顶层):`resolveCaller` → caller 为任一 channel 的 lead 才放行(遍历 `findByChannelAgent`?简化:`repos.channelAgents` 加 `findLeadByAgent(agentId)` 或用 caller.role——caller 自身即 AgentInfo 有 role;`if (caller.role !== 'lead') throw 403`)→ 返回 `manager.runMemoryMaintenanceNow()`。

- [ ] **Step 3:** `npx tsx scripts/test-memory-maintenance.ts` ALL PASS;`npx tsx scripts/test-persistence-lazy.ts` ALL PASS(shutdown 清 timer 不炸)
- [ ] **Step 4: Commit** `feat(workshop): 记忆衰减清理(episodic 过期/容量淘汰/孤儿向量)`

---

### Task 12: supervise 路径注入

**Files:**
- Modify: `server/services/workshop/agents/agent-interface.ts`(AgentRunContext.memory)
- Modify: `server/services/workshop/runtime/agent-runtime.ts`(supervise 内召回)
- Modify: `server/services/workshop/agents/omp-agent.ts`(supervise prompt 注入)
- Modify: `scripts/test-memory.ts`(追加 supervise 段)

**Interfaces:**
- Produces: `AgentRunContext.memory?: string`(注释:**supervise 专用**;run 路径用 `AgentRunRequest.memory`)

- [ ] **Step 1: 失败测试**

test-memory.ts 追加:构造带 memory 的 runtime + 一个实现了 `supervise` 的 echo impl,捕获传入的 `ctx.memory`:
1. 预置 w-lead 一条记忆(标题含"调度"),快照含 SUBMITTED 任务(标题相关)
2. `await runtime.supervise(snapshot)` → echo 捕获 `ctx.memory` 含 `## 相关记忆` 且含预置标题
3. 召回后该记忆 `accessCount` 不变(`touch: false` 生效)
4. 无 memory deps 的 runtime supervise 正常(向后兼容)

- [ ] **Step 2: 实现**

`agent-interface.ts` AgentRunContext 尾:

```ts
  /** 平台记忆块(supervise 路径注入;run 路径用 AgentRunRequest.memory) */
  memory?: string
```

`agent-runtime.ts` `supervise()` 内,构造 ctx 前:

```ts
    // lead 调度记忆:非终态/失败任务标题 + 成员名构造查询;touch:false 防 tick 通胀
    let memoryBlock: string | undefined
    try {
      const query = [
        ...snapshot.tasks.filter(t => t.state === 'SUBMITTED' || t.state === 'FAILED' || t.state === 'WAITING').map(t => t.title),
        ...snapshot.members.map(m => m.name),
      ].join(' ')
      memoryBlock = (await this.deps.memory?.recall(query, { touch: false })) ?? undefined
    }
    catch (err) {
      console.error(`[AgentRuntime:${this.agentId}] supervise 记忆召回失败:`, err)
    }
    const ctx: AgentRunContext = { agentId: this.agentId, channelId: this.channelId, role: this.role, workspace: this.deps.workspace, signal: new AbortController().signal, memory: memoryBlock }
```

`omp-agent.ts` `supervise()`:prompt 构造处(`this.buildSupervisePrompt(snapshot)`)改为 `this.buildSupervisePrompt(snapshot, ctx.memory)`;buildSupervisePrompt 签名加 `memory?: string`,prefix 后 `if (memory) parts.push(memory)`。

- [ ] **Step 3:** `npx tsx scripts/test-memory.ts` ALL PASS;`npx tsx scripts/test-scheduler-loop.ts` ALL PASS(调度循环回归)
- [ ] **Step 4: Commit** `feat(workshop): lead supervise 记忆注入(快照驱动召回)`

---

### Task 13: 系统级 E2E + 收尾

**Files:**
- Create: `scripts/e2e-memory-system.ts`
- Modify: `docs/superpowers/plans/2026-08-15-agent-memory.md`(勾选)

**E2E 剧情(mock harness 全链 + hash embedder):**
1. manager 建 channel(lead+2 worker),全 runtime 带 memory
2. 任务 1(登录)完成 → 断言 repo 出现 lead/worker 各自记忆
3. lead `addTeamMemory`("团队统一用 pnpm")
4. 任务 2(相关)下发 → echo impl 捕获 worker request.memory 含任务 1 记忆 + 团队行
5. worker 间 peer 消息(require_reply)→ 双方 peer 记忆落库
6. REST(h3 toWebHandler,照 test-dual-drive.ts 模式):GET memories / POST team memory(lead token)/ POST agent memory / DELETE → 全 2xx;非 lead 写 team → 403
7. `runMemoryMaintenanceNow()` → 伪造老数据被清
8. `await manager.shutdown()` → 进程干净退出(timer 已清)

- [ ] **Step 1: 写 E2E(上述 8 断言组)→ Step 2: 全量回归**

```bash
npx tsx scripts/e2e-memory-system.ts && npx tsx scripts/test-memory.ts && npx tsx scripts/test-memory-vector.ts && npx tsx scripts/test-memory-maintenance.ts && npx tsx scripts/test-full-system.ts && npx tsx scripts/test-orchestration.ts
```

Expected: 全部 ALL PASS

- [ ] **Step 3:** 可选真实冒烟 `npx tsx scripts/e2e-omp-workspace.ts`(配置了 `AW_MEMORY_EMBED_*` 时验证真实向量链)
- [ ] **Step 4: Commit** `test(workshop): 记忆系统端到端验证(全链路回归)`

---

## Self-Review 结论

1. **Spec 覆盖**:五项新需求全部有任务——向量语义检索(Task 7-8)、衰减清理(Task 11)、团队共享域(Task 9)、REST 写端点(Task 9/10)、supervise 注入(Task 12);P0 六任务承载基础管线。每项的算法/参数/降级路径均已写死。
2. **落地复核(第二轮,对照真实源码逐条验证)**——发现并已修复 5 处缺陷:
   - **V8 title 不可检索**:FTS5 不切 CJK,原设计 title 原样入库 → CJK 标题检索全灭(而任务标题是主要查询面)。修复:主表加 `title_fts` 列,触发器索引切分副本,展示仍用原文;全部 upsert 调用点(7 处)已补 `titleFts`。
   - **Task 2 测试断言必挂**:team 记忆查询词与 team content 无交集,FTS 永不命中(listRecent 兜底不含 team)。修复:查询词改为双主题 `登录页面 代码风格`。
   - **V9 replyText 捕获全空**:omp run 路径从不产 `{kind:'message'}` 事件(assistant 文本走 `status.message` 和终态 artifact 'output',omp-agent.ts:664-728)。修复:聚合三类事件源。
   - **V10 测试 FK 崩溃**:`messages.channel_id REFERENCES channels(id)` + `foreign_keys=ON`,原测试草图没 seed channel。修复:seedChannel 前置。
   - **V11 测试惯例错位**:`AgentInfo` 字段是 `id` 非 `agentId`;fake engine 的 `complete()` 会 throw;workspace 不能 `{}`(EchoImpl 调 completeTask 会崩)。修复:Task 3 测试全部照抄 test-agent-runtime.ts 真实惯例(makeFakeEngine/mkAgent/seedChannel/workspace stub 经 transition 驱动 COMPLETED)。
3. **类型一致性**:`MemoryRow`(T1)→ `AgentMemory`(T2,async)→ `request.memory`/`deps.memory`(T3)→ `ctx.memory`(T12)→ `AllRepos.memories`(T5)→ vec 层(T7-8,`BigInt` 契约);`TEAM_AGENT_ID` 贯穿 T1/T2/T9;`titleFts` 贯穿全部 upsert 点;`listByRowids`/`listByAgentWithRowid`/`vecCleanOrphans` 在 T8/T11 定义并消费;fakeTask 按 `types/task.ts:20-41` 全字段。
4. **降级完备**:无 sqlite-vec 扩展 → FTS-only;无 embedding env → 纯 FTS;embedding 熔断 → 冷却期 FTS;维度不符 → 禁向量不重建;一切 try-catch 不阻塞执行。
5. **残余风险(已知且接受)**:Task 8 向量融合段为"要点 + 伪码清干净"级设计(实现者需按 `listByRowids` 要点落地,测试断言已锁定行为);hash provider 的语义测试在 FTS 也能命中时区分度有限(真实区分靠 env 配置的真实 embedding,e2e 可选验证);Task 12 快照构造以 `SupervisionSnapshot` 真实字段为准(含 tick/now,agent-interface.ts:83-86)。
