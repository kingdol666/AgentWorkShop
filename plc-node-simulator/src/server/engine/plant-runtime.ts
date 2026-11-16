/**
 * plant-runtime:物理模型与设备信号的绑定执行层(多引擎并存版)。
 *
 * 职责:每个引擎每 dtMs 一步 —— 从控制绑定信号读当前 SP(外部 DCW 写已落到信号值)→
 * 模型积分 → 把模型输出覆写到 DAQ 绑定信号(vector/image 信号写对应形态)→
 * WS 广播 → 真值/暴露双列 JSONL 导出(ground truth 评测流)。
 *
 * 多引擎并存(2026-09 起支持多场景同时闭环):
 *   · cfg.plantModel = 遗留单引擎主位(kind 任意;真值落 truth.jsonl,GET /api/plant/* 缺省目标);
 *   · cfg.plantModels[] = 附加引擎(按 id 唯一;真值落 truth-<id>.jsonl);
 *   · startPlantModel() 对全部期望引擎「缺则启动、在则刷新绑定、warm 则热态重启」,
 *     不在期望集里的引擎停掉 —— 旧调用方(单引擎语义)行为完全不变。
 * 控制/输出绑定缺失时跳过对应项(允许部分场景)。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { PlantBinding, PlantModelConfig, PlantTruthSample, SignalDef } from '../../shared/types'
import { CastFilmModel, type PlantControls, type PlantStepResult } from './plant-model'
import { BiaxModel, BIAX_NOMINAL, type BiaxControls, type BiaxStepResult } from './biax-model'
import { InjectionModel, INJECTION_NOMINAL, type InjectionControls, type InjectionStepResult } from './injection-model'
import { WwtpModel, WWTP_NOMINAL, type WwtpControls, type WwtpStepResult } from './wwtp-model'
import { AnnealModel, ANNEAL_NOMINAL, type AnnealControls, type AnnealStepResult } from './anneal-model'
import { encodeGrayPng } from './png-enc'
import { broadcast } from '../bus'
import { DATA_DIR, getConfig, saveConfig } from '../store'

type AnyModel = CastFilmModel | BiaxModel | InjectionModel | WwtpModel | AnnealModel
type GenericStepResult = BiaxStepResult | InjectionStepResult | WwtpStepResult | AnnealStepResult

interface RunningPlant {
  key: string
  cfg: PlantModelConfig
  model: AnyModel
  timer?: NodeJS.Timeout
  truthStream?: fs.WriteStream
  truthCount: number
  /** 已推进的模拟时间(ms;由 step × dt 派生,C18 供 truth.tSim 断言) */
  simMs: number
}

const plants = new Map<string, RunningPlant>()

const TRUTH_ROTATE_LINES = 200_000

const kindOf = (pc: PlantModelConfig): string => pc.kind ?? 'castfilm'
const keyOf = (pc: PlantModelConfig): string => pc.id ?? pc.kind ?? 'primary'
const truthFile = (key: string, primary: boolean): string =>
  path.join(DATA_DIR, primary ? 'truth.jsonl' : `truth-${key}.jsonl`)

function findSignal(b: PlantBinding): { nodeId: string, nodeSignals: SignalDef[], sig: SignalDef } | undefined {
  const node = getConfig().nodes.find(n => n.id === b.nodeId)
  if (!node) return undefined
  const sig = (node.signals ?? []).find(s => s.id === b.signalId)
  if (!sig) return undefined
  return { nodeId: node.id, nodeSignals: node.signals ?? [], sig }
}

function readControl(b: PlantBinding | undefined, fallback: number): number {
  if (!b) return fallback
  const hit = findSignal(b)
  const v = hit?.sig.runtime?.value
  return Number.isFinite(v) ? v! : fallback
}

