/**
 * 场景预设 —— 一键生成对齐 AgentWorkShop DAQ 模板语义的完整模拟产线。
 * film-line:五协议各一设备,信号域与主项目全协议矩阵 e2e 的期望域一致,
 * 主项目建节点即可一一对应(温度 30-75/165-185、压力 0.5-1.25、张力、流量 38-48)。
 * cast-film-physics:挤出流延薄膜数字孪生产线 —— 全部 DAQ 值由 plant-model
 * 物理状态方程积分产出,6 DCW + 7 DAQ 跨五协议,含向量/图像检测帧。
 * biax-line:BOPET 双拉全线(9 设备 30 DCW + 19 DAQ)。
 * injection-line / wwtp-line / anneal-line:多场景共存预设(2026-09)——
 * 应用时**不整包替换现场**,只按 id 补建本场景节点并增量装载本场景物理引擎,
 * 与其他场景(cast-film/biax/彼此)同实例并存,可同时闭环优化。
 */
import type { DeviceNode, PlantBinding, PlantModelConfig } from '../shared/types'
import { getConfig, saveConfig, genId } from './store'
import { stopNode } from './runtime'
import { stopProtocol } from './protocols/registry'
import { startPlantModel, stopPlantModel, upsertPlantModel } from './engine/plant-runtime'
import { BIAX_NOMINAL } from './engine/biax-model'
import { INJECTION_NOMINAL } from './engine/injection-model'
import { WWTP_NOMINAL } from './engine/wwtp-model'
import { ANNEAL_NOMINAL } from './engine/anneal-model'

type Boot = (node: DeviceNode) => Promise<void>

/** 多场景共存预设(应用 = 按 id 差分补建 + 引擎增量装载,不动现场其他设备/引擎) */
export const MULTI_SCENARIO_KEYS = ['injection-line', 'wwtp-line', 'anneal-line'] as const

export async function replaceAll(nodes: DeviceNode[]): Promise<void> {
  for (const n of getConfig().nodes) {
    stopNode(n.id)
    await stopProtocol(n.id)
  }
  getConfig().nodes = nodes
  saveConfig()
}

export async function applyPreset(key: string, boot: Boot): Promise<DeviceNode[]> {
  if (key !== 'film-line' && key !== 'cast-film-physics' && key !== 'biax-line' && !MULTI_SCENARIO_KEYS.includes(key as never)) {
    throw new Error(`未知预设: ${key}`)
  }
  if (MULTI_SCENARIO_KEYS.includes(key as never)) {
    const { nodes, plantModel } = scenarioParts(key)
    // 差分补建:现场已有同 id 设备 → 原位替换信号/配置;缺 → 新建;其他设备不动
    const cur = getConfig()
    const byId = new Map(cur.nodes.map(n => [n.id, n]))
    for (const dev of nodes) {
      const exist = byId.get(dev.id)
      if (exist) {
        if (exist.enabled) { stopNode(exist.id); await stopProtocol(exist.id) }
        Object.assign(exist, { ...dev, runtime: {} })
      }
      else {
        cur.nodes.push({ ...dev, runtime: {} })
      }
    }
    saveConfig()
    // 引擎增量装载(id = 场景键),其他场景引擎不受影响;warm=热态直起标称工况
    upsertPlantModel(plantModel, /* warm */ true)
    for (const n of nodes) {
      const live = getConfig().nodes.find(x => x.id === n.id)
      if (live?.enabled) await boot(live)
    }
    return nodes
  }
  let nodes: DeviceNode[]
  if (key === 'film-line') {
    nodes = filmLinePreset()
    await replaceAll(nodes)
    stopPlantModel()
    getConfig().plantModel = undefined
    getConfig().plantModels = []
    saveConfig()
  }
  else {
    const { nodes: n, plantModel } = key === 'cast-film-physics' ? castFilmParts() : biaxParts()
    nodes = n
    await replaceAll(nodes)
    // ⚠️ 整包预设必须「全停旧引擎 → 热态重建」而非复用存量实例:
    // startPlantModel() 不带 warm 时对同 kind 已存引擎只刷新绑定(rp.cfg=pc),
    // 开机自启的持久化引擎(可能是上一个场景/上一次运行的残留状态)会带着
    // 旧模型的滞后态/运输线/漂移继续积分 —— 2026-09-21 实测表现为
    // 「 biax 使命写 SP 后厚度冻结在旧值、truth sp 与节点实际值系统性错位」。
    stopPlantModel()
    getConfig().plantModel = plantModel
    getConfig().plantModels = []
    saveConfig()
    startPlantModel(/* warm */ true)
  }
  for (const n of nodes) {
    if (n.enabled) await boot(n)
  }
  return nodes
}

function wasRunningCheck(_id: string): boolean {
  return false // 差分补建路径中设备已 stop,恒重新 boot
}

export function presetList(): Array<{ key: string, name: string }> {
  return [
    { key: 'film-line', name: '薄膜双拉产线(全协议,对齐主项目 DAQ 模板语义;独立信号策略)' },
    { key: 'cast-film-physics', name: '挤出流延薄膜数字孪生(plant-model 物理引擎:6 DCW + 7 DAQ 五协议,工况可闭环)' },
    { key: 'biax-line', name: '双拉薄膜产线数字孪生(BOPET 全线:干燥→挤出→铸片→MDO→TDO→测厚→电晕→收卷,30 DCW + 19 DAQ 五协议,目标驱动闭环寻优)' },
    { key: 'injection-line', name: '注塑成型数字孪生(注塑机+模温+注射保压+冷却+质检:11 DCW + 14 DAQ 五协议,克重窗口寻优;多场景共存)' },
    { key: 'wwtp-line', name: 'A2O 污水生化处理数字孪生(曝气+加药+回流排泥+进出水:7 DCW + 13 DAQ 五协议,达标降耗多目标;多场景共存)' },
    { key: 'anneal-line', name: '连续退火产线数字孪生(加热段+炉内传动+冷却过时效+保护气+质检:7 DCW + 11 DAQ 五协议,质量窗内产能最大;多场景共存)' },
  ]
}

/** 预设蓝图(dry-run,不动现场):供「探测→补建」式建线消费(如 bench 的 ensure 逻辑) */
export function presetBlueprint(key: string): { nodes: DeviceNode[], plantModel: PlantModelConfig | null } | null {
  if (key === 'film-line') return { nodes: filmLinePreset(), plantModel: null }
  if (key === 'cast-film-physics') { const p = castFilmParts(); return { nodes: p.nodes, plantModel: p.plantModel } }
  if (key === 'biax-line') { const p = biaxParts(); return { nodes: p.nodes, plantModel: p.plantModel } }
  if (MULTI_SCENARIO_KEYS.includes(key as never)) { const p = scenarioParts(key); return { nodes: p.nodes, plantModel: p.plantModel } }
  return null
}

/**
 * 挤出流延薄膜产线(cast-film-physics)。
 * 控制面(6 DCW,次优起点:zone=200℃,N=150rpm,v=95m/min → h≈53.8μm 偏厚,待 Agent 闭环寻优):
 *   zone1/2/3-sp  Modbus TCP 40021/23/25 (120~260℃)
 *   screw-sp      OPC UA ns=2;s=AW.N.Sp 可写 (50~200rpm)
 *   lineSpeed-sp  MQTT 命令主题 aw/sim/lineSp/set (20~120m/min)
 *   dieGap-sp     HTTP POST /api/control/diegap (0.5~2.0mm)
 * 采集面(7 DAQ,全部 plantBinding → 物理模型覆写):
 *   meltTemp(40001 MBTCP) meltPressure(OPC UA) filmThickness(MQTT)
 *   profile(HTTP vector) defectImage(HTTP PNG) defectRate(HTTP) gels(MBTCP-RTU 40001)
 */
export function castFilmParts(): { nodes: DeviceNode[], plantModel: PlantModelConfig } {
  const plantModel: PlantModelConfig = {
    enabled: true,
    seed: 42,
    dtMs: 500,
    timeScale: 6,
    phase: 'warmup',
    disturbances: { heaterDecay: 1, feedDriftPerMin: 0.15 },
    truthExport: true,
    optimum: null,
    controls: {} as Record<string, PlantBinding>, // 下方节点创建后回填
    outputs: {} as Partial<Record<string, PlantBinding>>,
  }
  // 起始控制点(次优,待闭环寻优)
  const SP = { zone: 200, screw: 150, lineSpeed: 95, dieGap: 1.0 }

  const extruder: DeviceNode = {
    id: 'dev-extruder-mbtcp',
    name: '挤出主机PLC(Modbus TCP)',
    protocol: 'modbus-tcp',
    enabled: true,
    tickMs: 800,
    signals: [
      { id: 'zone1-sp', name: '加热区1SP', unit: '℃', min: 120, max: 260, decimals: 1, strategy: { kind: 'manual', value: SP.zone } },
      { id: 'zone2-sp', name: '加热区2SP', unit: '℃', min: 120, max: 260, decimals: 1, strategy: { kind: 'manual', value: SP.zone } },
      { id: 'zone3-sp', name: '加热区3SP', unit: '℃', min: 120, max: 260, decimals: 1, strategy: { kind: 'manual', value: SP.zone } },
      { id: 'melt-temp', name: '熔体温度', unit: '℃', min: 0, max: 400, decimals: 2, plantBinding: 'meltTemp', strategy: { kind: 'constant', value: 25 } },
    ],
    config: {
      host: '0.0.0.0', port: 24040, unitId: 1,
      registerMaps: [
        { address: 40001, area: 'holding', signalId: 'melt-temp', dataType: 'float32', byteOrder: 'big' },
        { address: 40021, area: 'holding', signalId: 'zone1-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40023, area: 'holding', signalId: 'zone2-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40025, area: 'holding', signalId: 'zone3-sp', dataType: 'float32', byteOrder: 'big' },
      ],
    },
  }

  const rtuGels: DeviceNode = {
    id: 'dev-gels-rtu',
    name: '晶点计数从站(Modbus RTU)',
    protocol: 'modbus-rtu',
    enabled: true,
    tickMs: 1000,
    signals: [
      { id: 'gels-count', name: '晶点计数', unit: '个/m²', min: 0, max: 500, decimals: 0, plantBinding: 'gels', strategy: { kind: 'constant', value: 4 } },
    ],
    config: {
      host: '0.0.0.0', port: 23041, unitId: 1,
      registerMaps: [
        { address: 40001, area: 'holding', signalId: 'gels-count', dataType: 'float32', byteOrder: 'big' },
      ],
    },
  }

  const opcua: DeviceNode = {
    id: 'dev-extruder-opcua',
    name: '熔体泵送单元(OPC UA)',
    protocol: 'opcua',
    enabled: true,
    tickMs: 1000,
    signals: [
      { id: 'melt-pressure', name: 'MeltPressure', unit: 'MPa', min: 0, max: 45, decimals: 3, plantBinding: 'meltPressure', strategy: { kind: 'constant', value: 0.5 } },
      { id: 'screw-sp', name: 'ScrewSpeedSP', unit: 'rpm', min: 50, max: 200, decimals: 0, strategy: { kind: 'manual', value: SP.screw } },
    ],
    config: {
      host: '127.0.0.1', port: 13840, namespaceUri: 'PLC-Simulator',
      opcVars: [
        { nodeId: 'ns=2;s=AW.P', signalId: 'melt-pressure', dataType: 'Double' },
        { nodeId: 'ns=2;s=AW.N.Sp', signalId: 'screw-sp', dataType: 'Double', writable: true },
      ],
    },
  }

  const mqtt: DeviceNode = {
    id: 'dev-gauge-mqtt',
    name: '在线测厚仪(MQTT)',
    protocol: 'mqtt',
    enabled: true,
    tickMs: 2000,
    signals: [
      { id: 'film-thickness', name: 'thick', unit: 'μm', min: 0, max: 400, decimals: 2, plantBinding: 'filmThickness', strategy: { kind: 'constant', value: 0 } },
      { id: 'linespeed-sp', name: 'lineSpeedSP', unit: 'm/min', min: 20, max: 120, decimals: 1, strategy: { kind: 'manual', value: SP.lineSpeed } },
    ],
    config: {
      brokerUrl: 'mqtt://127.0.0.1:26830',
      topics: [
        { topic: 'aw/sim/thick', signalId: 'film-thickness', payloadTemplate: '{"data":{"thick":${value}}}', qos: 0 },
      ],
      commandTopic: 'aw/sim/lineSp/set',
      commandSignalId: 'linespeed-sp',
      stateTopic: 'aw/sim/lineSp/state',
    } as never,
  }

  const httpStation: DeviceNode = {
    id: 'dev-inspect-http',
    name: 'CCD检测站(HTTP)',
    protocol: 'http',
    enabled: true,
    tickMs: 1000,
    signals: [
      { id: 'thickness-profile', name: 'profile', unit: 'μm', min: 0, max: 400, decimals: 3, format: 'vector', plantBinding: 'profile', strategy: { kind: 'constant', value: 0 } },
      { id: 'ccd-image', name: 'ccd', unit: '灰度', min: 0, max: 255, format: 'image', plantBinding: 'defectImage', strategy: { kind: 'constant', value: 0 } },
      { id: 'defect-rate', name: 'defect', unit: '%', min: 0, max: 100, decimals: 3, plantBinding: 'defectRate', strategy: { kind: 'constant', value: 0 } },
      { id: 'diegap-sp', name: 'dieGapSP', unit: 'mm', min: 0.5, max: 2.0, decimals: 2, strategy: { kind: 'manual', value: SP.dieGap } },
    ],
    config: {
      paths: [
        { path: '/api/profile', signalId: 'thickness-profile', responseTemplate: '{"points":${points},"value":${value}}' },
        { path: '/api/ccd', signalId: 'ccd-image' },
        { path: '/api/defect', signalId: 'defect-rate', responseTemplate: '{"value":${value}}' },
        { path: '/api/control/diegap', signalId: 'diegap-sp', writable: true },
      ],
    },
  }

  const nodes = [extruder, rtuGels, opcua, mqtt, httpStation]
  plantModel.controls = {
    zone1: { nodeId: extruder.id, signalId: 'zone1-sp' },
    zone2: { nodeId: extruder.id, signalId: 'zone2-sp' },
    zone3: { nodeId: extruder.id, signalId: 'zone3-sp' },
    screw: { nodeId: opcua.id, signalId: 'screw-sp' },
    lineSpeed: { nodeId: mqtt.id, signalId: 'linespeed-sp' },
    dieGap: { nodeId: httpStation.id, signalId: 'diegap-sp' },
  }
  plantModel.outputs = {
    meltTemp: { nodeId: extruder.id, signalId: 'melt-temp' },
    meltPressure: { nodeId: opcua.id, signalId: 'melt-pressure' },
    filmThickness: { nodeId: mqtt.id, signalId: 'film-thickness' },
    profile: { nodeId: httpStation.id, signalId: 'thickness-profile' },
    defectImage: { nodeId: httpStation.id, signalId: 'ccd-image' },
    defectRate: { nodeId: httpStation.id, signalId: 'defect-rate' },
    gels: { nodeId: rtuGels.id, signalId: 'gels-count' },
  }
  return { nodes, plantModel }
}

