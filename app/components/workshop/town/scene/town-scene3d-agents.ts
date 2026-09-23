/**
 * AgentTeam RPG 小镇(Three.js 3D 表现层)— 角色节点层与模型库挂载。
 *
 * 自 TownScene3D.ts 抽出:
 *  - ensureAgent:按实体元数据实例化 Agent3D(落点钳制 / 活动范围 / 身份光环 / 名牌);
 *  - mountModel:GLB 加载 → 归一化 scale/贴地 → mixer(失败回退程序化机器人,永不白屏);
 *  - registerModelsFromList:模型清单增量登记,并把晚到资产挂到已存在的 Agent/设备;
 *  - swapAgentModel / setAnimPref / getAgentModel|Name|Clips:模型与动作绑定公开面;
 *  - dropModelOnWorld / spawnResident / swapTexture / nearestAgent:拖拽落点换装或生成居民。
 *
 * 宿主契约:场景类实现 AgentLayerHost(只列本模块触达的成员)。
 */
import * as THREE from 'three'
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { GROUND_Y, UNITS, clampToBoundary, type AgentRangeLayout } from '#shared/town-scene-math'
import type { TownBubbleKind } from '#shared/town-protocol'
import { hexOf, makeFallbackBot, makeLabel } from './town-scene3d-factory'
import { loadGltf } from './town-scene3d-models'
import { Agent3D, type DeviceNode } from './town-scene3d-nodes'
import type { AgentHost, DeviceTwinSync, ModelInfo, TownEntityInput, TownEventMap } from './town-scene3d-types'

/** 角色层模块的宿主契约(继承节点侧 AgentHost,保证 agent.host 注入可编译期校验) */
export interface AgentLayerHost extends AgentHost {
  readonly scene: THREE.Scene
  readonly agents: Map<string, Agent3D>
  readonly deviceNodes: Map<string, DeviceNode>
  /** 已登记模型(id → file) */
  readonly modelsById: Map<string, ModelInfo>
  /** GLTF 缓存(避免重复加载) */
  readonly gltfCache: Map<string, { file: string, scene: THREE.Group, height: number }>
  /** 模型动画 clip 缓存(file → clips) */
  readonly agentAnimClips: Map<string, THREE.AnimationClip[]>
  readonly gltfLoader: GLTFLoader
  /** 服务端已有但模型资产尚未注册的设备孪生 */
  readonly pendingDeviceTwins: Map<string, DeviceTwinSync>
  /** 已销毁(模型清单登记中止) */
  readonly disposed: boolean
  /** 组装可缩放目标并恢复初始化缩放 */
  registerScalable(kind: 'agent' | 'device', id: string, holder: THREE.Group, initialScale?: number): void
  /** 模型 PBR 材质增强 */
  enhancePbrMaterials(root: THREE.Object3D, kind: 'device' | 'character'): void
  /** 数字孪生设备节点:拖 dev 模型进场景生成 */
  spawnDeviceNode(x: number, z: number, texKey: string, file: string, name: string): string
  /** 按设备孪生记录重建场景节点 */
  recreateDeviceNode(t: DeviceTwinSync): void
  /** 设备换模型:按 modelRef 重挂 GLB 到 holder */
  swapDeviceModelSprite(dev: DeviceNode, modelRef: string): void
  /** 实时信息入队(换装/生成提示) */
  enqueueBubble(channelId: string, agentId: string | undefined, kind: TownBubbleKind, text: string, ttlMs: number): void
  /** 场景 → Vue HUD 事件 */
  emit<K extends keyof TownEventMap>(event: K, e: TownEventMap[K]): void
  /** 请求下一帧重绘 */
  markDirty(): void
}