/**
 * 变更累积器:**按 nodeId 分桶**。
 *
 * 为什么必须分桶:模型输出会被写进各自**宿主设备**的信号(见 findSignal),
 * 但早先的广播把这些信号统一挂在硬编码的 nodeId 'plant-model' 下 ——
 * 而 'plant-model' 并不是一台真实设备(/api/nodes 里没有它)。
 * 后果:WS 客户端按 nodeId 找卡片永远匹配不上,物理量(melt-temp / thickness /
 * defect…)在界面上**永远显示初始快照**,看起来像"模拟器是静止的"。
 * 现场实测:UI 打开 15 秒,文本 0 个字符变化,而同时 WS 已推了 32 帧。
 */
type ChangedByNode = Map<string, Array<{ id: string, name: string, value: number, unit?: string }>>

function pushChanged(changed: ChangedByNode, nodeId: string, entry: { id: string, name: string, value: number, unit?: string }): void {
  const list = changed.get(nodeId) ?? []
  list.push(entry)
  changed.set(nodeId, list)
}

function writeScalar(hit: { nodeId: string, sig: SignalDef }, value: number, changed: ChangedByNode): void {
  const sig = hit.sig
  if (!sig.runtime) sig.runtime = { value: 0, hist: [] }
  const dec = sig.decimals ?? 3
  sig.runtime.value = Number(value.toFixed(dec))
  sig.runtime.hist!.push(sig.runtime.value)
  if (sig.runtime.hist!.length > 60) sig.runtime.hist!.shift()
  pushChanged(changed, hit.nodeId, { id: sig.id, name: sig.name, value: sig.runtime.value, unit: sig.unit })
}

function writeVector(hit: { nodeId: string, sig: SignalDef }, points: number[], changed: ChangedByNode): void {
  const sig = hit.sig
  if (!sig.runtime) sig.runtime = { value: 0, hist: [] }
  sig.runtime.vector = points
  const avg = points.reduce((a, b) => a + b, 0) / Math.max(points.length, 1)
  sig.runtime.value = Number(avg.toFixed(3))
  sig.runtime.hist!.push(sig.runtime.value)
  if (sig.runtime.hist!.length > 60) sig.runtime.hist!.shift()
  pushChanged(changed, hit.nodeId, { id: sig.id, name: sig.name, value: sig.runtime.value, unit: sig.unit })
}

/** 缺陷图像帧:96×32 灰度 —— 底纹 = 厚度轮廓横向条纹,亮点数 ∝ 缺陷率 */
function renderDefectImage(profile: number[], defect: number, rand: () => number): { png: string, width: number, height: number } {
  const W = 96
  const H = 32
  const px = new Uint8Array(W * H)
  const minP = Math.min(...profile)
  const maxP = Math.max(...profile)
  const span = Math.max(maxP - minP, 1e-6)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const pi = Math.min(profile.length - 1, Math.floor((x / W) * profile.length))
      const band = (profile[pi]! - minP) / span
      px[y * W + x] = Math.round(60 + band * 120)
    }
  }
  // 缺陷亮点:撒点数 ∝ 缺陷率(seeded rand,保持可复现)
  const spots = Math.min(200, Math.round(defect * 6 + 2))
  for (let i = 0; i < spots; i++) {
    const x = Math.floor(rand() * W)
    const y = Math.floor(rand() * H)
    px[y * W + x] = 240
  }
  const png = encodeGrayPng(px, W, H)
  return { png: png.toString('base64'), width: W, height: H }
}

function openTruthStream(rp: RunningPlant): void {
  if (rp.truthStream) { rp.truthStream.end(); rp.truthStream = undefined }
  const file = truthFile(rp.key, rp.cfg === getConfig().plantModel)
  fs.mkdirSync(DATA_DIR, { recursive: true })
  rp.truthStream = fs.createWriteStream(file, { flags: 'w' })
  rp.truthStream.write(`${JSON.stringify({
    meta: true, engine: rp.key, kind: kindOf(rp.cfg), seed: rp.cfg.seed,
    timeScale: rp.cfg.timeScale, dtMs: rp.cfg.dtMs,
    startedAt: new Date().toISOString(), phase: rp.cfg.phase,
  })}\n`)
  rp.truthCount = 0
}

