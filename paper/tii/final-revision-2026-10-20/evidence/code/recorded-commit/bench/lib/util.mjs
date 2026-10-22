/**
 * bench/lib/util.mjs —— 共享工具：seed 随机数、API 客户端、结果工厂、IO。
 * 无外部依赖（Node ≥ 20 原生 fetch/crypto），保证基准本身零安装可复现。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** mulberry32 —— 与产线模拟器同族的种子化 PRNG（seed=42 全链路可复现） */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const sha256 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16)
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const runId = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + process.pid.toString(36)

export function ensureDir(p) { mkdirSync(p, { recursive: true }); return p }
export function writeJson(p, obj) { writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8') }
export function writeText(p, s) { writeFileSync(p, s, 'utf8') }

/** 检查结果工厂：status ∈ pass|fail|warn|skip；score ∈ [0,1] */
export function result(id, meta, status, score, metrics, evidence, note) {
  return {
    id, title: meta.title, tier: meta.tier, dims: meta.dims, weight: meta.weight ?? 1,
    requires: meta.requires ?? [], status, score: Number(score.toFixed(4)),
    metrics: metrics ?? {}, evidence: evidence ?? [], note: note ?? '',
  }
}
export const skip = (id, meta, reason) => result(id, meta, 'skip', 0, {}, [], reason)

/** 平台 REST 客户端（与 scripts/_audit/seed-demo.mjs 同一封套：{data,code,message}） */
export function makeApi(base) {
  const B = base.replace(/\/$/, '')
  let token = ''
  return {
    get token() { return token },
    async raw(method, path, body) {
      // 网络层瞬断（dev server GC/备份序列化造成的秒级停顿 → ECONNRESET/timeout）
      // 用退避重试吸收；HTTP 语义错误不重试。重试读取的仍是服务端真实状态，
      // 且治理层对同值重写/同向冷却天然幂等，不会伪造结果。
      let lastErr
      for (let attempt = 1; attempt <= 8; attempt++) {
        try {
          const res = await fetch(`${B}${path}`, {
            method,
            headers: {
              'content-type': 'application/json',
              // keep-alive 复用连接：Windows 回环下逐请求新建连接会耗尽临时端口,
              // 出站 connect 直接 EADDRINUSE（实测）。偶发的陈旧连接复位由下方
              // 网络层重试兜底（重试在新连接上重发,读取的仍是服务端真实状态）。
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(30_000),
          })
          const json = await res.json().catch(() => null)
          return { status: res.status, data: json?.data, code: json?.code, message: json?.message ?? '' }
        } catch (err) {
          lastErr = err
          if (attempt < 8) await new Promise(r => setTimeout(r, Math.min(800 * 2 ** (attempt - 1), 8000)))
        }
      }
      throw lastErr
    },
    async login(email, password) {
      const setup = await this.raw('GET', '/api/users/setup-status')
      if (setup.data?.needsSetup) {
        const reg = await this.raw('POST', '/api/users/register', { name: 'awbench', email, password })
        token = reg.data?.token ?? ''
        return { ok: Boolean(token), how: 'register-first-admin', role: reg.data?.user?.role ?? '' }
      }
      const lg = await this.raw('POST', '/api/users/login', { email, password })
      token = lg.data?.token ?? ''
      return { ok: Boolean(token), how: 'login', role: lg.data?.user?.role ?? '' }
    },
    call(method, path, body) { return this.raw(method, path, body) },
  }
}

/** 线性标定死区容差（复刻 dcw-runtime writeTolerance 语义，用于回读判定） */
export function writeTolerance(min, max, decimals) {
  const tol = Math.max(0.5 * 10 ** -decimals, 0.005 * Math.abs(max - min))
  return Number(tol.toFixed(6))
}

export const fmtPct = (x) => `${(x * 100).toFixed(1)}%`
