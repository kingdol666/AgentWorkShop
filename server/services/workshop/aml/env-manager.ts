/**
 * AML 环境管理:环境自检状态 + 异步动作(一键安装 uv / 创建 .venv)。
 *
 * 为什么要有这层:
 *  - 平台第一次被使用时,用户环境里可能既没有 uv 也没有可用的 Python。
 *    把「检测 → 引导 → 一键修复」收敛成一个可读的状态对象,REST/UI/工具三面共用;
 *  - 安装 uv 与创建 venv 都是**长耗时且有网络下载**的动作(数十秒到数分钟),
 *    不能挂在同步 HTTP 请求里 —— 用进程内单任务 + 轮询进度(GET env 带 task),
 *    与作业编排器的「异步 + 进度推送」纪律一致。
 *
 * 单任务约束:同一时刻只允许一个 env 动作(uv 安装与 venv 创建都要动同一个工具目录/
 * 虚拟环境,并发只会互相破坏)。重复提交返回 409 + 当前任务状态。
 */
import { readdirSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { AppError } from '../../../utils/errors'
import { createLogger } from '../logger'
import { amlSettings } from '../settings'
import { amlRootSourceLabel, getAmlRuntime } from './runtime'
import {
  ensureVenv,
  installUv,
  isVenvReady,
  probePython,
  probeUv,
  requirementsHash,
  resetProbeCache,
  venvDir,
  venvPythonPath,
  type ProgressFn,
  type PythonProbe,
  type UvProbe,
} from './python-runtime'

const log = createLogger('aml.env')

export type AmlEnvTaskKind = 'install-uv' | 'create-venv'
export type AmlEnvTaskStatus = 'running' | 'done' | 'failed'

export interface AmlEnvTask {
  id: string
  kind: AmlEnvTaskKind
  status: AmlEnvTaskStatus
  startedAt: string
  endedAt: string | null
  /** 进度日志(尾部;安装输出可能很长,只保留最近 N 行) */
  log: string[]
  error: string | null
}

export interface AmlEnvStatus {
  amlRoot: string
  amlRootMode: string
  amlRootSource: string
  projectRoot: string | null
  dirs: { datasets: string, jobs: string, models: string, venv: string, tools: string, runtime: string }
  uv: UvProbe
  python: PythonProbe
  venv: { ready: boolean, dir: string, pythonPath: string, requirementsHash: string, sizeMb: number }
  disk: { usedMb: number, quotaMb: number }
  /** 一键安装 uv 是否可用(平台总能在项目内安装,恒 true;留给未来策略开关) */
  canInstallUv: boolean
  task: AmlEnvTask | null
  /** 作业前置条件:不满足时 UI 直接给修复入口,而不是等作业失败 */
  preflight: { canRunJobs: boolean, blockers: string[] }
}

const TASK_LOG_TAIL = 200

const g = globalThis as typeof globalThis & { __amlEnvTask?: AmlEnvTask }

function currentTask(): AmlEnvTask | null {
  return g.__amlEnvTask ?? null
}

function pushLog(task: AmlEnvTask, line: string): void {
  for (const l of line.split(/\r?\n/)) {
    const t = l.trimEnd()
    if (!t) continue
    task.log.push(t)
  }
  if (task.log.length > TASK_LOG_TAIL) task.log.splice(0, task.log.length - TASK_LOG_TAIL)
}

function dirSizeMb(dir: string): number {
  let total = 0
  const walk = (d: string, depth: number) => {
    if (depth > 6) return
    let entries: string[]
    try {
      entries = readdirSync(d)
    }
    catch {
      return
    }
    for (const e of entries) {
      const p = `${d}/${e}`
      const st = statSync(p, { throwIfNoEntry: false })
      if (!st) continue
      if (st.isDirectory()) walk(p, depth + 1)
      else total += st.size
    }
  }
  walk(dir, 0)
  return total / 1024 / 1024
}

/** 组装环境自检状态(只读;不做任何写入) */
export async function envStatus(): Promise<AmlEnvStatus> {
  const rt = getAmlRuntime()
  const uv = await probeUv(rt)
  const python = await probePython()
  const venvReady = isVenvReady(rt)
  const blockers: string[] = []
  if (!python.ok) blockers.push(python.reason ?? 'Python 解释器不可用')
  if (!venvReady) blockers.push('训练环境(./aml/.venv)尚未创建:请在「运行环境」面板点击「创建训练环境」')
  let usedMb = 0
  try {
    usedMb = dirSizeMb(rt.root)
  }
  catch { /* 目录不可读按 0 */ }
  return {
    amlRoot: rt.root,
    amlRootMode: rt.rootMode,
    amlRootSource: amlRootSourceLabel(rt.rootMode),
    projectRoot: rt.projectRoot,
    dirs: {
      datasets: rt.datasetsDir,
      jobs: rt.jobsDir,
      models: rt.modelsDir,
      venv: venvDir(rt),
      tools: rt.toolsDir,
      runtime: rt.runtimeDir,
    },
    uv,
    python,
    venv: {
      ready: venvReady,
      dir: venvDir(rt),
      pythonPath: venvPythonPath(rt),
      requirementsHash: requirementsHash(),
      sizeMb: Number(dirSizeMb(venvDir(rt)).toFixed(1)),
    },
    disk: { usedMb: Number(usedMb.toFixed(1)), quotaMb: amlQuotaMb() },
    canInstallUv: true,
    task: currentTask(),
    preflight: { canRunJobs: python.ok && venvReady, blockers },
  }
}

function amlQuotaMb(): number {
  try {
    return amlSettings().job.diskQuotaMb
  }
  catch {
    return 2048
  }
}

/** 启动一个 env 任务(单任务互斥);返回任务快照供 UI 立即渲染 */
function startTask(kind: AmlEnvTaskKind): AmlEnvTask {
  const running = currentTask()
  if (running && running.status === 'running') {
    throw new AppError(409, 'AML_ENV_BUSY', `已有环境任务在执行中(${running.kind}),请等待完成后再操作`)
  }
  const task: AmlEnvTask = {
    id: `env-${randomUUID().slice(0, 8)}`,
    kind,
    status: 'running',
    startedAt: new Date().toISOString(),
    endedAt: null,
    log: [],
    error: null,
  }
  g.__amlEnvTask = task
  return task
}

function finishTask(task: AmlEnvTask, err?: unknown): void {
  task.endedAt = new Date().toISOString()
  if (err) {
    task.status = 'failed'
    task.error = err instanceof Error ? err.message : String(err)
    pushLog(task, `失败:${task.error}`)
    log.warn(`[aml-env] ${task.kind} 失败:`, task.error)
  }
  else {
    task.status = 'done'
    pushLog(task, '完成。')
    log.info(`[aml-env] ${task.kind} 完成`)
  }
}

/** 一键安装 uv(异步;立即返回任务快照,进度经 GET /aml/env 轮询) */
export function startInstallUv(): AmlEnvTask {
  const rt = getAmlRuntime()
  const task = startTask('install-uv')
  const emit: ProgressFn = line => pushLog(task, line)
  void (async () => {
    try {
      emit(`AML 资产根:${rt.root}`)
      emit(`目标安装目录:${rt.toolsDir}(免管理员,不改系统 PATH)`)
      const r = await installUv(rt, emit)
      if (!r.ok) throw new AppError(500, 'AML_UV_INSTALL_FAILED', r.log.slice(-600) || 'uv 安装失败')
      resetProbeCache()
      finishTask(task)
    }
    catch (err) {
      finishTask(task, err)
    }
  })()
  return task
}

/** 创建/重建训练环境 ./aml/.venv(异步) */
export function startCreateVenv(opts: { force?: boolean } = {}): AmlEnvTask {
  const rt = getAmlRuntime()
  const task = startTask('create-venv')
  const emit: ProgressFn = line => pushLog(task, line)
  void (async () => {
    try {
      emit(`${opts.force ? '重建' : '创建'}训练环境:${venvDir(rt)}`)
      const uv = await probeUv(rt)
      emit(uv.ok
        ? `使用 uv ${uv.version}(来源:${uv.source})`
        : '未检测到 uv,将回退 python -m venv(建议先点「一键安装 uv」以获得更快更稳的供给)')
      const vpy = await ensureVenv(rt, { force: opts.force, onLog: emit })
      emit(`解释器:${vpy}`)
      finishTask(task)
    }
    catch (err) {
      finishTask(task, err)
    }
  })()
  return task
}

/** 重新探测(用户在系统里手工装了 uv/Python 后,无需重启服务) */
export function recheck(): void {
  resetProbeCache()
  log.info('[aml-env] 已清空探测缓存,下次读取将重新探测')
}
