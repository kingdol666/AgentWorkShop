/**
 * DCW 治理窗落盘(P1-5)—— 写保持窗(writeLocks)与试验节拍(trialLastAt)持久化。
 *
 * 此前两者均为内存 Map:服务重启即清零 —— "重启即绕频控/保持窗"(与 recipe-op-anchor
 * 同一动机,2026-10-08 评审 P1-5)。复用 op-anchor 的 json-store 落盘模式:
 * 绝对时间戳存盘,重启后读盘续算 —— 长停机自然过期放行,短重启窗口延续。
 * 写失败仅告警不反噬主流程(与 op-anchor 同口径)。
 */
import { join } from 'node:path'
import { ensureDataDir } from '@/shared/config/home.mjs'
import { loadJsonFile, saveJsonFileAtomic } from '../../json-store.mjs'

const GATE_PATH = join(ensureDataDir(), 'dcw-gate-persist.json')
const CAP = 2000
const TTL_MS = 24 * 3600_000

interface GateStore {
  /** nodeId → 写保持窗截止(epoch ms) */
  writeLocks: Record<string, number>
  /** lineId → 上一次 trial 时刻(epoch ms) */
  trialLastAt: Record<string, number>
}

const g = globalThis as unknown as { __dcwGatePersist?: GateStore }

function store(): GateStore {
  if (!g.__dcwGatePersist) {
    g.__dcwGatePersist = loadJsonFile(GATE_PATH, { writeLocks: {}, trialLastAt: {} }) as GateStore
  }
  return g.__dcwGatePersist
}

function persist(): void {
  const s = store()
  const now = Date.now()
  const prune = (rec: Record<string, number>): Record<string, number> => {
    const kept: Record<string, number> = {}
    for (const [k, v] of Object.entries(rec)) {
      if (now - v < TTL_MS) kept[k] = v
    }
    const keys = Object.keys(kept)
    if (keys.length <= CAP) return kept
    keys.sort((a, b) => kept[a]! - kept[b]!)
    const out: Record<string, number> = {}
    for (const k of keys.slice(keys.length - CAP)) out[k] = kept[k]!
    return out
  }
  s.writeLocks = prune(s.writeLocks)
  s.trialLastAt = prune(s.trialLastAt)
  try {
    saveJsonFileAtomic(GATE_PATH, s)
  }
  catch (err) {
    console.warn('[dcw-gate-persist] 落盘失败(仅告警,不影响主流程):', err instanceof Error ? err.message : err)
  }
}

export function hydrateWriteLocks(): Record<string, number> {
  return { ...store().writeLocks }
}

export function setWriteLockUntil(nodeId: string, untilMs: number): void {
  store().writeLocks[nodeId] = untilMs
  persist()
}

export function hydrateTrialLastAt(): Record<string, number> {
  return { ...store().trialLastAt }
}

export function setTrialLastAt(lineId: string, atMs: number): void {
  store().trialLastAt[lineId] = atMs
  persist()
}

/** 仅供测试:清空(内存+落盘) */
export function resetDcwGatePersist(): void {
  g.__dcwGatePersist = { writeLocks: {}, trialLastAt: {} }
  persist()
}