function readControls(cfg: PlantModelConfig): PlantControls {
  const cb = cfg.controls
  return {
    zone1: readControl(cb?.zone1, 210),
    zone2: readControl(cb?.zone2, 210),
    zone3: readControl(cb?.zone3, 210),
    screw: readControl(cb?.screw, 120),
    lineSpeed: readControl(cb?.lineSpeed, 85),
    dieGap: readControl(cb?.dieGap, 1.0),
  }
}

/** 通用控制面(biax/injection/wwtp/anneal):按各模型标称工况的键逐一从绑定信号读当前值 */
function readGenericControls(cfg: PlantModelConfig, nominal: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  const cb = cfg.controls as Record<string, PlantBinding | undefined>
  for (const [key, def] of Object.entries(nominal)) {
    out[key] = readControl(cb[key], def)
  }
  return out
}

/** 通用输出面:vector 形态 → 模型轮廓帧;image 形态 → 轮廓+缺陷率渲染;标量 → exposed 覆写 */
function writeGenericOutputs(cfg: PlantModelConfig, r: GenericStepResult, model: AnyModel, changed: ChangedByNode): void {
  const profile = (r as { profile?: number[] }).profile ?? []
  for (const [key, b] of Object.entries(cfg.outputs ?? {}) as Array<[string, PlantBinding]>) {
    if (!b) continue
    const hit = findSignal(b)
    if (!hit) continue
    if (hit.sig.format === 'vector') {
      if (profile.length) writeVector(hit, profile, changed)
      continue
    }
    if (hit.sig.format === 'image') {
      const defectMetric = Number(r.exposed[key] ?? r.exposed.defect ?? 0)
      if (!hit.sig.runtime) hit.sig.runtime = { value: 0, hist: [] }
      hit.sig.runtime.image = renderDefectImage(profile, Math.max(0, defectMetric), () => (model as BiaxModel).sampleRand())
      hit.sig.runtime.value = defectMetric
      pushChanged(changed, hit.nodeId, { id: hit.sig.id, name: hit.sig.name, value: hit.sig.runtime.value, unit: hit.sig.unit })
      continue
    }
    const v = r.exposed[key]
    if (Number.isFinite(v)) writeScalar(hit, v, changed)
  }
}

