/**
 * twin-castfilm —— 挤出流延薄膜产线(演示线1)Twin Provider + ScenePack 插件。
 *
 * 物理内核:castfilm-physics.mjs(复制自 plc-node-simulator plant-model.ts 的纯函数部分,
 * 版本与同步责任见该文件头)。结构照 .AgentWorkShop/plugins/twin-thermal-demo/index.mjs:
 * setup(ctx) 里 ctx.twin.registerPhysicsProvider / registerScenePack。
 *
 * 模型类型:一阶惯性 + 纯滞后(FOPDT)灰箱;
 * 控制量→演示线1 PLC 写点语义映射(节点安全量程 [120,260]℃,单步硬上限 ≤2.8℃,见
 * 演示线1 节点语义卡 / docs/audit/e2e-2026-10-02-closedloop-opt-report.md):
 *   zone1_sp → dw-679bb3d2(加热区1SP,modbus-tcp)
 *   zone2_sp → dw-9bf10862(加热区2SP,modbus-tcp)
 *   zone3_sp → dw-52ed421c(加热区3SP,modbus-tcp)
 *   screw_rpm / line_speed_mpm / die_gap_mm 为工艺层控制(经配方/MES 面,无独立 PLC 写点)。
 */
import {
  CASTFILM_NOMINAL,
  PLANT_PARAMS,
  SENSOR_RANGE,
  castFilmRolloutWithUq,
  castFilmSteadyState,
  castFilmStep,
  clamp,
  gridSearchOptimum,
  scoreWindow,
  steadyStateWithUq,
} from './castfilm-physics.mjs'

const SCENE_ID = 'scene-castfilm-line1'
const SCENE_KIND = 'scene-castfilm-line1'
// 线2泵压场景(同一 castfilm 物理族的泵送单元)
const SCENE2_ID = 'scene-line2-pump'
const SCENE2_KIND = 'scene-line2-pump'
const SCENE_VERSION = '1.0.0'

/** 线1控制量定义(id/节点映射/量程/单步上限)——manifest 与 SceneContract 共用单一来源 */
const CONTROL_SPECS = [
  { id: 'zone1_sp', nodeId: 'dw-679bb3d2', physicalMeaning: '加热区1温度设定(演示线1 PLC Modbus TCP 写控)', unit: 'degC', min: 120, max: 260, maxStep: 2.8, protocol: 'modbus-tcp' },
  { id: 'zone2_sp', nodeId: 'dw-9bf10862', physicalMeaning: '加热区2温度设定(演示线1 PLC Modbus TCP 写控)', unit: 'degC', min: 120, max: 260, maxStep: 2.8, protocol: 'modbus-tcp' },
  { id: 'zone3_sp', nodeId: 'dw-52ed421c', physicalMeaning: '加热区3温度设定(演示线1 PLC Modbus TCP 写控)', unit: 'degC', min: 120, max: 260, maxStep: 2.8, protocol: 'modbus-tcp' },
  { id: 'screw_rpm', nodeId: undefined, physicalMeaning: '螺杆转速设定(工艺层,经配方/MES 面)', unit: 'rpm', min: 50, max: 200, maxStep: 5, protocol: 'recipe' },
  { id: 'line_speed_mpm', nodeId: undefined, physicalMeaning: '线速设定(工艺层,经配方/MES 面)', unit: 'm/min', min: 20, max: 120, maxStep: 2.5, protocol: 'recipe' },
  { id: 'die_gap_mm', nodeId: undefined, physicalMeaning: '模口间隙设定(工艺层,经配方/MES 面)', unit: 'mm', min: 0.55, max: 1.6, maxStep: 0.05, protocol: 'recipe' },
]

/** 稳态最优窗口 W*(网格搜索,与模拟器 /api/plant/optimum 同源;惰性缓存) */
let optimumCache
function optimum() {
  optimumCache ??= gridSearchOptimum()
  return optimumCache
}