export function ensureAgent(host: AgentLayerHost, a: TownEntityInput['agents'][number] & { channelId: string }, cx: number, cz: number, color: number): void {
  const key = a.agentId
  if (host.agents.has(key)) return
  // 管理员布局落点(来自 config.homeX/homeZ)优先;缺省按领地内排布;整体钳制在频道边界内
  const layout = host.blockLayoutOf(a.channelId)
  let homeX = a.homeX ?? cx
  let homeZ = a.homeZ ?? cz
  if (layout) {
    const clamped = clampToBoundary(layout, homeX, homeZ, 20)
    homeX = clamped.x
    homeZ = clamped.z
  }
  // 管理员布局活动范围(来自 config.range;缺省 null = 沿用频道边界);收进频道边界
  const range: AgentRangeLayout | null = a.range ?? null
  const root = new THREE.Group()
  root.position.set(homeX, GROUND_Y, homeZ)
  const nameSprite = makeLabel(host.scene, a.name, homeX, 48, homeZ, hexOf(color))
  // 默认模型(内置二次元角色 hero-anime-1「樱叶少女」;模型库换装可覆盖)
  const texKey = a.modelRef || 'hero-anime-1'
  const model = new THREE.Group()
  root.add(model)
  host.scene.add(root)
  const agent = new Agent3D({
    channelId: a.channelId,
    agentId: key,
    name: a.name,
    role: a.role,
    root,
    model,
    mixer: null,
    clips: [],
    colorNum: color,
    nameSprite,
    bubble: null,
    bubbleText: null,
    bubbleTimer: null,
    state: a.state,
    progress: a.currentTaskProgress ?? null,
    dragging: false,
    homeX,
    homeZ,
    range,
    rangeLine: null,
    textureKey: texKey,
    modelRef: a.modelRef ?? '',
    behavior: { mode: 'idle', roamTarget: null, targetId: null, waitUntil: 0, pauseUntil: 0, engaged: false },
  })
  agent.host = host
  agent.attachAura(color, a.role)
  host.agents.set(key, agent)
  // 载入模型(GLB);模型库注册先于/晚于挂载都能正确解析(内置二次元角色按 id 直取文件)
  const info = host.modelsById.get(texKey)
    ?? (texKey.startsWith('hero-anime-')
      ? { id: texKey, file: `/assets/game/character/${texKey}.glb`, name: '二次元角色' }
      : (host.modelsById.get('hero-3d') ?? { id: 'hero-3d', file: '/assets/game/character/hero-3d.glb', name: '标准员工模型' }))
  void mountModel(host, agent, info.file, info.name)
  agent.renderRangeLine()
  host.emit('agentCount', host.agents.size)
}

/**
 * 绑定模型到 Agent(GLTFLoader 加载 → 归一化 scale/锚点贴地 → 若有动画则 mixer)。
 * 缺失/失败 → 回退内置 hero-3d,永不白屏。
 */
export async function mountModel(host: AgentLayerHost, asp: Agent3D, file: string, name: string): Promise<void> {
  const cached = host.gltfCache.get(file)
  let loaded: THREE.Group
  let height: number
  if (cached) {
    loaded = cached.scene.clone(true)
    height = cached.height
  }
  else {
    try {
      const gltf = await loadGltf(host.gltfLoader, file)
      loaded = gltf.scene
      const box = new THREE.Box3().setFromObject(loaded)
      height = Math.max(0.5, box.max.y - box.min.y)
      host.gltfCache.set(file, { file, scene: loaded, height })
      // 缓存动画 clip(供 mixer 状态切换;GLTFLoader 动画必须在解析层保留)
      host.agentAnimClips.set(file, gltf.animations)
    }
    catch {
      // 加载失败回退程序化「孪生机器人」(胶囊躯干 + 发光核心 + 天线),角色永不隐形
      loaded = makeFallbackBot()
      height = 1.4
    }
  }
  // 归一化 scale(使模型高度≈UNITS 世界单位)并贴地(模型大小自适应)
  loaded.position.y = 0
  loaded.scale.setScalar(UNITS / height)
  // 真实投影 + PBR 增强:模型网格 cast/receiveShadow(体积感) + 分级环境反射(角色质感)
  loaded.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = true
  })
  host.enhancePbrMaterials(loaded, 'character')
  // 清掉旧模型子节点与 mixer
  asp.model.clear()
  asp.model.add(loaded)
  // 客制化:注册可缩放目标并恢复用户缩放(套在 asp.model 上,作为自适应之上的倍率层)
  host.registerScalable('agent', asp.agentId, asp.model)
  asp.mixer = null
  asp.activeAction = null
  const clips = host.agentAnimClips.get(file) ?? []
  const firstClip = clips[0]
  if (firstClip) {
    asp.mixer = new THREE.AnimationMixer(loaded)
    asp.clips = clips
    const firstAction = asp.mixer.clipAction(firstClip)
    firstAction.play()
    asp.activeAction = firstAction
  }
  void name
  host.markDirty()
}