function stepOnce(key: string): void {
  const rp = plants.get(key)
  if (!rp) return
  const cfg = rp.cfg
  if (!cfg.enabled) return
  // 首版强制 timeScale=1:加速过程生成的"延迟"不能当真实秒数(C18)
  const dtSec = cfg.dtMs / 1000
  rp.simMs += cfg.dtMs
  const kind = kindOf(cfg)
  const dist = {
    heaterDecay: cfg.disturbances?.heaterDecay ?? 1,
    feedDriftPerMin: cfg.disturbances?.feedDriftPerMin ?? 0,
  }
  const changed: ChangedByNode = new Map()
  let controls: Record<string, number>
  let truth: Record<string, unknown>
  let exposed: Record<string, number>

  if (kind === 'castfilm') {
    const cfModel = rp.model as CastFilmModel
    const c = readControls(cfg)
    const r: PlantStepResult = cfModel.step(c, dtSec, dist)
    const out = (k: string) => cfg.outputs?.[k as keyof typeof cfg.outputs]
    const bTemp = out('meltTemp')
    if (bTemp) { const hit = findSignal(bTemp); if (hit) writeScalar(hit, r.exposed.meltTemp, changed) }
    const bP = out('meltPressure')
    if (bP) { const hit = findSignal(bP); if (hit) writeScalar(hit, r.exposed.pressure, changed) }
    const bH = out('filmThickness')
    if (bH) { const hit = findSignal(bH); if (hit) writeScalar(hit, r.exposed.thickness, changed) }
    const bD = out('defectRate')
    if (bD) { const hit = findSignal(bD); if (hit) writeScalar(hit, r.exposed.defect, changed) }
    const bG = out('gels')
    if (bG) { const hit = findSignal(bG); if (hit) writeScalar(hit, r.exposed.gels, changed) }
    const bPr = out('profile')
    if (bPr) { const hit = findSignal(bPr); if (hit) writeVector(hit, r.profile, changed) }
    const bImg = out('defectImage')
    if (bImg) {
      const hit = findSignal(bImg)
      if (hit) {
        if (!hit.sig.runtime) hit.sig.runtime = { value: 0, hist: [] }
        hit.sig.runtime.image = renderDefectImage(r.profile, r.exposed.defect, () => cfModel.sampleRand())
        hit.sig.runtime.value = r.exposed.defect
        pushChanged(changed, hit.nodeId, { id: hit.sig.id, name: hit.sig.name, value: hit.sig.runtime.value, unit: hit.sig.unit })
      }
    }
    controls = c as unknown as Record<string, number>
    truth = r.truth as unknown as Record<string, unknown>
    exposed = r.exposed
  }
  else {
    const nominal = kind === 'biax' ? BIAX_NOMINAL as unknown as Record<string, number>
      : kind === 'injection' ? INJECTION_NOMINAL as unknown as Record<string, number>
      : kind === 'wwtp' ? WWTP_NOMINAL as unknown as Record<string, number>
      : ANNEAL_NOMINAL as unknown as Record<string, number>
    controls = readGenericControls(cfg, nominal)
    const model = rp.model as BiaxModel | InjectionModel | WwtpModel | AnnealModel
    const r = model.step(controls as never, dtSec, dist as never) as GenericStepResult
    writeGenericOutputs(cfg, r, model, changed)
    truth = r.truth as unknown as Record<string, unknown>
    exposed = r.exposed
  }

  // 每台**宿主设备**各推一帧:nodeId 与 /api/nodes 里真实存在的设备 id 一致,
  // 任何 WS 消费端(模拟器 UI、外部工具)都能按 device.id 直接落到卡片上。
  const at = Date.now()
  for (const [nodeId, signals] of changed) {
    broadcast({ type: 'signal.update', payload: { nodeId, signals, at } })
  }

  if (cfg.truthExport) {
    if (!rp.truthStream) openTruthStream(rp)
    const sample: PlantTruthSample = {
      t: new Date().toISOString(),
      tSim: rp.simMs,
      phase: cfg.phase ?? 'steady',
      sp: controls,
      truth,
      exposed,
    }
    rp.truthStream!.write(`${JSON.stringify(sample)}\n`)
    rp.truthCount++
    if (rp.truthCount > TRUTH_ROTATE_LINES) openTruthStream(rp)
  }
}

function startEngine(pc: PlantModelConfig, warm: boolean): void {
  const key = keyOf(pc)
  stopEngine(key)
  const kind = kindOf(pc)
  let model: AnyModel
  if (kind === 'biax') model = new BiaxModel(pc.params, pc.seed)
  else if (kind === 'injection') model = new InjectionModel(pc.params, pc.seed)
  else if (kind === 'wwtp') model = new WwtpModel(pc.params, pc.seed)
  else if (kind === 'anneal') model = new AnnealModel(pc.params, pc.seed)
  else model = new CastFilmModel(pc.params, pc.seed)
  model.reset(pc.seed, /* cold = */ !warm)
  const rp: RunningPlant = { key, cfg: pc, model, truthCount: 0, simMs: 0 }
  plants.set(key, rp)
  if (pc.truthExport) openTruthStream(rp)
  rp.timer = setInterval(() => stepOnce(key), Math.max(pc.dtMs, 100))
  rp.timer.unref?.()
  // 启动即推一拍:绑定信号立刻有值
  stepOnce(key)
  console.log(`[plant-model] 引擎 ${key}(${kind})已启用 seed=${pc.seed} dt=${pc.dtMs}ms ×${pc.timeScale} 阶段=${pc.phase}${warm ? ' 热态' : ' 冷态'}`)
}