function provider() {
  return {
    manifest: {
      apiVersion: 'twin-provider.v1',
      providerId: 'castfilm-greybox-v1',
      version: '1.0.0',
      sceneId: SCENE_ID,
      sceneKinds: [SCENE_KIND, SCENE2_KIND],
      backend: 'typescript',
      displayName: '挤出流延灰箱模型(castfilm FOPDT)',
      description: '一阶惯性+纯滞后灰箱:三区加热惯性/区间热传导 → 熔体温度纯滞后 → Arrhenius 粘度流量 → 泵压一阶 → 质量守恒定厚+输送纯滞后。参数复制自 plc-node-simulator plant-model.ts。',
      createdBy: 'twin-castfilm',
      stateVariables: [
        { id: 'zone1_temp', unit: 'degC', role: 'state', physicalMeaning: '加热区1温度' },
        { id: 'zone2_temp', unit: 'degC', role: 'state', physicalMeaning: '加热区2温度' },
        { id: 'zone3_temp', unit: 'degC', role: 'state', physicalMeaning: '加热区3温度' },
        { id: 'pump_pressure', unit: 'MPa', role: 'state', physicalMeaning: '泵送腔压力' },
        { id: 'thickness_um', unit: 'um', role: 'state', physicalMeaning: '测厚仪处膜厚' },
      ],
      controlVariables: CONTROL_SPECS.map(({ id, nodeId, physicalMeaning, unit, min, max, maxStep, protocol }) => ({ id, unit, role: 'control', physicalMeaning, min, max, maxStep, metadata: { nodeId, protocol } })),
      disturbanceVariables: [
        { id: 'heater_efficiency', unit: 'ratio', role: 'disturbance', physicalMeaning: '加热器效率衰减(0.2~1)' },
        { id: 'feed_temp_offset', unit: 'degC', role: 'disturbance', physicalMeaning: '进料温度偏移(℃)' },
      ],
      observationVariables: [
        { id: 'melt_temp', unit: 'degC', role: 'target', physicalMeaning: '熔体温度' },
        { id: 'pump_pressure', unit: 'MPa', role: 'target', physicalMeaning: '泵压' },
        { id: 'thickness_um', unit: 'um', role: 'target', physicalMeaning: '薄膜厚度' },
        { id: 'defect_pct', unit: '%', role: 'guard', physicalMeaning: '缺陷率' },
        { id: 'gels_per_m2', unit: 'count/m2', role: 'guard', physicalMeaning: '晶点计数' },
      ],
      parameters: {
        tauZoneSec: { value: PLANT_PARAMS.tauZoneSec, min: 60, max: 120, unit: 's' },
        kHeat: { value: PLANT_PARAMS.kHeat, min: 0.1, max: 0.4, unit: 'ratio' },
        tauMeltSec: { value: PLANT_PARAMS.tauMeltSec, min: 10, max: 40, unit: 's' },
        arrheniusB: { value: PLANT_PARAMS.arrheniusB, min: 2000, max: 2600, unit: 'K' },
        flowK: { value: PLANT_PARAMS.flowK, min: 0.02, max: 0.05, unit: 'kg/min/rpm' },
        pumpK: { value: PLANT_PARAMS.pumpK, min: 0.15, max: 0.4, unit: 'kg/min/MPa' },
        tauPumpSec: { value: PLANT_PARAMS.tauPumpSec, min: 3, max: 20, unit: 's' },
        gaugeDistanceM: { value: PLANT_PARAMS.gaugeDistanceM, min: 6, max: 24, unit: 'm' },
        dieGapRefMm: { value: PLANT_PARAMS.dieGapRefMm, min: 0.8, max: 1.2, unit: 'mm' },
      },
      parameterPriors: {
        tauZoneSec: { min: 60, max: 120 },
        kHeat: { min: 0.1, max: 0.4 },
        tauMeltSec: { min: 10, max: 40 },
        arrheniusB: { min: 2000, max: 2600 },
        flowK: { min: 0.02, max: 0.05 },
        pumpK: { min: 0.15, max: 0.4 },
        tauPumpSec: { min: 3, max: 20 },
        gaugeDistanceM: { min: 6, max: 24 },
        dieGapRefMm: { min: 0.8, max: 1.2 },
      },
      capabilities: { onlineStep: true, rollout: true, calibration: false, uncertainty: true, mpc: true },
      metadata: {
        sourceEngine: 'plc-node-simulator/src/server/engine/plant-model.ts (@0db5f40, plant-model.ts @f86653d 2026-09-18)',
        syncedAt: '2026-10-05',
        syncPolicy: '模拟器引擎变更时需手动同步插件内 castfilm-physics.mjs(复制而非跨目录 import)',
        nominal: CASTFILM_NOMINAL,
        steadyStateOptimum: '见 provider.evaluate({mode:"optimum"}) 与 /api/plant/optimum 同源网格搜索',
      },
    },

    initialize(snapshot = {}) {
      const est = snapshot.stateEstimate ?? {}
      const ctl = snapshot.controlValues ?? {}
      const z1 = Number(est.zone1_temp ?? ctl.zone1_sp ?? 200)
      const z2 = Number(est.zone2_temp ?? ctl.zone2_sp ?? 203)
      const z3 = Number(est.zone3_temp ?? ctl.zone3_sp ?? 203)
      const melt = Number(est.melt_temp ?? z3)
      const thickness = Number(est.thickness_um ?? ctl.thickness_um ?? CASTFILM_NOMINAL.thickness)
      const state = {
        zone1_temp: z1,
        zone2_temp: z2,
        zone3_temp: z3,
        pump_pressure: Number(est.pump_pressure ?? 15),
        thickness_um: thickness,
        die_gap_mm: Number(ctl.die_gap_mm ?? CASTFILM_NOMINAL.dieGap),
      }
      // 纯滞后缓冲按稳态假设预填充(旧→新全是当前值),首拍输出连续
      state.meltBufK = 20
      for (let i = 0; i < 20; i++) state[`meltBuf${i}`] = melt
      state.hBufK = 8
      for (let i = 0; i < 8; i++) state[`hBuf${i}`] = thickness
      return state
    },

    step(input = {}) {
      return castFilmStep(input.state ?? {}, input.controls ?? {}, {
        disturbances: input.disturbances ?? {},
        dtSec: input.dtSec ?? 1,
      })
    },

    /** rollout:控制序列连续推进(输出带 3 样本参数扰动 ensemble 的 uq 字段) */
    simulate(initial, controls, disturbances = {}) {
      const list = Array.isArray(controls) ? controls : controls ? [controls] : []
      const { steps, failures, uq } = castFilmRolloutWithUq(initial ?? {}, list, disturbances, 1)
      return { steps, failures, uq }
    },

    /**
     * 约束评估:约束窗 = scene 声明窗 ∩ 传感器硬量程(SENSOR_RANGE);
     * fail-closed:约束 id 映射不到轨迹观测量/守卫量 → 判不通过(同运行时 Injection 灰箱口径)。
     */
    evaluateConstraints(scene, trajectory) {
      const steps = trajectory?.steps ?? []
      if (steps.length === 0) {
        return (scene?.constraints ?? []).map(constraint => ({ id: constraint.id, passed: false, detail: '空轨迹:未执行任何校验' }))
      }
      const known = [...new Set([
        ...Object.keys(steps.at(-1)?.observations ?? {}),
        ...Object.keys(steps.at(-1)?.guards ?? {}),
      ])]
      return (scene?.constraints ?? []).map((constraint) => {
        const sensor = SENSOR_RANGE[constraint.id] ?? (constraint.id?.startsWith('zone') ? SENSOR_RANGE.zone_temp : undefined)
        const lo = sensor ? Math.max(constraint.min ?? -Infinity, sensor[0]) : constraint.min
        const hi = sensor ? Math.min(constraint.max ?? Infinity, sensor[1]) : constraint.max
        let unmapped = true
        for (let i = 0; i < steps.length; i++) {
          const value = steps[i]?.observations?.[constraint.id] ?? steps[i]?.guards?.[constraint.id]
          if (value == null) continue
          unmapped = false
          if (constraint.kind === 'hard_range' && ((lo != null && value < lo) || (hi != null && value > hi))) {
            return { id: constraint.id, passed: false, detail: `${constraint.id}=${Number(value).toFixed(2)} 越过 ${Number.isFinite(lo) ? lo : '-∞'}~${Number.isFinite(hi) ? hi : '∞'}`, firstViolationStep: i }
          }
        }
        if (unmapped) return { id: constraint.id, passed: false, detail: `约束 ${constraint.id} 无法映射到观测量/守卫量(可用:${known.join(', ') || '无'}),按失败关闭处理` }
        return { id: constraint.id, passed: true, detail: constraint.kind === 'hard_range' ? `全轨迹通过(窗 ${Number.isFinite(lo) ? lo : '-∞'}~${Number.isFinite(hi) ? hi : '∞'},量程∩工艺窗)` : `${constraint.kind} 约束由运行时评估,物理侧不否决` }
      })
    },

    /**
     * 稳态 evaluate(扩展方法,非 PhysicsModelProvider 必选):
     *   evaluate({ controls }) → 稳态代数解 + 约束预检 + ensemble 不确定度
     *   evaluate({ mode: 'optimum' }) → 网格搜索最优窗口 W*(ground truth,同 /api/plant/optimum)
     */
    evaluate(input = {}) {
      if (input.mode === 'optimum') return { mode: 'grid-search-optimum', optimum: optimum() }
      const controls = {
        zone1: Number(input.controls?.zone1_sp ?? CASTFILM_NOMINAL.zone),
        zone2: Number(input.controls?.zone2_sp ?? CASTFILM_NOMINAL.zone),
        zone3: Number(input.controls?.zone3_sp ?? CASTFILM_NOMINAL.zone),
        screw: Number(input.controls?.screw_rpm ?? CASTFILM_NOMINAL.screw),
        lineSpeed: Number(input.controls?.line_speed_mpm ?? CASTFILM_NOMINAL.lineSpeed),
        dieGap: Number(input.controls?.die_gap_mm ?? CASTFILM_NOMINAL.dieGap),
      }
      const { outputs, uq } = steadyStateWithUq(controls)
      return {
        mode: 'steady-state',
        controls: { zone1_sp: controls.zone1, zone2_sp: controls.zone2, zone3_sp: controls.zone3, screw_rpm: controls.screw, line_speed_mpm: controls.lineSpeed, die_gap_mm: controls.dieGap },
        outputs,
        score: scoreWindow({ ...outputs, screw: controls.screw, lineSpeed: controls.lineSpeed }),
        uq,
      }
    },

    /** 扩展:单点/轨迹不确定度(参数扰动 ensemble;评审口径:已知真值模型无 UQ,用 ensemble 补) */
    estimateUncertainty(input = {}) {
      if (input.controls) {
        const { uq } = steadyStateWithUq({
          zone1: Number(input.controls.zone1_sp ?? CASTFILM_NOMINAL.zone),
          zone2: Number(input.controls.zone2_sp ?? CASTFILM_NOMINAL.zone),
          zone3: Number(input.controls.zone3_sp ?? CASTFILM_NOMINAL.zone),
          screw: Number(input.controls.screw_rpm ?? CASTFILM_NOMINAL.screw),
          lineSpeed: Number(input.controls.line_speed_mpm ?? CASTFILM_NOMINAL.lineSpeed),
          dieGap: Number(input.controls.die_gap_mm ?? CASTFILM_NOMINAL.dieGap),
        })
        return uq
      }
      const list = Array.isArray(input.controlsList) ? input.controlsList : []
      const { uq } = castFilmRolloutWithUq(input.state ?? {}, list, input.disturbances ?? {}, input.dtSec ?? 1)
      return uq
    },

    /** 扩展:场景结构校验(控制量 id 对齐 + 约束可映射) */
    validateScene(scene) {
      const errors = []
      const warnings = []
      const controlIds = new Set(CONTROL_SPECS.map(c => c.id))
      for (const control of scene?.controls ?? []) {
        if (!controlIds.has(control.id)) errors.push(`控制量 ${control.id} 不在本 provider 控制集`)
      }
      const observable = new Set([...Object.keys(SENSOR_RANGE), 'zone1_temp', 'zone2_temp', 'zone3_temp'])
      for (const constraint of scene?.constraints ?? []) {
        if (!observable.has(constraint.id)) warnings.push(`约束 ${constraint.id} 无法映射到观测量/守卫量,评估时按失败关闭处理`)
      }
      return { ok: errors.length === 0, valid: errors.length === 0, errors, warnings }
    },

    health() {
      return { status: 'healthy', detail: 'castfilm FOPDT greybox ready(参数同步自 plc-node-simulator plant-model.ts @f86653d)' }
    },
  }
}