/** 注册模型清单，并将晚到资产挂载到已存在的 Agent/设备。 */
export function registerModelsFromList(host: AgentLayerHost, list: Array<{ id: string, file: string, name: string, kind?: string, hFactor?: number }>): void {
  if (host.disposed) return
  const changed = new Set<string>()
  for (const model of list) {
    const previous = host.modelsById.get(model.id)
    if (!previous || previous.file !== model.file || previous.name !== model.name || previous.kind !== model.kind || previous.hFactor !== (model.hFactor ?? 1)) {
      host.modelsById.set(model.id, { ...model, hFactor: model.hFactor ?? 1 })
      changed.add(model.id)
    }
  }
  if (changed.size > 0) {
    for (const agent of host.agents.values()) {
      if (!agent.modelRef || !changed.has(agent.modelRef)) continue
      const model = host.modelsById.get(agent.modelRef)
      if (model) void mountModel(host, agent, model.file, model.name)
    }
    for (const device of host.deviceNodes.values()) {
      if (changed.has(device.modelRef)) host.swapDeviceModelSprite(device, device.modelRef)
    }
  }
  for (const twin of [...host.pendingDeviceTwins.values()]) {
    const isDaq = twin.kind === 'daq' || (twin.modelRef ?? '').startsWith('daq-')
    if (!isDaq && !host.modelsById.get(twin.modelRef)?.file) continue
    host.pendingDeviceTwins.delete(twin.id)
    host.recreateDeviceNode(twin)
  }
}

/** 为指定角色换装模型(选择器绑定;要求实体已在场景,否则仅记录) */
export function swapAgentModel(host: AgentLayerHost, agentId: string, modelRef: string): void {
  const asp = host.agents.get(agentId)
  if (!asp) return
  const info = host.modelsById.get(modelRef)
  const file = info?.file ?? '/assets/game/character/hero-3d.glb'
  asp.modelRef = modelRef
  asp.textureKey = modelRef
  void mountModel(host, asp, file, info?.name ?? modelRef)
}

/** 动作绑定:为某 Agent 指定动画 clip(按名称 idle/walk/work 或索引)。供 AssetLibrary 选择动作后调用。 */
export function setAnimPref(host: AgentLayerHost, agentId: string, clipName: string): void {
  const asp = host.agents.get(agentId)
  if (!asp || asp.clips.length === 0 || !asp.mixer) return
  // 解析:优先名称匹配,否则 idle→0/walk→1/work→末帧
  let idx = asp.clips.findIndex(c => c.name.toLowerCase().includes(clipName.toLowerCase()))
  if (idx < 0) idx = clipName === 'work' ? asp.clips.length - 1 : clipName === 'walk' ? Math.min(1, asp.clips.length - 1) : 0
  const clip = asp.clips[idx]
  if (!clip) return
  asp.mixer.stopAllAction()
  asp.mixer.clipAction(clip).reset().play()
}

/** 角色当前绑定模型 id(供模型选择器高亮) */
export function getAgentModel(host: AgentLayerHost, agentId: string): string | null {
  const asp = host.agents.get(agentId)
  return asp?.modelRef ?? null
}

/** 角色名字(供模型选择器标题) */
export function getAgentName(host: AgentLayerHost, agentId: string): string {
  return host.agents.get(agentId)?.name ?? agentId.slice(0, 8)
}