function stopEngine(key: string): void {
  const rp = plants.get(key)
  if (!rp) return
  if (rp.timer) { clearInterval(rp.timer); rp.timer = undefined }
  if (rp.truthStream) { rp.truthStream.end(); rp.truthStream = undefined }
  plants.delete(key)
}

/** 启动物理模型(全部期望引擎:主位 + plantModels;未启用/不在期望集的引擎停掉)。
 *  warm=true 时热态复位(温态=标称工艺温度、运输管线填满稳态)→ 免去冷态预热;
 *  缺省冷态(与既有行为一致)。仅刷新在跑引擎的绑定时传 warm=false 且引擎已存在。 */
export function startPlantModel(warm = false): void {
  const cfg = getConfig()
  const desired: PlantModelConfig[] = []
  if (cfg.plantModel?.enabled) desired.push(cfg.plantModel)
  for (const m of cfg.plantModels ?? []) if (m.enabled) desired.push(m)
  const keys = new Set(desired.map(keyOf))
  for (const key of [...plants.keys()]) {
    if (!keys.has(key)) stopEngine(key)
  }
  for (const pc of desired) {
    const key = keyOf(pc)
    const rp = plants.get(key)
    const kindSwitch = rp !== undefined && kindOf(rp.cfg) !== kindOf(pc)
    if (!rp || warm || kindSwitch) startEngine(pc, warm)
    else rp.cfg = pc // 只刷新绑定(每 tick 现读 cfg),不动运行状态
  }
}

/** 停止全部引擎 */
export function stopPlantModel(): void {
  for (const key of [...plants.keys()]) stopEngine(key)
}

/** 按 id 增量装载引擎(多场景共存;不动其他引擎与主位) */
export function upsertPlantModel(pm: PlantModelConfig, warm = false): void {
  if (!pm.id) throw new Error('upsertPlantModel 需要 plantModel.id(场景键)')
  const cfg = getConfig()
  const next = { ...pm, optimum: null }
  const list = (cfg.plantModels ?? []).filter(m => m.id !== pm.id)
  list.push(next)
  cfg.plantModels = list
  saveConfig()
  startEngine(next, warm)
}

/** 按 id 复位单个引擎(seed/phase/disturbances/params/warm);id 缺省 = 遗留主位语义 */
export function resetPlantEngine(opts: {
  id?: string, seed?: number, phase?: string,
  disturbances?: PlantModelConfig['disturbances'], params?: Record<string, number>, warm?: boolean,
} = {}): PlantModelConfig | undefined {
  const cfg = getConfig()
  const target = opts.id
    ? [...(cfg.plantModels ?? []), ...(cfg.plantModel ? [cfg.plantModel] : [])].find(m => m.id === opts.id || (opts.id === 'primary' && m === cfg.plantModel))
    : cfg.plantModel
  if (!target) return undefined
  if (Number.isFinite(Number(opts.seed))) target.seed = Number(opts.seed)
  if (opts.phase && ['warmup', 'steady', 'batch', 'disturb'].includes(opts.phase)) {
    target.phase = opts.phase as PlantTruthSample['phase']
  }
  if (opts.disturbances) target.disturbances = { ...(target.disturbances ?? {}), ...opts.disturbances }
  if (opts.params) target.params = { ...(target.params ?? {}), ...opts.params } as PlantModelConfig['params']
  if ('optimum' in target) delete target.optimum
  saveConfig()
  const key = keyOf(target)
  if (plants.has(key)) startEngine(target, opts.warm === true)
  else startPlantModel(false)
  return target
}

export function plantRunning(): boolean {
  return plants.size > 0
}