/**
 * 双向拉伸薄膜产线(biax-line,BOPET 类全线数字孪生)。
 * 物料链:干燥上料(OPC UA)→ 挤出铸片(Modbus TCP ×2 + 计量泵 RTU)→
 *   纵拉 MDO(Modbus TCP)→ 横拉 TDO 烘箱(OPC UA)→ 在线测厚(MQTT)→
 *   电晕/表面检测(HTTP)→ 收卷(Modbus TCP)。
 * 控制面 30 DCW(全线工艺 SP,含单位/量程/工艺语义描述) + 采集面 19 DAQ(物理量)。
 * 起始工况 BIAX_NOMINAL:成品厚度 ≈27.5 μm 偏厚(规格 25.0±0.8),待闭环寻优。
 */
export function biaxParts(): { nodes: DeviceNode[], plantModel: PlantModelConfig } {
  const SP = BIAX_NOMINAL
  const plantModel: PlantModelConfig = {
    kind: 'biax',
    enabled: true,
    seed: 42,
    dtMs: 500,
    timeScale: 6,
    phase: 'warmup',
    disturbances: { heaterDecay: 1, feedDriftPerMin: 0.1 },
    truthExport: true,
    optimum: null,
    controls: {} as Record<string, PlantBinding>, // 下方节点定义后回填
    outputs: {} as Partial<Record<string, PlantBinding>>,
  }

  const dryer: DeviceNode = {
    id: 'biax-dryer-opcua',
    name: '原料干燥上料单元(OPC UA)',
    description: 'PET 切片预结晶/干燥塔与失重喂料。上游第一段:残水与特性粘度控制决定熔体质量上限。',
    protocol: 'opcua',
    enabled: true,
    tickMs: 1000,
    signals: [
      { id: 'dry-temp-sp', name: '干燥温度SP', description: '干燥塔热风温度设定。PET 预结晶/干燥入口,建议 165~180℃;过低→残水升高(水解除醛劣化),过高→切片结块架桥', unit: '℃', min: 120, max: 200, decimals: 1, strategy: { kind: 'manual', value: SP.dryTemp } },
      { id: 'dew-point-sp', name: '露点SP', description: '干燥空气露点设定(分子筛/冷冻式)。光学级 PET 要求 ≤−40℃;露点升高直接推高切片残水', unit: '℃', min: -80, max: -20, decimals: 0, strategy: { kind: 'manual', value: SP.dewPoint } },
      { id: 'feed-rate-sp', name: '喂料速率SP', description: '失重式喂料设定(kg/h),计量泵的上游供给;低于挤出耗量会引发进料不足与熔压波动', unit: 'kg/h', min: 100, max: 1200, decimals: 0, strategy: { kind: 'manual', value: SP.feedRate } },
      { id: 'dry-temp-pv', name: '干燥塔温度', description: '干燥塔实测热风温度(采集)', unit: '℃', min: 20, max: 220, decimals: 1, plantBinding: 'dryTemp', strategy: { kind: 'constant', value: 25 } },
      { id: 'moisture-pv', name: '切片残水', description: '出口切片残余水分(ppm,采集);>30 ppm 进入水解除醛劣化区,缺陷与雾度上升', unit: 'ppm', min: 0, max: 120, decimals: 1, plantBinding: 'moisture', strategy: { kind: 'constant', value: 5 } },
    ],
    config: {
      host: '127.0.0.1', port: 13841, namespaceUri: 'PLC-Simulator-Biax-Dryer',
      opcVars: [
        { nodeId: 'ns=2;s=Biax.Dry.Temp.Sp', signalId: 'dry-temp-sp', dataType: 'Double', writable: true },
        { nodeId: 'ns=2;s=Biax.Dry.Dew.Sp', signalId: 'dew-point-sp', dataType: 'Double', writable: true },
        { nodeId: 'ns=2;s=Biax.Dry.Feed.Sp', signalId: 'feed-rate-sp', dataType: 'Double', writable: true },
        { nodeId: 'ns=2;s=Biax.Dry.Temp.PV', signalId: 'dry-temp-pv', dataType: 'Double' },
        { nodeId: 'ns=2;s=Biax.Dry.Moist.PV', signalId: 'moisture-pv', dataType: 'Double' },
      ],
    },
  }

  const extruder: DeviceNode = {
    id: 'biax-extruder-mbtcp',
    name: '挤出主机PLC(Modbus TCP)',
    description: 'PET 单螺杆挤出机:机筒五区加热 + 螺杆驱动。塑化段,决定熔体温度与均匀性。',
    protocol: 'modbus-tcp',
    enabled: true,
    tickMs: 800,
    signals: [
      { id: 'zone1-sp', name: '机筒温度区1SP', description: '机筒进料段温度(水冷进料口防架桥),五区最低的一区', unit: '℃', min: 220, max: 300, decimals: 1, strategy: { kind: 'manual', value: SP.zone1 } },
      { id: 'zone2-sp', name: '机筒温度区2SP', description: '机筒压缩段温度,物料开始熔融', unit: '℃', min: 220, max: 300, decimals: 1, strategy: { kind: 'manual', value: SP.zone2 } },
      { id: 'zone3-sp', name: '机筒温度区3SP', description: '机筒熔融段中段温度', unit: '℃', min: 220, max: 300, decimals: 1, strategy: { kind: 'manual', value: SP.zone3 } },
      { id: 'zone4-sp', name: '机筒温度区4SP', description: '机筒计量段温度,塑化均化', unit: '℃', min: 220, max: 300, decimals: 1, strategy: { kind: 'manual', value: SP.zone4 } },
      { id: 'zone5-sp', name: '机筒温度区5SP', description: '机筒出口段温度,紧邻过滤器;与熔体温度强相关(建议 285~295℃)', unit: '℃', min: 220, max: 300, decimals: 1, strategy: { kind: 'manual', value: SP.zone5 } },
      { id: 'screw-sp', name: '螺杆转速SP', description: '主螺杆转速(rpm)。维持供料压力;剪切热叠加进熔体温度(约 +0.09℃/rpm)', unit: 'rpm', min: 20, max: 100, decimals: 0, strategy: { kind: 'manual', value: SP.screw } },
      { id: 'melt-temp', name: '熔体温度', description: '模前熔体实测温度(采集);PET 工艺窗 268~300℃,超窗即联锁', unit: '℃', min: 200, max: 330, decimals: 1, plantBinding: 'meltTemp', strategy: { kind: 'constant', value: 280 } },
      { id: 'melt-pressure', name: '泵前熔压', description: '过滤器前熔体压力(采集);反映过滤网堵塞与熔体粘度变化', unit: 'MPa', min: 0, max: 35, decimals: 2, plantBinding: 'meltPressure', strategy: { kind: 'constant', value: 12 } },
    ],
    config: {
      host: '0.0.0.0', port: 24042, unitId: 1,
      registerMaps: [
        { address: 40001, area: 'holding', signalId: 'melt-temp', dataType: 'float32', byteOrder: 'big' },
        { address: 40003, area: 'holding', signalId: 'melt-pressure', dataType: 'float32', byteOrder: 'big' },
        { address: 40021, area: 'holding', signalId: 'zone1-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40023, area: 'holding', signalId: 'zone2-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40025, area: 'holding', signalId: 'zone3-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40027, area: 'holding', signalId: 'zone4-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40029, area: 'holding', signalId: 'zone5-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40031, area: 'holding', signalId: 'screw-sp', dataType: 'float32', byteOrder: 'big' },
      ],
    },
  }

  const pump: DeviceNode = {
    id: 'biax-pump-rtu',
    name: '熔体计量泵站(Modbus RTU)',
    description: '熔体齿轮泵 + 换网过滤器撬块。挤出流量的权威控制量,比螺杆转速更平稳。',
    protocol: 'modbus-rtu',
    enabled: true,
    tickMs: 1000,
    signals: [
      { id: 'pump-sp', name: '计量泵转速SP', description: '齿轮泵转速(rpm)——挤出流量的第一控制量;与铸片厚度成正比、与线速度/拉比共同决定成品厚度', unit: 'rpm', min: 15, max: 60, decimals: 1, strategy: { kind: 'manual', value: SP.pump } },
      { id: 'pump-outlet', name: '泵出口压力', description: '齿轮泵出口压力(采集);>32 MPa 触发联锁(模头/过滤堵塞风险)', unit: 'MPa', min: 0, max: 35, decimals: 2, plantBinding: 'pumpOutlet', strategy: { kind: 'constant', value: 17 } },
    ],
    config: {
      host: '0.0.0.0', port: 23042, unitId: 1,
      registerMaps: [
        { address: 40001, area: 'holding', signalId: 'pump-outlet', dataType: 'float32', byteOrder: 'big' },
        { address: 40021, area: 'holding', signalId: 'pump-sp', dataType: 'float32', byteOrder: 'big' },
      ],
    },
  }

  const casting: DeviceNode = {
    id: 'biax-casting-mbtcp',
    name: '模头铸片单元(Modbus TCP)',
    description: 'T 模头 + 静电毛贴 + 急冷辊(casting drum)。铸片厚度与横向分布在这里定型。',
    protocol: 'modbus-tcp',
    enabled: true,
    tickMs: 800,
    signals: [
      { id: 'die-lip-sp', name: '模唇温度SP', description: 'T 模头模唇加热区温度;经热膨胀微调横向厚度分布(人工/自动螺栓的替身),偏离 285℃ 过大会加剧轮廓凹凸', unit: '℃', min: 250, max: 300, decimals: 1, strategy: { kind: 'manual', value: SP.dieLip } },
      { id: 'chill-temp-sp', name: '急冷辊温度SP', description: '铸片冷辊冷冻水温度;PET 常用 20~35℃;过高→铸片结晶发脆、雾度升高', unit: '℃', min: 10, max: 60, decimals: 1, strategy: { kind: 'manual', value: SP.chillTemp } },
      { id: 'cast-spd-sp', name: '铸片辊速度SP', description: '铸片线速度(m/min)——铸片厚度第一控制量(厚度 ∝ 1/速度);须与 MDO/TDO 拉速保持级配', unit: 'm/min', min: 10, max: 60, decimals: 1, strategy: { kind: 'manual', value: SP.castSpd } },
      { id: 'pinning-sp', name: '静电吸附电压SP', description: '静电毛贴(针电极)电压 kV,把熔膜贴牢冷辊防抖动;<5 kV 边缘贴附不良→横向厚度 σ 恶化', unit: 'kV', min: 4, max: 12, decimals: 1, strategy: { kind: 'manual', value: SP.pinning } },
      { id: 'cast-temp-pv', name: '铸片辊面温度', description: '冷辊出口膜面温度(采集)', unit: '℃', min: 0, max: 80, decimals: 1, plantBinding: 'castTemp', strategy: { kind: 'constant', value: 30 } },
    ],
    config: {
      host: '0.0.0.0', port: 24044, unitId: 1,
      registerMaps: [
        { address: 40001, area: 'holding', signalId: 'cast-temp-pv', dataType: 'float32', byteOrder: 'big' },
        { address: 40021, area: 'holding', signalId: 'die-lip-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40023, area: 'holding', signalId: 'chill-temp-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40025, area: 'holding', signalId: 'cast-spd-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40027, area: 'holding', signalId: 'pinning-sp', dataType: 'float32', byteOrder: 'big' },
      ],
    },
  }

  const mdo: DeviceNode = {
    id: 'biax-mdo-mbtcp',
    name: '纵向拉伸MDO单元(Modbus TCP)',
    description: '纵拉机:预热辊组 ×3 + 慢/快辊拉伸对 + 退火辊。纵向分子取向在此发生。',
    protocol: 'modbus-tcp',
    enabled: true,
    tickMs: 800,
    signals: [
      { id: 'mdo-preheat1-sp', name: '预热辊1温度SP', description: 'MDO 预热辊组第 1 辊(入口);三辊递升把膜温带入高弹态', unit: '℃', min: 70, max: 140, decimals: 1, strategy: { kind: 'manual', value: SP.mdoPreheat1 } },
      { id: 'mdo-preheat2-sp', name: '预热辊2温度SP', description: 'MDO 预热辊组第 2 辊(中段)', unit: '℃', min: 70, max: 140, decimals: 1, strategy: { kind: 'manual', value: SP.mdoPreheat2 } },
      { id: 'mdo-preheat3-sp', name: '预热辊3温度SP', description: 'MDO 预热辊组第 3 辊(拉伸前);膜温应到达 86~110℃ 拉伸窗', unit: '℃', min: 70, max: 140, decimals: 1, strategy: { kind: 'manual', value: SP.mdoPreheat3 } },
      { id: 'slow-roll-sp', name: '慢辊线速度SP', description: '纵拉拉伸区入口(慢辊)速度;快/慢辊速比即纵向拉伸比 R_md=快/慢', unit: 'm/min', min: 10, max: 80, decimals: 1, strategy: { kind: 'manual', value: SP.slowRoll } },
      { id: 'fast-roll-sp', name: '快辊线速度SP', description: '纵拉出口(快辊)速度;提高快辊→拉伸比增大→厚度按比例减薄(PET 常用 R_md 2.5~3.3)', unit: 'm/min', min: 30, max: 260, decimals: 1, strategy: { kind: 'manual', value: SP.fastRoll } },
      { id: 'mdo-anneal-sp', name: '纵拉退火辊SP', description: '纵拉后定型辊温;缓释纵向内应力,影响热收缩与横向分布', unit: '℃', min: 90, max: 170, decimals: 1, strategy: { kind: 'manual', value: SP.mdoAnneal } },
      { id: 'mdo-film-temp', name: '纵拉膜温', description: '纵拉区薄膜实测温度(采集);拉伸窗 86~110℃(≈Tg+8~Tg+32),低于窗口→颈缩/破膜', unit: '℃', min: 40, max: 160, decimals: 1, plantBinding: 'mdoTemp', strategy: { kind: 'constant', value: 100 } },
      { id: 'mdo-ratio-pv', name: '纵拉实际拉伸比', description: '快/慢辊实测速比(采集)', unit: '', min: 1, max: 5, decimals: 2, plantBinding: 'mdRatio', strategy: { kind: 'constant', value: 2.8 } },
    ],
    config: {
      host: '0.0.0.0', port: 24046, unitId: 1,
      registerMaps: [
        { address: 40001, area: 'holding', signalId: 'mdo-film-temp', dataType: 'float32', byteOrder: 'big' },
        { address: 40003, area: 'holding', signalId: 'mdo-ratio-pv', dataType: 'float32', byteOrder: 'big' },
        { address: 40021, area: 'holding', signalId: 'mdo-preheat1-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40023, area: 'holding', signalId: 'mdo-preheat2-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40025, area: 'holding', signalId: 'mdo-preheat3-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40027, area: 'holding', signalId: 'slow-roll-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40029, area: 'holding', signalId: 'fast-roll-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40031, area: 'holding', signalId: 'mdo-anneal-sp', dataType: 'float32', byteOrder: 'big' },
      ],
    },
  }

  const tdo: DeviceNode = {
    id: 'biax-tdo-opcua',
    name: '横向拉伸TDO烘箱(OPC UA)',
    description: '拉幅机(tenter):预热/拉伸/定型三段烘箱 + 链夹 + 轨道展幅。横向取向与结晶定型在此完成。',
    protocol: 'opcua',
    enabled: true,
    tickMs: 1000,
    signals: [
      { id: 'tdo-preheat-sp', name: 'TDO预热段SP', description: '横拉烘箱预热段温度;把纵拉膜重新升温至拉伸准备态', unit: '℃', min: 80, max: 140, decimals: 1, strategy: { kind: 'manual', value: SP.tdoPreheat } },
      { id: 'tdo-stretch-sp', name: 'TDO拉伸段SP', description: '横拉拉伸段温度;窗口 98~128℃——过低→破膜掉边,过高→不均匀减薄', unit: '℃', min: 90, max: 150, decimals: 1, strategy: { kind: 'manual', value: SP.tdoStretch } },
      { id: 'tdo-anneal-sp', name: 'TDO定型段SP', description: '横拉定型/退火段温度;PET 结晶定型 200~235℃;过低→雾度与热收缩劣化,过高→松弛减薄', unit: '℃', min: 180, max: 250, decimals: 1, strategy: { kind: 'manual', value: SP.tdoAnneal } },
      { id: 'chain-sp', name: '链夹速度SP', description: '拉幅机链夹线速度 = 产线主速度(m/min);决定烤箱驻留时间与产能', unit: 'm/min', min: 40, max: 260, decimals: 0, strategy: { kind: 'manual', value: SP.chain } },
      { id: 'rail-out-sp', name: '出口轨宽SP', description: '横拉出口轨道宽度(mm);入口宽≈铸片宽,出口/入口即横向拉伸比 R_td;增大轨宽→厚度按比例减薄(BOPET 常用 R_td 3.0~3.6)', unit: 'mm', min: 1800, max: 4200, decimals: 0, strategy: { kind: 'manual', value: SP.railOut } },
      { id: 'tdo-temp-pv', name: '烘箱膜温', description: 'TDO 出口膜温(采集,三段加权)', unit: '℃', min: 60, max: 260, decimals: 1, plantBinding: 'tdoTemp', strategy: { kind: 'constant', value: 160 } },
      { id: 'td-ratio-pv', name: '横拉实际拉伸比', description: '出口/入口轨宽实测比(采集)', unit: '', min: 1, max: 5.5, decimals: 2, plantBinding: 'tdRatio', strategy: { kind: 'constant', value: 3.2 } },
      { id: 'rail-width-pv', name: '轨道实测宽度', description: '出口轨道实测宽度(采集)', unit: 'mm', min: 1500, max: 4500, decimals: 0, plantBinding: 'railWidth', strategy: { kind: 'constant', value: 3000 } },
    ],
    config: {
      host: '127.0.0.1', port: 13842, namespaceUri: 'PLC-Simulator-Biax-Tdo',
      opcVars: [
        { nodeId: 'ns=2;s=Biax.Tdo.Pre.Sp', signalId: 'tdo-preheat-sp', dataType: 'Double', writable: true },
        { nodeId: 'ns=2;s=Biax.Tdo.Str.Sp', signalId: 'tdo-stretch-sp', dataType: 'Double', writable: true },
        { nodeId: 'ns=2;s=Biax.Tdo.Ann.Sp', signalId: 'tdo-anneal-sp', dataType: 'Double', writable: true },
        { nodeId: 'ns=2;s=Biax.Tdo.Chain.Sp', signalId: 'chain-sp', dataType: 'Double', writable: true },
        { nodeId: 'ns=2;s=Biax.Tdo.Rail.Sp', signalId: 'rail-out-sp', dataType: 'Double', writable: true },
        { nodeId: 'ns=2;s=Biax.Tdo.T.PV', signalId: 'tdo-temp-pv', dataType: 'Double' },
        { nodeId: 'ns=2;s=Biax.Tdo.Ratio.PV', signalId: 'td-ratio-pv', dataType: 'Double' },
        { nodeId: 'ns=2;s=Biax.Tdo.Rail.PV', signalId: 'rail-width-pv', dataType: 'Double' },
      ],
    },
  }

  const gauge: DeviceNode = {
    id: 'biax-gauge-mqtt',
    name: '在线测厚仪(MQTT)',
    description: 'TDO 出口透射式测厚仪(扫描架):全线平均厚度与横向 σ 的质量关。',
    protocol: 'mqtt',
    enabled: true,
    tickMs: 2000,
    signals: [
      { id: 'biax-thickness', name: 'biaxThick', description: '成品全线平均厚度(采集);当前规格 25.0±0.8 μm——闭环寻优的被控量', unit: 'μm', min: 0, max: 80, decimals: 2, plantBinding: 'thickness', strategy: { kind: 'constant', value: 25 } },
      { id: 'thickness-sigma', name: 'biaxSigma', description: '横向厚度标准差(采集);光学级要求 σ/均值 ≤1.2%', unit: 'μm', min: 0, max: 10, decimals: 3, plantBinding: 'sigma', strategy: { kind: 'constant', value: 0.25 } },
    ],
    config: {
      brokerUrl: 'mqtt://127.0.0.1:26830',
      topics: [
        { topic: 'aw/biax/thick', signalId: 'biax-thickness', payloadTemplate: '{"data":{"thick":${value}}}', qos: 0 },
        { topic: 'aw/biax/sigma', signalId: 'thickness-sigma', payloadTemplate: '{"data":{"sigma":${value}}}', qos: 0 },
      ],
    } as never,
  }

  const inspect: DeviceNode = {
    id: 'biax-inspect-http',
    name: '电晕处理与表面检测站(HTTP)',
    description: '电晕处理机 + 在线表面检测(轮廓/缺陷/雾度/达因)。后处理质量段。',
    protocol: 'http',
    enabled: true,
    tickMs: 1000,
    signals: [
      { id: 'corona-sp', name: 'coronaPower', description: '电晕处理功率(kW);决定表面张力——印刷/镀铝要求 ≥38~42 dyn/cm', unit: 'kW', min: 0.5, max: 8, decimals: 1, strategy: { kind: 'manual', value: SP.corona } },
      { id: 'biax-profile', name: 'biaxProfile', description: '横向厚度轮廓 64 点向量帧(采集)', unit: 'μm', min: 0, max: 80, decimals: 3, format: 'vector', plantBinding: 'profile', strategy: { kind: 'constant', value: 25 } },
      { id: 'biax-defect', name: 'biaxDefect', description: '表面缺陷率(采集,%)——破膜/颈缩/皱折/晶点的综合表现;规格 ≤1.0%', unit: '%', min: 0, max: 10, decimals: 3, plantBinding: 'defect', strategy: { kind: 'constant', value: 0.2 } },
      { id: 'biax-haze', name: 'biaxHaze', description: '雾度(采集,%);定型段温度不足或残水超标会推高', unit: '%', min: 0, max: 10, decimals: 2, plantBinding: 'haze', strategy: { kind: 'constant', value: 0.6 } },
      { id: 'dyne-level', name: 'biaxDyne', description: '表面达因值(采集,dyn/cm);电晕功率的对数映射', unit: 'dyn/cm', min: 30, max: 60, decimals: 0, plantBinding: 'dyne', strategy: { kind: 'constant', value: 42 } },
    ],
    config: {
      paths: [
        { path: '/api/control/corona', signalId: 'corona-sp', writable: true },
        { path: '/api/profile', signalId: 'biax-profile', responseTemplate: '{"points":${points},"value":${value}}' },
        { path: '/api/defect', signalId: 'biax-defect', responseTemplate: '{"value":${value}}' },
        { path: '/api/haze', signalId: 'biax-haze', responseTemplate: '{"value":${value}}' },
        { path: '/api/dyne', signalId: 'dyne-level', responseTemplate: '{"value":${value}}' },
      ],
    },
  }

  const winder: DeviceNode = {
    id: 'biax-winder-mbtcp',
    name: '收卷单元(Modbus TCP)',
    description: '中心卷取式收卷机:张力锥度控制 + 接触辊 + 卷径测量。产线末段。',
    protocol: 'modbus-tcp',
    enabled: true,
    tickMs: 800,
    signals: [
      { id: 'winder-tension-sp', name: '收卷张力SP', description: '收卷张力设定(N,锥度基准);过高→拉伸/勒痕,过低→松卷窜动;工作窗 55~120 N', unit: 'N', min: 30, max: 180, decimals: 1, strategy: { kind: 'manual', value: SP.windTension } },
      { id: 'taper-sp', name: '张力锥度SP', description: '锥度系数(%):随卷径增大张力线性衰减,防外卷勒伤', unit: '%', min: 10, max: 60, decimals: 0, strategy: { kind: 'manual', value: SP.windTaper } },
      { id: 'contact-press-sp', name: '接触辊压力SP', description: '收卷接触辊压紧力(bar);<0.9 易夹气起皱', unit: 'bar', min: 0.3, max: 4, decimals: 2, strategy: { kind: 'manual', value: SP.windContact } },
      { id: 'winder-speed-sp', name: '卷取速度上限SP', description: '卷取速度上限(m/min,张力舞辊随动);与链夹速度联锁', unit: 'm/min', min: 60, max: 320, decimals: 0, strategy: { kind: 'manual', value: SP.windSpeed } },
      { id: 'winder-tension-pv', name: '实际收卷张力', description: '张力传感器实测(采集)', unit: 'N', min: 0, max: 220, decimals: 1, plantBinding: 'tension', strategy: { kind: 'constant', value: 88 } },
      { id: 'roll-diameter', name: '卷径', description: '当前卷径(超声测距,采集);锥度张力与换卷逻辑的输入', unit: 'm', min: 0.05, max: 1.5, decimals: 3, plantBinding: 'rollDia', strategy: { kind: 'constant', value: 0.15 } },
    ],
    config: {
      host: '0.0.0.0', port: 24048, unitId: 1,
      registerMaps: [
        { address: 40001, area: 'holding', signalId: 'winder-tension-pv', dataType: 'float32', byteOrder: 'big' },
        { address: 40003, area: 'holding', signalId: 'roll-diameter', dataType: 'float32', byteOrder: 'big' },
        { address: 40021, area: 'holding', signalId: 'winder-tension-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40023, area: 'holding', signalId: 'taper-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40025, area: 'holding', signalId: 'contact-press-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40027, area: 'holding', signalId: 'winder-speed-sp', dataType: 'float32', byteOrder: 'big' },
      ],
    },
  }

  const nodes = [dryer, extruder, pump, casting, mdo, tdo, gauge, inspect, winder]
  plantModel.controls = {
    dryTemp: { nodeId: dryer.id, signalId: 'dry-temp-sp' },
    dewPoint: { nodeId: dryer.id, signalId: 'dew-point-sp' },
    feedRate: { nodeId: dryer.id, signalId: 'feed-rate-sp' },
    zone1: { nodeId: extruder.id, signalId: 'zone1-sp' },
    zone2: { nodeId: extruder.id, signalId: 'zone2-sp' },
    zone3: { nodeId: extruder.id, signalId: 'zone3-sp' },
    zone4: { nodeId: extruder.id, signalId: 'zone4-sp' },
    zone5: { nodeId: extruder.id, signalId: 'zone5-sp' },
    screw: { nodeId: extruder.id, signalId: 'screw-sp' },
    pump: { nodeId: pump.id, signalId: 'pump-sp' },
    dieLip: { nodeId: casting.id, signalId: 'die-lip-sp' },
    chillTemp: { nodeId: casting.id, signalId: 'chill-temp-sp' },
    castSpd: { nodeId: casting.id, signalId: 'cast-spd-sp' },
    pinning: { nodeId: casting.id, signalId: 'pinning-sp' },
    mdoPreheat1: { nodeId: mdo.id, signalId: 'mdo-preheat1-sp' },
    mdoPreheat2: { nodeId: mdo.id, signalId: 'mdo-preheat2-sp' },
    mdoPreheat3: { nodeId: mdo.id, signalId: 'mdo-preheat3-sp' },
    slowRoll: { nodeId: mdo.id, signalId: 'slow-roll-sp' },
    fastRoll: { nodeId: mdo.id, signalId: 'fast-roll-sp' },
    mdoAnneal: { nodeId: mdo.id, signalId: 'mdo-anneal-sp' },
    tdoPreheat: { nodeId: tdo.id, signalId: 'tdo-preheat-sp' },
    tdoStretch: { nodeId: tdo.id, signalId: 'tdo-stretch-sp' },
    tdoAnneal: { nodeId: tdo.id, signalId: 'tdo-anneal-sp' },
    chain: { nodeId: tdo.id, signalId: 'chain-sp' },
    railOut: { nodeId: tdo.id, signalId: 'rail-out-sp' },
    corona: { nodeId: inspect.id, signalId: 'corona-sp' },
    windTension: { nodeId: winder.id, signalId: 'winder-tension-sp' },
    windTaper: { nodeId: winder.id, signalId: 'taper-sp' },
    windContact: { nodeId: winder.id, signalId: 'contact-press-sp' },
    windSpeed: { nodeId: winder.id, signalId: 'winder-speed-sp' },
  }
  plantModel.outputs = {
    dryTemp: { nodeId: dryer.id, signalId: 'dry-temp-pv' },
    moisture: { nodeId: dryer.id, signalId: 'moisture-pv' },
    meltTemp: { nodeId: extruder.id, signalId: 'melt-temp' },
    meltPressure: { nodeId: extruder.id, signalId: 'melt-pressure' },
    pumpOutlet: { nodeId: pump.id, signalId: 'pump-outlet' },
    castTemp: { nodeId: casting.id, signalId: 'cast-temp-pv' },
    mdoTemp: { nodeId: mdo.id, signalId: 'mdo-film-temp' },
    mdRatio: { nodeId: mdo.id, signalId: 'mdo-ratio-pv' },
    tdoTemp: { nodeId: tdo.id, signalId: 'tdo-temp-pv' },
    tdRatio: { nodeId: tdo.id, signalId: 'td-ratio-pv' },
    railWidth: { nodeId: tdo.id, signalId: 'rail-width-pv' },
    thickness: { nodeId: gauge.id, signalId: 'biax-thickness' },
    sigma: { nodeId: gauge.id, signalId: 'thickness-sigma' },
    profile: { nodeId: inspect.id, signalId: 'biax-profile' },
    defect: { nodeId: inspect.id, signalId: 'biax-defect' },
    haze: { nodeId: inspect.id, signalId: 'biax-haze' },
    dyne: { nodeId: inspect.id, signalId: 'dyne-level' },
    tension: { nodeId: winder.id, signalId: 'winder-tension-pv' },
    rollDia: { nodeId: winder.id, signalId: 'roll-diameter' },
  }
  return { nodes, plantModel }
}

export function filmLinePreset(): DeviceNode[] {
  return [
    {
      id: genId('dev'),
      name: 'Coating Oven PLC',
      protocol: 'modbus-tcp',
      enabled: true,
      tickMs: 800,
      signals: [
        { id: 'temp-pv', name: 'Temp PV', unit: '℃', min: 0, max: 260, decimals: 1, tickMs: 800,
          strategy: { kind: 'first-order', initial: 24, tauMs: 8000, sp: 180, noise: 0.25 } },
        { id: 'temp-sp', name: 'Temp SP', unit: '℃', min: 0, max: 260, decimals: 1,
          strategy: { kind: 'manual', value: 180 } },
        { id: 'pressure', name: 'Pressure PV', unit: 'MPa', min: 0, max: 2, decimals: 3,
          strategy: { kind: 'sine', base: 0.85, amp: 0.12, periodMs: 30000 } },
        { id: 'tension', name: 'Tension PV', unit: 'N', min: 0, max: 200, decimals: 1,
          strategy: { kind: 'random-walk', start: 120, step: 1.5, min: 80, max: 160 } },
        { id: 'speed', name: 'Speed PV', unit: 'm/min', min: 0, max: 300, decimals: 1,
          strategy: { kind: 'sine', base: 150, amp: 8, periodMs: 20000 } },
      ],
      config: {
        host: '0.0.0.0', port: 24040, unitId: 1,
        registerMaps: [
          { address: 40001, area: 'holding', signalId: 'temp-pv', dataType: 'float32', byteOrder: 'big' },
          { address: 40021, area: 'holding', signalId: 'temp-sp', dataType: 'float32', byteOrder: 'big', writebackTarget: 'temp-pv' },
          { address: 40003, area: 'holding', signalId: 'pressure', dataType: 'float32', byteOrder: 'big' },
          { address: 40005, area: 'holding', signalId: 'tension', dataType: 'float32', byteOrder: 'big' },
          { address: 40007, area: 'holding', signalId: 'speed', dataType: 'float32', byteOrder: 'big' },
        ],
      },
    },
    {
      id: genId('dev'),
      name: 'Remote RTU Temp Slave',
      protocol: 'modbus-rtu',
      enabled: true,
      tickMs: 1000,
      signals: [
        { id: 'rtu-temp', name: 'Furnace Temp', unit: '℃', min: 0, max: 100, decimals: 1,
          strategy: { kind: 'sine', base: 66, amp: 3, periodMs: 15000 } },
      ],
      config: {
        host: '0.0.0.0', port: 23041, unitId: 1,
        registerMaps: [
          { address: 40001, area: 'holding', signalId: 'rtu-temp', dataType: 'float32', byteOrder: 'big' },
        ],
      },
    },
    {
      id: genId('dev'),
      name: 'OPC UA Temp Controller',
      protocol: 'opcua',
      enabled: true,
      tickMs: 1000,
      signals: [
        { id: 'opc-temp', name: 'Temp', unit: '℃', min: 0, max: 260, decimals: 2,
          strategy: { kind: 'first-order', initial: 168, tauMs: 8000, sp: 180, noise: 0.3 } },
        { id: 'opc-sp', name: 'SetTemp', unit: '℃', min: 0, max: 260, decimals: 1,
          strategy: { kind: 'manual', value: 180 } },
      ],
      config: {
        host: '127.0.0.1', port: 13840, namespaceUri: 'PLC-Simulator',
        opcVars: [
          { nodeId: 'ns=2;s=AW.Temp', signalId: 'opc-temp', dataType: 'Double' },
          { nodeId: 'ns=2;s=AW.SetTemp', signalId: 'opc-sp', dataType: 'Double', writable: true },
        ],
      },
    },
    {
      id: genId('dev'),
      name: 'MQTT Temp Sensor',
      protocol: 'mqtt',
      enabled: true,
      tickMs: 2000,
      signals: [
        { id: 'mqtt-temp', name: 'temp', unit: '℃', min: 0, max: 100, decimals: 2,
          strategy: { kind: 'random-walk', start: 50, step: 2, min: 30, max: 75 } },
        { id: 'mqtt-sp', name: 'tempSP', unit: '℃', min: 0, max: 100, decimals: 1,
          strategy: { kind: 'manual', value: 60 } },
      ],
      config: {
        brokerUrl: 'mqtt://127.0.0.1:26830',
        topics: [
          { topic: 'aw/sim/temp', signalId: 'mqtt-temp', payloadTemplate: '{"data":{"temp":${value}}}', qos: 0 },
        ],
        commandTopic: 'aw/sim/setpoint',
        commandSignalId: 'mqtt-sp' as never,
        stateTopic: 'aw/sim/state',
      },
    },
    {
      id: genId('dev'),
      name: 'HTTP Flow Meter',
      protocol: 'http',
      enabled: true,
      tickMs: 1000,
      signals: [
        { id: 'flow', name: 'Flow', unit: 'L/min', min: 0, max: 100, decimals: 2,
          strategy: { kind: 'sine', base: 42.5, amp: 0.5, periodMs: 10000 } },
      ],
      config: {
        paths: [
          { path: '/api/value', signalId: 'flow', responseTemplate: '{"data":{"value":${value}}}' },
        ],
      },
    },
  ] as DeviceNode[]
}

// ============================================================
// 多场景共存预设(2026-09):injection-line / wwtp-line / anneal-line
// 五协议各一台设备;SP(可写,工艺参数)与 PV(采集,检测/性能量)严格分离,
// 全部信号带 description(平台 semantics → Agent 语义卡消费)。
// 引擎键 id 与预设键一一对应(injection/wwtp/anneal)。
// ============================================================

function scenarioParts(key: string): { nodes: DeviceNode[], plantModel: PlantModelConfig } {
  if (key === 'injection-line') return injectionParts()
  if (key === 'wwtp-line') return wwtpParts()
  if (key === 'anneal-line') return annealParts()
  throw new Error(`未知多场景预设: ${key}`)
}

/**
 * 注塑成型产线(injection-line)。
 * 作业场景:家用电器面板类制品(PP),规格克重 32.5±0.35 g,飞边 ≤0.4%、缩痕 ≤1.5%、
 *   尺寸偏差 ±0.05 mm。起始工况保压偏低 → 克重 ≈31.3 g 偏轻 + 缩痕 ≈3%,待闭环寻优。
 * 控制面(11 DCW):机筒四区温度/螺杆转速(Modbus TCP)、模温/锁模力(Modbus RTU)、
 *   注射速度/保压压力/保压时间(OPC UA)、冷却水温(MQTT 命令主题)。
 * 采集面(12 标量 PV + 向量/图像帧):熔温/熔压/模温/锁模力/注射压力/水温/水流量/克重/
 *   飞边/缩痕/尺寸偏差/节拍 + 壁厚轮廓向量帧 + 外观图像帧。
 */
export function injectionParts(): { nodes: DeviceNode[], plantModel: PlantModelConfig } {
  const SP = INJECTION_NOMINAL
  const plantModel: PlantModelConfig = {
    kind: 'injection',
    id: 'injection',
    enabled: true,
    seed: 42,
    dtMs: 500,
    timeScale: 6,
    phase: 'warmup',
    disturbances: { heaterDecay: 1, feedDriftPerMin: 0.05 },
    truthExport: true,
    optimum: null,
    controls: {} as Record<string, PlantBinding>,
    outputs: {} as Partial<Record<string, PlantBinding>>,
  }

  const machine: DeviceNode = {
    id: 'inj-machine-mbtcp',
    name: '注塑主机PLC(Modbus TCP)',
    description: '注塑机主机:机筒四区加热 + 螺杆塑化传动。塑化段,决定熔体温度与计量精度。',
    protocol: 'modbus-tcp',
    enabled: true,
    tickMs: 800,
    signals: [
      { id: 'barrel-temp-1-sp', name: '机筒温度区1SP', description: '进料段机筒温度(水冷进料口防架桥),四区最低', unit: '℃', min: 160, max: 300, decimals: 1, strategy: { kind: 'manual', value: SP.barrelTemp1 } },
      { id: 'barrel-temp-2-sp', name: '机筒温度区2SP', description: '压缩段机筒温度,物料开始熔融', unit: '℃', min: 160, max: 300, decimals: 1, strategy: { kind: 'manual', value: SP.barrelTemp2 } },
      { id: 'barrel-temp-3-sp', name: '机筒温度区3SP', description: '计量段中段机筒温度', unit: '℃', min: 160, max: 300, decimals: 1, strategy: { kind: 'manual', value: SP.barrelTemp3 } },
      { id: 'barrel-temp-4-sp', name: '机筒温度区4SP', description: '喷嘴段机筒温度,四区最高;与熔体温度强相关', unit: '℃', min: 160, max: 300, decimals: 1, strategy: { kind: 'manual', value: SP.barrelTemp4 } },
      { id: 'screw-speed-sp', name: '螺杆转速SP', description: '塑化螺杆转速(rpm);剪切热叠加进熔体温度(约 +0.11℃/rpm)', unit: 'rpm', min: 60, max: 200, decimals: 0, strategy: { kind: 'manual', value: SP.screw } },
      { id: 'melt-temp-pv', name: 'MeltTemp', description: '喷嘴前熔体实测温度(采集);工艺窗 235~262℃,超窗劣化飞边/缩痕', unit: '℃', min: 20, max: 320, decimals: 1, plantBinding: 'meltTemp', strategy: { kind: 'constant', value: 25 } },
      { id: 'melt-pressure-pv', name: 'MeltPress', description: '塑化背压(采集,bar)', unit: 'bar', min: 0, max: 160, decimals: 1, plantBinding: 'meltPressure', strategy: { kind: 'constant', value: 50 } },
    ],
    config: {
      host: '0.0.0.0', port: 24052, unitId: 1,
      registerMaps: [
        { address: 40001, area: 'holding', signalId: 'melt-temp-pv', dataType: 'float32', byteOrder: 'big' },
        { address: 40003, area: 'holding', signalId: 'melt-pressure-pv', dataType: 'float32', byteOrder: 'big' },
        { address: 40021, area: 'holding', signalId: 'barrel-temp-1-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40023, area: 'holding', signalId: 'barrel-temp-2-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40025, area: 'holding', signalId: 'barrel-temp-3-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40027, area: 'holding', signalId: 'barrel-temp-4-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40029, area: 'holding', signalId: 'screw-speed-sp', dataType: 'float32', byteOrder: 'big' },
      ],
    },
  }

  const mold: DeviceNode = {
    id: 'inj-mold-rtu',
    name: '模温机与锁模单元(Modbus RTU)',
    description: '模温控制机 + 锁模单元。模具温度决定表面复制/缩痕/飞边阈值,锁模力是飞边的物理上限。',
    protocol: 'modbus-rtu',
    enabled: true,
    tickMs: 1000,
    signals: [
      { id: 'mold-temp-sp', name: '模具温度SP', description: '模温机设定(℃);过低→缩痕/表面无光,过高→飞边与节拍变长', unit: '℃', min: 20, max: 95, decimals: 1, strategy: { kind: 'manual', value: SP.moldTemp } },
      { id: 'clamp-force-sp', name: '锁模力SP', description: '锁模力设定(kN);保压+注射压力的飞边阈值由此决定', unit: 'kN', min: 800, max: 2500, decimals: 0, strategy: { kind: 'manual', value: SP.clampForce } },
      { id: 'mold-temp-pv', name: 'MoldTempPV', description: '模具实测温度(采集)', unit: '℃', min: 10, max: 110, decimals: 1, plantBinding: 'moldTemp', strategy: { kind: 'constant', value: 25 } },
      { id: 'clamp-force-pv', name: 'ClampPV', description: '锁模力实测(采集)', unit: 'kN', min: 0, max: 2600, decimals: 0, plantBinding: 'clampForce', strategy: { kind: 'constant', value: 1600 } },
    ],
    config: {
      host: '0.0.0.0', port: 23052, unitId: 1,
      registerMaps: [
        { address: 40001, area: 'holding', signalId: 'mold-temp-pv', dataType: 'float32', byteOrder: 'big' },
        { address: 40003, area: 'holding', signalId: 'clamp-force-pv', dataType: 'float32', byteOrder: 'big' },
        { address: 40021, area: 'holding', signalId: 'mold-temp-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40023, area: 'holding', signalId: 'clamp-force-sp', dataType: 'float32', byteOrder: 'big' },
      ],
    },
  }

  const inject: DeviceNode = {
    id: 'inj-inject-opcua',
    name: '注射/保压单元(OPC UA)',
    description: '注射与保压执行单元:注射速度、保压压力与保压时间是克重的第一控制组。',
    protocol: 'opcua',
    enabled: true,
    tickMs: 1000,
    signals: [
      { id: 'inject-speed-sp', name: 'InjectSpeedSP', description: '注射速度(mm/s);影响充模与注射压力,克重次要项', unit: 'mm/s', min: 30, max: 130, decimals: 0, strategy: { kind: 'manual', value: SP.injectSpeed } },
      { id: 'hold-pressure-sp', name: 'HoldPressSP', description: '保压压力(bar)——克重/缩痕/飞边的第一控制量;低了缩痕重、高了飞边出', unit: 'bar', min: 20, max: 110, decimals: 1, strategy: { kind: 'manual', value: SP.holdPressure } },
      { id: 'hold-time-sp', name: 'HoldTimeSP', description: '保压时间(s);浇口冻结前持续补缩,与保压压力同向', unit: 's', min: 3, max: 15, decimals: 1, strategy: { kind: 'manual', value: SP.holdTime } },
      { id: 'inj-pressure-pv', name: 'InjPressPV', description: '注射压力实测(采集,bar);超 95 bar 起飞边贡献', unit: 'bar', min: 0, max: 180, decimals: 1, plantBinding: 'injPressure', strategy: { kind: 'constant', value: 50 } },
    ],
    config: {
      host: '127.0.0.1', port: 13843, namespaceUri: 'PLC-Simulator-Injection',
      opcVars: [
        { nodeId: 'ns=2;s=Inj.Inj.Speed.Sp', signalId: 'inject-speed-sp', dataType: 'Double', writable: true },
        { nodeId: 'ns=2;s=Inj.Hold.P.Sp', signalId: 'hold-pressure-sp', dataType: 'Double', writable: true },
        { nodeId: 'ns=2;s=Inj.Hold.T.Sp', signalId: 'hold-time-sp', dataType: 'Double', writable: true },
        { nodeId: 'ns=2;s=Inj.Inj.P.Pv', signalId: 'inj-pressure-pv', dataType: 'Double' },
      ],
    },
  }

  const cool: DeviceNode = {
    id: 'inj-cool-mqtt',
    name: '冷却水单元(MQTT)',
    description: '模温机冷却水回路:水温设定经 MQTT 命令主题下发;水温偏高顶高模具实际温度。',
    protocol: 'mqtt',
    enabled: true,
    tickMs: 2000,
    signals: [
      { id: 'water-temp-pv', name: 'WaterTempPV', description: '冷却水实测温度(采集,℃)', unit: '℃', min: 5, max: 60, decimals: 1, plantBinding: 'waterTemp', strategy: { kind: 'constant', value: 24 } },
      { id: 'cool-flow-pv', name: 'CoolFlowPV', description: '冷却水流量(采集,L/min)', unit: 'L/min', min: 0, max: 80, decimals: 1, plantBinding: 'coolFlow', strategy: { kind: 'constant', value: 42 } },
      { id: 'cool-water-sp', name: 'CoolWaterSP', description: '冷却水温设定(℃,MQTT 命令主题下发);>32℃ 开始顶高模具温度', unit: '℃', min: 10, max: 45, decimals: 1, strategy: { kind: 'manual', value: SP.coolWater } },
    ],
    config: {
      brokerUrl: 'mqtt://127.0.0.1:26830',
      topics: [
        { topic: 'aw/inj/wtemp', signalId: 'water-temp-pv', payloadTemplate: '{"data":{"temp":${value}}}', qos: 0 },
        { topic: 'aw/inj/flow', signalId: 'cool-flow-pv', payloadTemplate: '{"data":{"flow":${value}}}', qos: 0 },
      ],
      commandTopic: 'aw/inj/coolwater/set',
      commandSignalId: 'cool-water-sp',
      stateTopic: 'aw/inj/coolwater/state',
    } as never,
  }

  const inspect: DeviceNode = {
    id: 'inj-inspect-http',
    name: '制品质量检测站(HTTP)',
    description: '在线称重与外观检测站:克重/飞边/缩痕/尺寸/节拍 + 壁厚轮廓与外观图像帧。',
    protocol: 'http',
    enabled: true,
    tickMs: 1000,
    signals: [
      { id: 'part-weight', name: 'PartWeight', description: '制品克重(采集,g)——闭环寻优的被控量,规格 32.5±0.35 g', unit: 'g', min: 25, max: 40, decimals: 2, plantBinding: 'partWeight', strategy: { kind: 'constant', value: 31 } },
      { id: 'flash-rate', name: 'FlashRate', description: '飞边率(采集,%);>0.4% 需退保压,模具损伤风险', unit: '%', min: 0, max: 5, decimals: 3, plantBinding: 'flash', strategy: { kind: 'constant', value: 0.02 } },
      { id: 'sink-mark', name: 'SinkMark', description: '缩痕指数(采集,%);>1.5% 外观不良,保压不足信号', unit: '%', min: 0, max: 10, decimals: 3, plantBinding: 'sink', strategy: { kind: 'constant', value: 3 } },
      { id: 'dim-dev', name: 'DimDev', description: '关键尺寸偏差(采集,mm);规格 ±0.05 mm', unit: 'mm', min: -0.5, max: 0.5, decimals: 3, plantBinding: 'dimDev', strategy: { kind: 'constant', value: 0 } },
      { id: 'cycle-time', name: 'CycleTime', description: '生产节拍(采集,s/模)——质量与产能的权衡记录量', unit: 's', min: 5, max: 60, decimals: 1, plantBinding: 'cycleTime', strategy: { kind: 'constant', value: 15 } },
      { id: 'wall-profile', name: 'WallProfile', description: '制品壁厚轮廓 48 点向量帧(采集,mm)', unit: 'mm', min: 1, max: 5, decimals: 4, format: 'vector', plantBinding: 'profile', strategy: { kind: 'constant', value: 2.5 } },
      { id: 'surface-image', name: 'SurfaceImg', description: '制品外观灰度图像帧(采集;亮点 ∝ 飞边缺陷)', unit: '灰度', min: 0, max: 255, format: 'image', plantBinding: 'image', strategy: { kind: 'constant', value: 0 } },
    ],
    config: {
      paths: [
        { path: '/api/weight', signalId: 'part-weight', responseTemplate: '{"value":${value}}' },
        { path: '/api/flash', signalId: 'flash-rate', responseTemplate: '{"value":${value}}' },
        { path: '/api/sink', signalId: 'sink-mark', responseTemplate: '{"value":${value}}' },
        { path: '/api/dim', signalId: 'dim-dev', responseTemplate: '{"value":${value}}' },
        { path: '/api/cycle', signalId: 'cycle-time', responseTemplate: '{"value":${value}}' },
        { path: '/api/profile', signalId: 'wall-profile', responseTemplate: '{"points":${points},"value":${value}}' },
        { path: '/api/ccd', signalId: 'surface-image' },
      ],
    },
  }

  const nodes = [machine, mold, inject, cool, inspect]
  plantModel.controls = {
    barrelTemp1: { nodeId: machine.id, signalId: 'barrel-temp-1-sp' },
    barrelTemp2: { nodeId: machine.id, signalId: 'barrel-temp-2-sp' },
    barrelTemp3: { nodeId: machine.id, signalId: 'barrel-temp-3-sp' },
    barrelTemp4: { nodeId: machine.id, signalId: 'barrel-temp-4-sp' },
    screw: { nodeId: machine.id, signalId: 'screw-speed-sp' },
    injectSpeed: { nodeId: inject.id, signalId: 'inject-speed-sp' },
    holdPressure: { nodeId: inject.id, signalId: 'hold-pressure-sp' },
    holdTime: { nodeId: inject.id, signalId: 'hold-time-sp' },
    moldTemp: { nodeId: mold.id, signalId: 'mold-temp-sp' },
    clampForce: { nodeId: mold.id, signalId: 'clamp-force-sp' },
    coolWater: { nodeId: cool.id, signalId: 'cool-water-sp' },
  }
  plantModel.outputs = {
    meltTemp: { nodeId: machine.id, signalId: 'melt-temp-pv' },
    meltPressure: { nodeId: machine.id, signalId: 'melt-pressure-pv' },
    moldTemp: { nodeId: mold.id, signalId: 'mold-temp-pv' },
    clampForce: { nodeId: mold.id, signalId: 'clamp-force-pv' },
    injPressure: { nodeId: inject.id, signalId: 'inj-pressure-pv' },
    waterTemp: { nodeId: cool.id, signalId: 'water-temp-pv' },
    coolFlow: { nodeId: cool.id, signalId: 'cool-flow-pv' },
    partWeight: { nodeId: inspect.id, signalId: 'part-weight' },
    flash: { nodeId: inspect.id, signalId: 'flash-rate' },
    sink: { nodeId: inspect.id, signalId: 'sink-mark' },
    dimDev: { nodeId: inspect.id, signalId: 'dim-dev' },
    cycleTime: { nodeId: inspect.id, signalId: 'cycle-time' },
    profile: { nodeId: inspect.id, signalId: 'wall-profile' },
    image: { nodeId: inspect.id, signalId: 'surface-image' },
  }
  return { nodes, plantModel }
}

/**
 * A2O 污水生化处理线(wwtp-line)。
 * 作业场景:城镇污水处理厂 A2O 工艺,排放标准 COD<50、氨氮<5、总磷<0.5 mg/L、pH 6~9、
 *   浊度<10 NTU。起始工况风机偏低+加药不足 → DO≈1.2/pH≈5.9/TP 超标(不达标运行);
 *   优化目标 = 达标前提下最小化运行成本(曝风电耗 + 药耗),达标后逐级「脱气退药」降耗。
 * 控制面(7 DCW):风机频率(MBTCP)、NaOH/PAC 计量泵(OPC UA)、内回流/污泥回流/排泥(RTU)、
 *   进水流量(MQTT 命令主题)。
 * 采集面(12 标量 PV + 1 向量):风压/DO/药量实测/MLSS/进水 COD·氨氮/出水五参数 + 沿程 DO 轮廓。
 */
export function wwtpParts(): { nodes: DeviceNode[], plantModel: PlantModelConfig } {
  const SP = WWTP_NOMINAL
  const plantModel: PlantModelConfig = {
    kind: 'wwtp',
    id: 'wwtp',
    enabled: true,
    seed: 42,
    dtMs: 500,
    timeScale: 6,
    phase: 'warmup',
    disturbances: { heaterDecay: 1, feedDriftPerMin: 0 },
    truthExport: true,
    optimum: null,
    controls: {} as Record<string, PlantBinding>,
    outputs: {} as Partial<Record<string, PlantBinding>>,
  }

  const blower: DeviceNode = {
    id: 'wwtp-blower-mbtcp',
    name: '曝气风机站(Modbus TCP)',
    description: '生化池曝气风机站:风机频率是溶解氧的第一控制量,也是全厂最大电耗源(≈^2.6 指数)。',
    protocol: 'modbus-tcp',
    enabled: true,
    tickMs: 800,
    signals: [
      { id: 'blower-hz-sp', name: '风机频率SP', description: '曝气风机频率(Hz);DO=f(kLa·f^1.8),电耗∝f^2.6——达标与降耗的核心权衡', unit: 'Hz', min: 20, max: 50, decimals: 1, strategy: { kind: 'manual', value: SP.blowerHz } },
      { id: 'air-pressure-pv', name: 'AirPress', description: '曝气总管风压(采集,kPa)', unit: 'kPa', min: 20, max: 90, decimals: 1, plantBinding: 'airPressure', strategy: { kind: 'constant', value: 52 } },
      { id: 'do-pv', name: 'DO', description: '好氧池溶解氧(采集,mg/L);硝化要求 ≥2.8,达标经济带 3.4±0.6', unit: 'mg/L', min: 0, max: 10, decimals: 2, plantBinding: 'do', strategy: { kind: 'constant', value: 1 } },
    ],
    config: {
      host: '0.0.0.0', port: 24054, unitId: 1,
      registerMaps: [
        { address: 40001, area: 'holding', signalId: 'air-pressure-pv', dataType: 'float32', byteOrder: 'big' },
        { address: 40003, area: 'holding', signalId: 'do-pv', dataType: 'float32', byteOrder: 'big' },
        { address: 40021, area: 'holding', signalId: 'blower-hz-sp', dataType: 'float32', byteOrder: 'big' },
      ],
    },
  }

  const dosing: DeviceNode = {
    id: 'wwtp-dosing-opcua',
    name: '加药单元(OPC UA)',
    description: '加药撬块:NaOH 中和(硝化碱耗补偿)与 PAC 化学除磷;两泵频率即药耗成本。',
    protocol: 'opcua',
    enabled: true,
    tickMs: 1000,
    signals: [
      { id: 'naoh-dose-sp', name: 'NaohDoseSP', description: 'NaOH 计量泵频率(L/h);pH=6.1+0.041×药量−硝化碱耗,6.5~7.5 为经济带', unit: 'L/h', min: 0, max: 120, decimals: 0, strategy: { kind: 'manual', value: SP.naohDose } },
      { id: 'pac-dose-sp', name: 'PacDoseSP', description: 'PAC 投加泵频率(L/h);朗缪尔饱和吸附,收益递减,TP<0.5 的下限约 55~65', unit: 'L/h', min: 0, max: 90, decimals: 0, strategy: { kind: 'manual', value: SP.pacDose } },
      { id: 'naoh-flow-pv', name: 'NaohFlow', description: 'NaOH 实际流量(采集,L/h)', unit: 'L/h', min: 0, max: 130, decimals: 1, plantBinding: 'naohFlow', strategy: { kind: 'constant', value: 12 } },
      { id: 'pac-flow-pv', name: 'PacFlow', description: 'PAC 实际流量(采集,L/h)', unit: 'L/h', min: 0, max: 100, decimals: 1, plantBinding: 'pacFlow', strategy: { kind: 'constant', value: 30 } },
    ],
    config: {
      host: '127.0.0.1', port: 13844, namespaceUri: 'PLC-Simulator-Wwtp-Dosing',
      opcVars: [
        { nodeId: 'ns=2;s=Wwtp.Dose.Naoh.Sp', signalId: 'naoh-dose-sp', dataType: 'Double', writable: true },
        { nodeId: 'ns=2;s=Wwtp.Dose.Pac.Sp', signalId: 'pac-dose-sp', dataType: 'Double', writable: true },
        { nodeId: 'ns=2;s=Wwtp.Dose.Naoh.Pv', signalId: 'naoh-flow-pv', dataType: 'Double' },
        { nodeId: 'ns=2;s=Wwtp.Dose.Pac.Pv', signalId: 'pac-flow-pv', dataType: 'Double' },
      ],
    },
  }

  const ret: DeviceNode = {
    id: 'wwtp-return-rtu',
    name: '回流与排泥单元(Modbus RTU)',
    description: '回流撬块:内回流(脱氮)/污泥回流(泥浓维持)/剩余污泥排放(MLSS 定态)。',
    protocol: 'modbus-rtu',
    enabled: true,
    tickMs: 1000,
    signals: [
      { id: 'recycle-int-sp', name: '内回流比SP', description: '内回流比(%);>80 起改善脱氮(反硝化基质),过大增加能耗', unit: '%', min: 20, max: 180, decimals: 0, strategy: { kind: 'manual', value: SP.recycleInt } },
      { id: 'recycle-sludge-sp', name: '污泥回流比SP', description: '污泥回流比(%);维持曝气池 MLSS', unit: '%', min: 30, max: 120, decimals: 0, strategy: { kind: 'manual', value: SP.recycleSludge } },
      { id: 'waste-sludge-sp', name: '排泥量SP', description: '剩余污泥排放量(m³/d);MLSS=4900−7.5×(排泥−120),泥龄的执行器', unit: 'm³/d', min: 50, max: 400, decimals: 0, strategy: { kind: 'manual', value: SP.wasteSludge } },
      { id: 'mlss-pv', name: 'MLSS', description: '曝气池污泥浓度(采集,mg/L);>6000 膨胀风险推高浊度', unit: 'mg/L', min: 1000, max: 8000, decimals: 0, plantBinding: 'mlss', strategy: { kind: 'constant', value: 4900 } },
    ],
    config: {
      host: '0.0.0.0', port: 23054, unitId: 1,
      registerMaps: [
        { address: 40001, area: 'holding', signalId: 'mlss-pv', dataType: 'float32', byteOrder: 'big' },
        { address: 40021, area: 'holding', signalId: 'recycle-int-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40023, area: 'holding', signalId: 'recycle-sludge-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40025, area: 'holding', signalId: 'waste-sludge-sp', dataType: 'float32', byteOrder: 'big' },
      ],
    },
  }

  const influent: DeviceNode = {
    id: 'wwtp-influent-mqtt',
    name: '进水泵房(MQTT)',
    description: '进水泵房:进水流量设定(MQTT 命令主题)+ 进水 COD/氨氮扰动物遥测。',
    protocol: 'mqtt',
    enabled: true,
    tickMs: 2000,
    signals: [
      { id: 'cod-in-pv', name: 'CodIn', description: '进水 COD(采集,mg/L);扰动物,漂移由 disturbances 驱动', unit: 'mg/L', min: 100, max: 900, decimals: 0, plantBinding: 'codIn', strategy: { kind: 'constant', value: 420 } },
      { id: 'nh3-in-pv', name: 'Nh3In', description: '进水氨氮(采集,mg/L)', unit: 'mg/L', min: 10, max: 80, decimals: 1, plantBinding: 'nh3In', strategy: { kind: 'constant', value: 35 } },
      { id: 'influent-flow-sp', name: 'InflowSP', description: '进水流量设定(m³/h,MQTT 命令主题下发);HRT 反比于流量', unit: 'm³/h', min: 400, max: 1600, decimals: 0, strategy: { kind: 'manual', value: SP.influentFlow } },
    ],
    config: {
      brokerUrl: 'mqtt://127.0.0.1:26830',
      topics: [
        { topic: 'aw/wwtp/codin', signalId: 'cod-in-pv', payloadTemplate: '{"data":{"cod":${value}}}', qos: 0 },
        { topic: 'aw/wwtp/nh3in', signalId: 'nh3-in-pv', payloadTemplate: '{"data":{"nh3":${value}}}', qos: 0 },
      ],
      commandTopic: 'aw/wwtp/inflow/set',
      commandSignalId: 'influent-flow-sp',
      stateTopic: 'aw/wwtp/inflow/state',
    } as never,
  }

  const effluent: DeviceNode = {
    id: 'wwtp-effluent-http',
    name: '出水水质检测站(HTTP)',
    description: '出水在线水质仪:COD/氨氮/总磷/pH/浊度五参数 + 沿程 DO 轮廓向量帧。排放达标关。',
    protocol: 'http',
    enabled: true,
    tickMs: 1000,
    signals: [
      { id: 'eff-cod', name: 'CodOut', description: '出水 COD(采集,mg/L);排放限值 50', unit: 'mg/L', min: 0, max: 300, decimals: 1, plantBinding: 'codOut', strategy: { kind: 'constant', value: 100 } },
      { id: 'eff-nh3', name: 'Nh3Out', description: '出水氨氮(采集,mg/L);排放限值 5,DO<0.8 硝化崩溃', unit: 'mg/L', min: 0, max: 60, decimals: 2, plantBinding: 'nh3Out', strategy: { kind: 'constant', value: 30 } },
      { id: 'eff-tp', name: 'TpOut', description: '出水总磷(采集,mg/L);排放限值 0.5', unit: 'mg/L', min: 0, max: 8, decimals: 3, plantBinding: 'tpOut', strategy: { kind: 'constant', value: 1.5 } },
      { id: 'eff-ph', name: 'PhOut', description: '出水 pH(采集);排放限值 6~9', unit: 'pH', min: 4, max: 11, decimals: 2, plantBinding: 'ph', strategy: { kind: 'constant', value: 5.9 } },
      { id: 'eff-turbidity', name: 'Turbidity', description: '出水浊度(采集,NTU);限值 10,膨胀/低 DO 抬升', unit: 'NTU', min: 0, max: 60, decimals: 2, plantBinding: 'turbidity', strategy: { kind: 'constant', value: 3 } },
      { id: 'do-profile', name: 'DoProfile', description: '沿程 DO 轮廓 7 池段向量帧(采集,mg/L)', unit: 'mg/L', min: 0, max: 10, decimals: 3, format: 'vector', plantBinding: 'doProfile', strategy: { kind: 'constant', value: 1 } },
    ],
    config: {
      paths: [
        { path: '/api/cod', signalId: 'eff-cod', responseTemplate: '{"value":${value}}' },
        { path: '/api/nh3', signalId: 'eff-nh3', responseTemplate: '{"value":${value}}' },
        { path: '/api/tp', signalId: 'eff-tp', responseTemplate: '{"value":${value}}' },
        { path: '/api/ph', signalId: 'eff-ph', responseTemplate: '{"value":${value}}' },
        { path: '/api/turbidity', signalId: 'eff-turbidity', responseTemplate: '{"value":${value}}' },
        { path: '/api/doprofile', signalId: 'do-profile', responseTemplate: '{"points":${points},"value":${value}}' },
      ],
    },
  }

  const nodes = [blower, dosing, ret, influent, effluent]
  plantModel.controls = {
    blowerHz: { nodeId: blower.id, signalId: 'blower-hz-sp' },
    naohDose: { nodeId: dosing.id, signalId: 'naoh-dose-sp' },
    pacDose: { nodeId: dosing.id, signalId: 'pac-dose-sp' },
    recycleInt: { nodeId: ret.id, signalId: 'recycle-int-sp' },
    recycleSludge: { nodeId: ret.id, signalId: 'recycle-sludge-sp' },
    wasteSludge: { nodeId: ret.id, signalId: 'waste-sludge-sp' },
    influentFlow: { nodeId: influent.id, signalId: 'influent-flow-sp' },
  }
  plantModel.outputs = {
    airPressure: { nodeId: blower.id, signalId: 'air-pressure-pv' },
    do: { nodeId: blower.id, signalId: 'do-pv' },
    naohFlow: { nodeId: dosing.id, signalId: 'naoh-flow-pv' },
    pacFlow: { nodeId: dosing.id, signalId: 'pac-flow-pv' },
    mlss: { nodeId: ret.id, signalId: 'mlss-pv' },
    codIn: { nodeId: influent.id, signalId: 'cod-in-pv' },
    nh3In: { nodeId: influent.id, signalId: 'nh3-in-pv' },
    codOut: { nodeId: effluent.id, signalId: 'eff-cod' },
    nh3Out: { nodeId: effluent.id, signalId: 'eff-nh3' },
    tpOut: { nodeId: effluent.id, signalId: 'eff-tp' },
    ph: { nodeId: effluent.id, signalId: 'eff-ph' },
    turbidity: { nodeId: effluent.id, signalId: 'eff-turbidity' },
    doProfile: { nodeId: effluent.id, signalId: 'do-profile' },
  }
  return { nodes, plantModel }
}

/**
 * 连续退火产线(anneal-line)。
 * 作业场景:冷轧低碳钢带连续退火(DC04 类冲压板),质量规格硬度 95±6 HV、抗拉 300±25 MPa、
 *   表面缺陷 ≤0.5%。起始工况炉温偏低+线速偏快 → 欠退火(硬度 ≈134 HV)。
 *   优化目标 = 调回再结晶窗后,在质量窗内逐级推高线速(产能最大化)。
 * 控制面(7 DCW):均热三区炉温(MBTCP)、线速度(OPC UA)、过时效温度/冷却档位(RTU)、
 *   H2 含量(MQTT 命令主题)。
 * 采集面(10 标量 PV + 1 向量):炉温/带温/实际线速/过时效/露点/H2 实测/硬度/抗拉/屈服/
 *   晶粒/表面缺陷 + 板形轮廓(I-Unit)。
 */
export function annealParts(): { nodes: DeviceNode[], plantModel: PlantModelConfig } {
  const SP = ANNEAL_NOMINAL
  const plantModel: PlantModelConfig = {
    kind: 'anneal',
    id: 'anneal',
    enabled: true,
    seed: 42,
    dtMs: 500,
    timeScale: 6,
    phase: 'warmup',
    disturbances: { heaterDecay: 1, feedDriftPerMin: 0 },
    truthExport: true,
    optimum: null,
    controls: {} as Record<string, PlantBinding>,
    outputs: {} as Partial<Record<string, PlantBinding>>,
  }

  const heating: DeviceNode = {
    id: 'anneal-heating-mbtcp',
    name: '加热段炉(Modbus TCP)',
    description: '连续退火加热段:均热三区辐射加热,区权 0.25/0.35/0.40;炉温决定再结晶退热指数。',
    protocol: 'modbus-tcp',
    enabled: true,
    tickMs: 800,
    signals: [
      { id: 'zone1-sp', name: '均热区1炉温SP', description: '加热段入口区炉温(℃);低温预热区', unit: '℃', min: 600, max: 850, decimals: 1, strategy: { kind: 'manual', value: SP.zone1 } },
      { id: 'zone2-sp', name: '均热区2炉温SP', description: '加热段中段炉温(℃);再结晶主驱动之一', unit: '℃', min: 600, max: 850, decimals: 1, strategy: { kind: 'manual', value: SP.zone2 } },
      { id: 'zone3-sp', name: '均热区3炉温SP', description: '均热出口区炉温(℃);区权最大(0.40),带温第一驱动', unit: '℃', min: 600, max: 850, decimals: 1, strategy: { kind: 'manual', value: SP.zone3 } },
      { id: 'furnace-temp-pv', name: 'FurnaceTemp', description: '炉温加权实测(采集,℃)', unit: '℃', min: 20, max: 900, decimals: 1, plantBinding: 'furnaceTemp', strategy: { kind: 'constant', value: 25 } },
      { id: 'strip-temp-pv', name: 'StripTemp', description: '均热段出口带温(采集,℃);再结晶窗 ≈700~760', unit: '℃', min: 20, max: 900, decimals: 1, plantBinding: 'stripTemp', strategy: { kind: 'constant', value: 25 } },
    ],
    config: {
      host: '0.0.0.0', port: 24056, unitId: 1,
      registerMaps: [
        { address: 40001, area: 'holding', signalId: 'furnace-temp-pv', dataType: 'float32', byteOrder: 'big' },
        { address: 40003, area: 'holding', signalId: 'strip-temp-pv', dataType: 'float32', byteOrder: 'big' },
        { address: 40021, area: 'holding', signalId: 'zone1-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40023, area: 'holding', signalId: 'zone2-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40025, area: 'holding', signalId: 'zone3-sp', dataType: 'float32', byteOrder: 'big' },
      ],
    },
  }

  const drive: DeviceNode = {
    id: 'anneal-line-opcua',
    name: '炉内传动与速度单元(OPC UA)',
    description: '炉段传动:线速度即产能(驻留时间=炉长/速度),也是带温与热指数的第二控制量。',
    protocol: 'opcua',
    enabled: true,
    tickMs: 1000,
    signals: [
      { id: 'line-speed-sp', name: 'LineSpeedSP', description: '带钢运行速度(m/min);快了驻留短→欠退火,是产能与质量的枢纽', unit: 'm/min', min: 60, max: 220, decimals: 0, strategy: { kind: 'manual', value: SP.lineSpeed } },
      { id: 'act-speed-pv', name: 'ActSpeed', description: '实际线速度(采集,m/min)', unit: 'm/min', min: 0, max: 240, decimals: 1, plantBinding: 'actSpeed', strategy: { kind: 'constant', value: 0 } },
    ],
    config: {
      host: '127.0.0.1', port: 13845, namespaceUri: 'PLC-Simulator-Anneal-Drive',
      opcVars: [
        { nodeId: 'ns=2;s=Anneal.Line.Speed.Sp', signalId: 'line-speed-sp', dataType: 'Double', writable: true },
        { nodeId: 'ns=2;s=Anneal.Line.Speed.Pv', signalId: 'act-speed-pv', dataType: 'Double' },
      ],
    },
  }

  const cool: DeviceNode = {
    id: 'anneal-cool-rtu',
    name: '冷却与过时效段(Modbus RTU)',
    description: '过时效段(缓冷析出)+ 冷却风机档位(冷速影响强度与时效行为)。',
    protocol: 'modbus-rtu',
    enabled: true,
    tickMs: 1000,
    signals: [
      { id: 'oa-temp-sp', name: '过时效温度SP', description: '过时效段温度(℃);缓释固溶碳,影响时效与冲压性能', unit: '℃', min: 320, max: 480, decimals: 1, strategy: { kind: 'manual', value: SP.oaTemp } },
      { id: 'cool-rate-sp', name: '冷却档位SP', description: '冷却风机档位(%);冷速快→强度略升', unit: '%', min: 20, max: 100, decimals: 0, strategy: { kind: 'manual', value: SP.coolRate } },
      { id: 'oa-temp-pv', name: 'OaTempPV', description: '过时段实测温度(采集,℃)', unit: '℃', min: 20, max: 520, decimals: 1, plantBinding: 'oaTemp', strategy: { kind: 'constant', value: 25 } },
    ],
    config: {
      host: '0.0.0.0', port: 23056, unitId: 1,
      registerMaps: [
        { address: 40001, area: 'holding', signalId: 'oa-temp-pv', dataType: 'float32', byteOrder: 'big' },
        { address: 40021, area: 'holding', signalId: 'oa-temp-sp', dataType: 'float32', byteOrder: 'big' },
        { address: 40023, area: 'holding', signalId: 'cool-rate-sp', dataType: 'float32', byteOrder: 'big' },
      ],
    },
  }

  const gas: DeviceNode = {
    id: 'anneal-gas-mqtt',
    name: '保护气单元(MQTT)',
    description: '保护气(Hx-Nx)混合站:H2 含量影响传热与表面还原;露点是表面氧化的关健量。',
    protocol: 'mqtt',
    enabled: true,
    tickMs: 2000,
    signals: [
      { id: 'dew-point-pv', name: 'DewPoint', description: '炉内露点(采集,℃);>−30 氧化风险,表面缺陷抬升', unit: '℃', min: -70, max: 0, decimals: 1, plantBinding: 'dewPoint', strategy: { kind: 'constant', value: -40 } },
      { id: 'h2-act-pv', name: 'H2Act', description: 'H2 实测含量(采集,%);<8 表面还原不足', unit: '%', min: 0, max: 20, decimals: 1, plantBinding: 'h2Act', strategy: { kind: 'constant', value: 10 } },
      { id: 'h2-ratio-sp', name: 'H2RatioSP', description: 'H2 混合比设定(%,MQTT 命令主题下发);+传热 +0.25℃/%', unit: '%', min: 3, max: 15, decimals: 1, strategy: { kind: 'manual', value: SP.h2 } },
    ],
    config: {
      brokerUrl: 'mqtt://127.0.0.1:26830',
      topics: [
        { topic: 'aw/anneal/dew', signalId: 'dew-point-pv', payloadTemplate: '{"data":{"dew":${value}}}', qos: 0 },
        { topic: 'aw/anneal/h2pv', signalId: 'h2-act-pv', payloadTemplate: '{"data":{"h2":${value}}}', qos: 0 },
      ],
      commandTopic: 'aw/anneal/h2/set',
      commandSignalId: 'h2-ratio-sp',
      stateTopic: 'aw/anneal/h2/state',
    } as never,
  }

  const inspect: DeviceNode = {
    id: 'anneal-inspect-http',
    name: '成品质量检测站(HTTP)',
    description: '成品检验:硬度/抗拉/屈服/晶粒度/表面缺陷 + 板形轮廓向量帧。质量窗关。',
    protocol: 'http',
    enabled: true,
    tickMs: 1000,
    signals: [
      { id: 'hardness', name: 'Hardness', description: '维氏硬度(采集,HV)——闭环被控量,规格 95±6', unit: 'HV', min: 60, max: 200, decimals: 1, plantBinding: 'hardness', strategy: { kind: 'constant', value: 134 } },
      { id: 'tensile', name: 'Tensile', description: '抗拉强度(采集,MPa);规格 300±25', unit: 'MPa', min: 200, max: 500, decimals: 1, plantBinding: 'tensile', strategy: { kind: 'constant', value: 320 } },
      { id: 'yield-str', name: 'YieldStr', description: '屈服强度(采集,MPa)', unit: 'MPa', min: 100, max: 400, decimals: 1, plantBinding: 'yieldStr', strategy: { kind: 'constant', value: 170 } },
      { id: 'grain-size', name: 'GrainSize', description: '晶粒度(采集,μm);再结晶完成度指标', unit: 'μm', min: 2, max: 30, decimals: 2, plantBinding: 'grainSize', strategy: { kind: 'constant', value: 5 } },
      { id: 'surface-defect', name: 'SurfaceDef', description: '表面缺陷率(采集,%);≤0.5,H2 不足/带温超窗抬升', unit: '%', min: 0, max: 5, decimals: 3, plantBinding: 'surfaceDef', strategy: { kind: 'constant', value: 0.15 } },
      { id: 'flatness', name: 'Flatness', description: '板形轮廓 48 点向量帧(采集,I-Unit;区温不均→边浪)', unit: 'I', min: 0, max: 100, decimals: 2, format: 'vector', plantBinding: 'flatness', strategy: { kind: 'constant', value: 5 } },
    ],
    config: {
      paths: [
        { path: '/api/hardness', signalId: 'hardness', responseTemplate: '{"value":${value}}' },
        { path: '/api/tensile', signalId: 'tensile', responseTemplate: '{"value":${value}}' },
        { path: '/api/yield', signalId: 'yield-str', responseTemplate: '{"value":${value}}' },
        { path: '/api/grain', signalId: 'grain-size', responseTemplate: '{"value":${value}}' },
        { path: '/api/surface', signalId: 'surface-defect', responseTemplate: '{"value":${value}}' },
        { path: '/api/flatness', signalId: 'flatness', responseTemplate: '{"points":${points},"value":${value}}' },
      ],
    },
  }

  const nodes = [heating, drive, cool, gas, inspect]
  plantModel.controls = {
    zone1: { nodeId: heating.id, signalId: 'zone1-sp' },
    zone2: { nodeId: heating.id, signalId: 'zone2-sp' },
    zone3: { nodeId: heating.id, signalId: 'zone3-sp' },
    lineSpeed: { nodeId: drive.id, signalId: 'line-speed-sp' },
    oaTemp: { nodeId: cool.id, signalId: 'oa-temp-sp' },
    coolRate: { nodeId: cool.id, signalId: 'cool-rate-sp' },
    h2: { nodeId: gas.id, signalId: 'h2-ratio-sp' },
  }
  plantModel.outputs = {
    furnaceTemp: { nodeId: heating.id, signalId: 'furnace-temp-pv' },
    stripTemp: { nodeId: heating.id, signalId: 'strip-temp-pv' },
    actSpeed: { nodeId: drive.id, signalId: 'act-speed-pv' },
    oaTemp: { nodeId: cool.id, signalId: 'oa-temp-pv' },
    dewPoint: { nodeId: gas.id, signalId: 'dew-point-pv' },
    h2Act: { nodeId: gas.id, signalId: 'h2-act-pv' },
    hardness: { nodeId: inspect.id, signalId: 'hardness' },
    tensile: { nodeId: inspect.id, signalId: 'tensile' },
    yieldStr: { nodeId: inspect.id, signalId: 'yield-str' },
    grainSize: { nodeId: inspect.id, signalId: 'grain-size' },
    surfaceDef: { nodeId: inspect.id, signalId: 'surface-defect' },
    flatness: { nodeId: inspect.id, signalId: 'flatness' },
  }
  return { nodes, plantModel }
}