/** 角色动画 clip 名列表(供 UI 展示可绑定动作;无则空) */
export function getAgentClips(host: AgentLayerHost, agentId: string): Array<{ name: string, duration: number }> {
  const asp = host.agents.get(agentId)
  if (!asp) return []
  return asp.clips.map(c => ({ name: c.name, duration: Math.round(c.duration * 10) / 10 }))
}

export function dropModelOnWorld(host: AgentLayerHost, x: number, z: number, assetId: string): { mode: 'rebind' | 'spawn', agentId?: string, textureKey: string, x: number, y: number } {
  const near = nearestAgent(host, x, z, 80)
  const model = host.modelsById.get(assetId)
  const texKey = model?.id ?? assetId
  // 数字孪生实体模型(kind=dev):拖入场景生成"设备节点" + 绑定 device twin
  if (model?.kind === 'dev') {
    const twinId = host.spawnDeviceNode(x, z, texKey, model.file, model.name)
    return { mode: 'spawn', agentId: twinId, textureKey: texKey, x: Math.round(x), y: Math.round(z) }
  }
  if (near) {
    swapTexture(host, near, texKey)
    host.enqueueBubble(near.channelId, near.agentId, 'info', `换装 → ${model?.name ?? assetId}`, 2200)
    return { mode: 'rebind', agentId: near.agentId, textureKey: texKey, x: Math.round(near.root.position.x), y: Math.round(near.root.position.z) }
  }
  // 落点生成居民
  const info = model ?? { id: assetId, file: '', name: assetId }
  spawnResident(host, x, z, texKey, info.name)
  return { mode: 'spawn', textureKey: texKey, x: Math.round(x), y: Math.round(z) }
}

export function nearestAgent(host: AgentLayerHost, x: number, z: number, maxDist: number): Agent3D | undefined {
  let best: Agent3D | undefined
  let bestD = maxDist
  for (const a of host.agents.values()) {
    const d = Math.hypot(a.root.position.x - x, a.root.position.z - z)
    if (d < bestD) {
      best = a
      bestD = d
    }
  }
  return best
}

export function swapTexture(host: AgentLayerHost, asp: Agent3D, texKey: string): void {
  const info = host.modelsById.get(texKey)
  const file = info?.file ?? resolveFile(host, texKey) ?? '/assets/game/character/hero-3d.glb'
  asp.modelRef = texKey
  asp.textureKey = texKey
  void mountModel(host, asp, file, info?.name ?? texKey)
}

export function spawnResident(host: AgentLayerHost, x: number, z: number, texKey: string, name: string): void {
  const root = new THREE.Group()
  root.position.set(x, GROUND_Y, z)
  const model = new THREE.Group()
  root.add(model)
  const nameSprite = makeLabel(host.scene, name, x, 48, z, hexOf(0xffe9c4))
  host.scene.add(root)
  const resident = new Agent3D({
    channelId: '', agentId: `resident-${Date.now().toString(36)}`, name,
    role: 'worker', root, model, mixer: null, clips: [], colorNum: 0xffe9c4, nameSprite,
    bubble: null, bubbleText: null, bubbleTimer: null, state: 'idle', progress: null,
    dragging: false, homeX: x, homeZ: z, range: null, rangeLine: null, textureKey: texKey, modelRef: texKey,
    behavior: { mode: 'idle', roamTarget: null, targetId: null, waitUntil: 0, pauseUntil: 0, engaged: false },
  })
  resident.host = host
  resident.attachAura(0xffe9c4, 'worker')
  host.agents.set(resident.agentId, resident)
  const info = host.modelsById.get(texKey)
  void mountModel(host, resident, info?.file ?? '/assets/game/character/hero-3d.glb', info?.name ?? name)
}

/** 模型库文件反查(短 modelRef 兜底) */
function resolveFile(host: AgentLayerHost, id: string): string {
  return host.modelsById.get(id)?.file ?? ''
}