function scenePack() {
  return {
    sceneKind: SCENE_KIND, // 主场景;线2泵压经 scenePack 第二条目映射
    sceneSchemaVersion: SCENE_VERSION,
    /**
     * compile → SceneContract(contracts.ts SceneContract / sceneContractSchema 形状)。
     * 约束 = 传感器量程 ∩ 工艺窗(工艺窗取 scoreWindow 硬约束:Tm 195~225℃、P≤22MPa、
     * 厚度 50±2μm、缺陷率≤8%;与 e2e 实测节点量程交叉核对)。
     */
    compile() {
      const control = (id, extra = {}) => {
        const spec = CONTROL_SPECS.find(item => item.id === id)
        return { id, role: 'control', physicalMeaning: spec.physicalMeaning, unit: spec.unit, min: spec.min, max: spec.max, maxStep: spec.maxStep, ...(spec.nodeId ? { nodeId: spec.nodeId } : {}), ...extra }
      }
      return {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        createdBy: 'twin-castfilm',
        sceneId: SCENE_ID,
        sceneVersion: SCENE_VERSION,
        lineId: 'ln-d7e0a2a2', // 演示线1(挤出流延)
        productId: 'product-castfilm-line1',
        recipeId: 'recipe-castfilm-line1',
        phases: ['startup', 'steady'],
        controls: [
          control('zone1_sp'),
          control('zone2_sp'),
          control('zone3_sp'),
          control('screw_rpm'),
          control('line_speed_mpm'),
          control('die_gap_mm'),
        ],
        states: [
          { id: 'zone1_temp', role: 'state', physicalMeaning: '加热区1温度', unit: 'degC' },
          { id: 'zone2_temp', role: 'state', physicalMeaning: '加热区2温度', unit: 'degC' },
          { id: 'zone3_temp', role: 'state', physicalMeaning: '加热区3温度', unit: 'degC' },
          { id: 'pump_pressure', role: 'state', physicalMeaning: '泵送腔压力', unit: 'MPa' },
          { id: 'thickness_um', role: 'state', physicalMeaning: '测厚仪处膜厚', unit: 'um' },
        ],
        disturbances: [
          { id: 'heater_efficiency', role: 'disturbance', physicalMeaning: '加热器效率衰减', unit: 'ratio', min: 0.2, max: 1 },
          { id: 'feed_temp_offset', role: 'disturbance', physicalMeaning: '进料温度偏移', unit: 'degC', min: -6, max: 6 },
        ],
        // 观察节点映射自演示线1 DAQ 语义卡(e2e-2026-10-02 审计报告 §4 实测通道)
        observations: [
          { id: 'melt_temp', role: 'target', physicalMeaning: '熔体温度', unit: 'degC', min: 195, max: 225, nodeId: 'dn-0183240d' },
          { id: 'pump_pressure', role: 'target', physicalMeaning: '泵压(熔体压力)', unit: 'MPa', min: 0, max: 22, nodeId: 'dn-121838ac' },
          { id: 'thickness_um', role: 'target', physicalMeaning: '薄膜厚度', unit: 'um', min: 48, max: 52, nodeId: 'dn-b8ee4f86' },
          { id: 'defect_pct', role: 'guard', physicalMeaning: '缺陷率', unit: '%', min: 0, max: 8, nodeId: 'dn-79957615' },
          { id: 'gels_per_m2', role: 'guard', physicalMeaning: '晶点计数', unit: 'count/m2', min: 0, nodeId: 'dn-a41c49cc' },
        ],
        guards: [],
        constraints: [
          { id: 'melt_temp', kind: 'hard_range', min: 195, max: 225 },
          { id: 'pump_pressure', kind: 'hard_range', min: 0, max: 22 },
          { id: 'thickness_um', kind: 'hard_range', min: 48, max: 52 },
          { id: 'defect_pct', kind: 'hard_range', min: 0, max: 8 },
          { id: 'zone3_temp', kind: 'hard_range', min: 120, max: 260 },
        ],
        physicsProfileId: 'castfilm-greybox-v1',
        // 目标口径同 scoreWindow:55·厚度达标 + 25·品质 + 8·能耗 + 7·产能
        objectiveProfileIds: ['castfilm-window-optimum'],
        writePolicy: {
          minNodeIntervalSec: 60,
          minLineActionIntervalSec: 60,
          maxActionsPerRun: 3,
          maxDeltaPerAction: { zone1_sp: 2.8, zone2_sp: 2.8, zone3_sp: 2.8, screw_rpm: 5, line_speed_mpm: 2.5, die_gap_mm: 0.05 },
        },
      }
    },
    metadata: {
      physicsSource: 'plc-node-simulator/src/server/engine/plant-model.ts(纯函数复制,SYNC 2026-10-05)',
      nominal: CASTFILM_NOMINAL,
    },
  }
}