/** 当前模型瞬时真值(供 REST 查看;不落盘)。主位字段平铺(遗留形状)+ engines 全引擎列表。 */
export function plantSnapshot(): Record<string, unknown> | null {
  const cfg = getConfig()
  const base = {
    enabled: cfg.plantModel?.enabled ?? cfg.plantModels?.some(m => m.enabled) ?? false,
    running: plantRunning(),
    kind: cfg.plantModel ? kindOf(cfg.plantModel) : (cfg.plantModels?.[0] ? kindOf(cfg.plantModels[0]!) : 'castfilm'),
    phase: cfg.plantModel?.phase ?? 'steady',
    disturbances: cfg.plantModel?.disturbances ?? {},
    seed: cfg.plantModel?.seed,
    // 首版强制 1(加速时间不参与延迟/收益断言;配置的 timeScale 只作历史字段)
    timeScale: 1,
    configuredTimeScale: cfg.plantModel?.timeScale ?? 1,
  }
  const primary = cfg.plantModel ? plants.get(keyOf(cfg.plantModel)) : undefined
  const head: Record<string, unknown> = { ...base }
  if (primary) {
    head.elapsedS = Number(primary.model.elapsedS.toFixed(1))
    const lt = (primary.model as BiaxModel).lastTruth as Record<string, number> | null
    if (kindOf(primary.cfg) === 'biax' && lt) {
      Object.assign(head, {
        thickness: lt.thickness, defect: lt.defect, haze: lt.haze, sigma: lt.sigma,
        tension: lt.tension, rollDia: lt.rollDia, meltTemp: lt.meltTemp,
      })
    }
    if (kindOf(primary.cfg) === 'castfilm') head.defect = Number((primary.model as CastFilmModel).defect.toFixed(3))
  }
  head.engines = [...plants.values()].map((rp) => {
    const lt = (rp.model as BiaxModel).lastTruth as Record<string, number> | null
    return {
      id: rp.key, kind: kindOf(rp.cfg), phase: rp.cfg.phase ?? 'steady',
      running: rp.timer !== undefined, elapsedS: Number(rp.model.elapsedS.toFixed(1)),
      seed: rp.cfg.seed,
      ...(lt ? { last: lt } : {}),
    }
  })
  return head
}

/** 最近 N 行真值(JSONL 尾读;评测/可视化直接拉取)。id 缺省 = 主位遗留文件。 */
export function readTruth(limit = 500, id?: string): Array<Record<string, unknown>> {
  const cfg = getConfig()
  let file: string
  if (id) file = path.join(DATA_DIR, `truth-${id}.jsonl`)
  else file = path.join(DATA_DIR, 'truth.jsonl')
  if (id && cfg.plantModel && keyOf(cfg.plantModel) === id) file = path.join(DATA_DIR, 'truth.jsonl')
  if (!fs.existsSync(file)) return []
  const lines = fs.readFileSync(file, 'utf-8').trim().split('\n')
  return lines.slice(-limit - 1).filter(l => l && !l.includes('"meta"')).map(l => JSON.parse(l) as Record<string, unknown>)
}

/** 工况阶段切换(脚本驱动;阶段只做真值打标,SP 变更走真实协议写)。id 缺省 = 主位。 */
export function setPhase(phase: PlantTruthSample['phase'], disturbances?: PlantModelConfig['disturbances'], id?: string): PlantModelConfig | undefined {
  const cfg = getConfig()
  const target = id
    ? [...(cfg.plantModels ?? []), ...(cfg.plantModel ? [cfg.plantModel] : [])].find(m => m.id === id)
    : cfg.plantModel
  if (!target) return undefined
  target.phase = phase
  if (disturbances) target.disturbances = { ...(target.disturbances ?? {}), ...disturbances }
  saveConfig()
  return target
}

/** biax 遗留兼容:plant-runtime 外部曾按 BiaxControls 读主位控制面 */
export type { BiaxControls }
export function biaxNominalControls(): BiaxControls {
  return BIAX_NOMINAL
}