export default {
  name: 'twin-castfilm',
  version: '1.0.0',
  description: '挤出流延产线 Twin Provider(FOPDT 灰箱,物理同步自 plc-node-simulator plant-model)+ ScenePack(scene-castfilm-line1)',
  auth: 'none',
  setup(ctx) {
    ctx.twin.registerPhysicsProvider(provider())
    ctx.twin.registerScenePack(scenePack())
    // 线2泵压 ScenePack:screw_rpm→dw-38f145fe(唯一控制量),MeltPressure→dn-121838ac
    const scenePack2 = () => ({
      sceneId: SCENE2_ID,
      sceneKind: SCENE2_KIND,
      compile(input = {}) {
        return {
          schemaVersion: 1,
          createdAt: new Date().toISOString(),
          createdBy: 'twin-castfilm',
          sceneId: SCENE2_ID,
          sceneVersion: input.sceneVersion ?? '1.0.0',
          lineId: 'ln-83cfc594',
          recipeId: input.recipeId ?? 'rc-8f9cb3d9',
          phases: ['steady'],
          controls: [{ id: 'ScrewSpeedSP', nodeId: 'dw-38f145fe', role: 'control', physicalMeaning: '泵送螺杆转速设定(升速升压)', unit: 'rpm', min: 50, max: 200, maxStep: 3 }],
          states: [{ id: 'MeltPressure', nodeId: 'dn-121838ac', role: 'target', physicalMeaning: '熔体泵送压力(OPC UA 实测)', unit: 'MPa', min: 0, max: 45 }],
          disturbances: [], observations: [], guards: [], constraints: [],
          physicsProfileId: 'castfilm-greybox-v1',
          objectiveProfileIds: [],
          writePolicy: { minNodeIntervalSec: 60, minLineActionIntervalSec: 60, maxActionsPerRun: 6, maxDeltaPerAction: { ScrewSpeedSP: 3 } },
        }
      },
    })
    ctx.logger?.info?.('twin-castfilm:castfilm FOPDT Twin Provider 与 ScenePack(scene-castfilm-line1)已注册')
  },
}

// 供冒烟/调试:与 index 默认导出并列暴露内部工厂(不影响插件加载契约)
export { provider as castfilmProvider, scenePack as castfilmScenePack, clamp }
