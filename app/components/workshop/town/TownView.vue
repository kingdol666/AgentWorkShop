<script setup lang="ts">
/**
 * 小镇视图(AgentTeam RPG 可视化)— Vue 壳。
 *
 * 职责:挂载 Phaser(SSR 安全动态 import)、从 entities store 构建初始实体基线、
 * 订阅用TownBus(与时间线同源事件流)驱动场景、监听 channel.snapshot 重建、
 * HUD 覆盖层(加载态/连接态/当前说话者/统计)、E2E 钩子。
 */
import type Phaser from 'phaser'
import { useEntitiesStore } from '@/app/stores/workshop/entities'
import { useWorkshopWs } from '@/app/composables/workshop/useWorkshopWs'
import { useTownBus } from '@/app/composables/workshop/useTownBus'
import { useCharacterAssets } from '@/app/composables/workshop/useCharacterAssets'
import { useDeviceTwins } from '@/app/composables/workshop/useDeviceTwins'
import type { TownScene, TownEntityInput } from './TownScene'
import type { TownScene3D } from './TownScene3D'

/**
 * 两种渲染器(Phaser 2D / Three.js 3D)共享的最小公开接口。
 * TownView 无感切换:事件订阅/HUD/跑马灯/迷你地图/拖放换装只用这里的方法。
 */
export type TownViewScene
  = | TownScene
    | TownScene3D

const props = defineProps<{
  channelId: string
  /** 独立页 /town:是否汇聚全部挂载频道到同一小镇(默认 false=仅当前频道) */
  allChannels?: boolean
}>()
const entities = useEntitiesStore()
const { conn } = useWorkshopWs()
const townBus = useTownBus()
const characterAssets = useCharacterAssets()
const deviceTwins = useDeviceTwins()

const hostRef = ref<HTMLDivElement | null>(null)
/** 当前渲染器(TownScene / TownScene3D 之一) */
const sceneRef = shallowRef<TownViewScene | null>(null)
const gameRef = shallowRef<Phaser.Game | null>(null)
/** 3D 场景实例(dispose 用) */
const scene3dRef = shallowRef<TownScene3D | null>(null)
/** 渲染模式:默认 3D,?render=2d 回退 Phaser */
const render3d = typeof window !== 'undefined' ? new URLSearchParams(location.search).get('render') !== '2d' : true

// ---------- HUD ----------
const ready = ref(false)
const fps = ref(0)
const agentCount = ref(0)
const blockCount = ref(0)
const activity = ref<{ channelId: string, agentName: string, text: string } | null>(null)
const selected = ref<{ kind: 'agent' | 'device', id: string, scale: number } | null>(null)
const errorText = ref('')
const syncing = computed(() => conn.state === 'connecting')
const activeChannelName = computed(() => entities.channels[props.channelId]?.name ?? '')

/** 缩放滑杆:实时 setModelScale + 松手 persistScale */
function onScaleInput(v: number): void {
  if (!selected.value) return
  scene3dRef.value?.setModelScale(selected.value.id, v, selected.value.kind)
}
function onScaleCommit(v: number): void {
  if (!selected.value) return
  scene3dRef.value?.persistScale(selected.value.kind, selected.value.id)
  void v
}
function closeScale(): void {
  selected.value = null
}
/** 当前聚焦频道的成员(供模型库"绑定到角色") */
const libraryAgents = computed(() =>
  (entities.agents[props.channelId] ?? []).map(a => ({ agentId: a.agentId, name: a.name, role: a.role })),
)

/** 从 entities store 构建小镇实体基线(当前 workspace 挂载的 channel) */
function buildTownInput(): TownEntityInput[] {
  const out: TownEntityInput[] = []
  for (const [cid, ch] of Object.entries(entities.channels)) {
    const agents = (entities.agents[cid] ?? []).map((a) => {
      // 当前任务标题/进度:优先取 entities.tasks 里匹配 currentTaskId 的任务
      const curTask = a.currentTaskId
        ? (entities.tasks[cid] ?? []).find(t => t.id === a.currentTaskId)
        : undefined
      return {
        agentId: a.agentId,
        name: a.name,
        role: a.role,
        harness: a.harness,
        state: a.state,
        currentTaskId: a.currentTaskId ?? null,
        currentTaskTitle: curTask?.title ?? null,
        currentTaskProgress: a.currentTaskProgress ?? curTask?.progress ?? null,
        modelRef: a.modelRef ?? null,
      }
    })
    out.push({ channelId: cid, channelName: ch.name, agents })
  }
  return out
}

async function boot() {
  if (sceneRef.value || !hostRef.value) return
  if (render3d) {
    await boot3D()
  }
  else {
    await boot2D()
  }
}

/** 3D 引导(默认):Three.js TownScene3D */
async function boot3D(): Promise<void> {
  const host = hostRef.value
  if (!host) return
  const [{ TownScene3D: Scene3D }] = await Promise.all([import('./TownScene3D')])
  const scene = new Scene3D(buildTownInput(), host as HTMLDivElement)
  scene.registerModelsFromList(characterAssets.models.map(m => ({ id: m.id, file: m.file, name: m.name, kind: m.kind })))
  scene.resolveTaskAssignee = (taskId: string) => {
    const task = (entities.tasks as Record<string, Array<{ id: string, assigneeId: string }>>)[props.channelId]?.find(t => t.id === taskId)
    return task?.assigneeId ?? null
  }
  // 注入数字孪生设备 API(拖 dev 模型进场景时创建设备)
  scene.devices = {
    async create(input) {
      const t = await deviceTwins.create({ name: input.name, modelRef: input.modelRef, kind: input.kind, controls: input.controls })
      return { id: t.id }
    },
    async control(id, command, args) {
      return deviceTwins.control(id, command, args)
    },
  }
  sceneRef.value = scene
  scene3dRef.value = scene

  wireCommon(scene)

  // 选中(3D 专用):点选 Agent/设备 → 弹缩放滑杆
  scene.on('select', (v) => {
    selected.value = v
  })

  // 3D 立即可交互(canvas 同步挂载)
  ready.value = true
  bindSceneInput(scene)
  // 轮询设备遥测 → 驱动 3D 设备节点状态/颜色
  bindDevicePoll(scene)
}

/** 2D 引导(?render=2d):Phaser TownScene */
async function boot2D(): Promise<void> {
  const host = hostRef.value
  if (!host) return
  const [{ default: Phaser }, { TownScene: Scene }] = await Promise.all([
    import('phaser'),
    import('./TownScene'),
  ])
  const scene = new Scene(buildTownInput())
  sceneRef.value = scene
  scene.registerModelsFromList(characterAssets.models.map(m => ({ id: m.id, file: m.file, name: m.name })))
  scene.resolveTaskAssignee = (taskId: string) => {
    const task = (entities.tasks as Record<string, Array<{ id: string, assigneeId: string }>>)[props.channelId]?.find(t => t.id === taskId)
    return task?.assigneeId ?? null
  }
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: host.id || 'town-host',
    width: 1100,
    height: 700,
    backgroundColor: '#eceae4',
    pixelArt: true,
    antialias: false,
    roundPixels: true,
    powerPreference: 'high-performance',
    physics: { default: 'arcade', arcade: { gravity: { x: 0, y: 0 }, debug: false } },
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    scene,
  })
  gameRef.value = game

  wireCommon(scene)

  // 场景 ready 后 canvas 才挂载 → 再绑交互
  scene.on('ready', () => {
    ready.value = true
    bindSceneInput(scene)
  })
}

/**
 * 两种渲染器在 wireCommon 里共用的最小接口(不含 on;on 的事件签名两场景不同,
 * wireCommon 内部用场景实例类型收紧)。
 */
export type CommonTownScene = TownScene | TownScene3D

/** 两种渲染器共享:事件订阅 + HUD 事件 + E2E 钩子 */
function wireCommon(scene: CommonTownScene): void {
  // 事件订阅:两场景的 on 签名不同,这里用场景实例类型 + 具体事件名调用
  const s = scene as TownScene3D
  s.on('fps', (v: number) => {
    fps.value = v
  })
  s.on('agentCount', (v: number) => {
    agentCount.value = v
  })
  s.on('blockCount', (v: number) => {
    blockCount.value = v
  })
  s.on('lastActivity', (v) => {
    activity.value = v
  })

  // 事件总线 → 场景(channel.snapshot 重建;其它实时事件驱动)
  const off = townBus.subscribe((e) => {
    try {
      if (e.type === 'channel.snapshot') {
        scene.rebuild(buildTownInput())
        if (props.channelId) scene.focusChannel(props.channelId)
        return
      }
      scene.handleTownEvent(e)
    }
    catch (err) {
      errorText.value = err instanceof Error ? err.message : String(err)
    }
  })
  ;(sceneRef as unknown as { _off?: () => void })._off = off

  // E2E 调试钩子
  if (import.meta.client) {
    ;(window as unknown as Record<string, unknown>).__town = {
      get scene() { return sceneRef.value },
      get game() { return gameRef.value },
      buildInput: buildTownInput,
      get characterAssets() { return characterAssets },
    }
  }
}

/**
 * 自由视角相机 + HTML5 模型拖放。
 * - 相机:按住左键拖拽平移(避开点选角色),滚轮缩放;
 * - 拖放:AssetLibrary 的模型卡 dragstart 写入 assetId,落到场景 → 换装/生成。
 * 由场景 ready 事件调用(canvas 已挂载)。
 */
function bindSceneInput(scene: TownViewScene): void {
  if ('screenToWorld' in scene) {
    bindSceneInput3D(scene)
    return
  }
  bindSceneInput2D(scene)
}

/** 2D(Phaser):用 game.canvas + cam.worldView 反解世界坐标 */
function bindSceneInput2D(scene: Exclude<TownViewScene, TownScene3D>): void {
  const canvas = scene.game.canvas
  if (!canvas) return

  // 世界坐标 ← 页面坐标反解(经 camera worldView + canvas DOM 缩放)
  const worldFromPage = (clientX: number, clientY: number): { x: number, y: number } => {
    const cam = scene.cameras.main
    const rect = canvas.getBoundingClientRect()
    const vx = (clientX - rect.left) / rect.width
    const vy = (clientY - rect.top) / rect.height
    const wx = cam.worldView.x + vx * cam.worldView.width
    const wy = cam.worldView.y + vy * cam.worldView.height
    return { x: wx, y: wy }
  }

  // ---- 相机拖拽平移(页面像素 → 世界像素 = 页面px / zoom 缩放比) ----
  let draggingCam = false
  let lastCX = 0
  let lastCY = 0
  canvas.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return
    draggingCam = true
    lastCX = e.clientX
    lastCY = e.clientY
  })
  window.addEventListener('pointermove', (e: PointerEvent) => {
    if (!draggingCam) return
    const cam = scene.cameras.main
    const rect = canvas.getBoundingClientRect()
    // 页面 px → 世界 px:乘以 (canvas 世界宽 / canvas 页面宽) 再除以 zoom
    const scale = scene.game.scale.width / rect.width
    const dx = (e.clientX - lastCX) * scale / cam.zoom
    const dy = (e.clientY - lastCY) * scale / cam.zoom
    cam.scrollX -= dx
    cam.scrollY -= dy
    lastCX = e.clientX
    lastCY = e.clientY
  })
  window.addEventListener('pointerup', () => {
    draggingCam = false
  })

  // ---- 滚轮缩放 ----
  canvas.addEventListener('wheel', (e: WheelEvent) => {
    e.preventDefault()
    const cam = scene.cameras.main
    const nz = cam.zoom + (e.deltaY < 0 ? 0.08 : -0.08)
    cam.setZoom(Math.min(2.4, Math.max(0.6, nz)))
  }, { passive: false })

  // ---- 模型拖放(AssetLibrary.card → scene canvas) ----
  canvas.addEventListener('dragover', (e: DragEvent) => {
    e.preventDefault()
    e.dataTransfer!.dropEffect = 'copy'
  })
  canvas.addEventListener('drop', (e: DragEvent) => {
    e.preventDefault()
    const assetId = e.dataTransfer?.getData('application/x-aw-model') || e.dataTransfer?.getData('text/plain')
    if (!assetId) return
    const world = worldFromPage(e.clientX, e.clientY)
    const res = scene.dropModelOnWorld(world.x, world.y, assetId)
    lastDrop.value = res
  })
}

/** 3D(Three.js):用 scene.canvas + scene.screenToWorld + panBy/zoomBy */
function bindSceneInput3D(scene: TownScene3D): void {
  const canvas = scene.canvas
  if (!canvas) return

  // ---- 相机拖拽平移(页面位移 → scene.panBy) ----
  let draggingCam = false
  let lastCX = 0
  let lastCY = 0
  canvas.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return
    draggingCam = true
    lastCX = e.clientX
    lastCY = e.clientY
  })
  window.addEventListener('pointermove', (e: PointerEvent) => {
    if (!draggingCam) return
    const rect = canvas.getBoundingClientRect()
    // 页面 px → 世界单位(近似:视角 45°,取 rect 宽对应世界宽)
    const worldPerPx = WORLD_W3D / rect.width
    const dx = (e.clientX - lastCX) * worldPerPx
    const dy = (e.clientY - lastCY) * worldPerPx
    scene.panBy(dx, dy)
    lastCX = e.clientX
    lastCY = e.clientY
  })
  window.addEventListener('pointerup', () => {
    draggingCam = false
  })

  // ---- 滚轮缩放 ----
  canvas.addEventListener('wheel', (e: WheelEvent) => {
    e.preventDefault()
    scene.zoomBy(e.deltaY < 0 ? 0.08 : -0.08)
  }, { passive: false })

  // ---- 模型拖放(AssetLibrary.card → scene canvas) ----
  canvas.addEventListener('dragover', (e: DragEvent) => {
    e.preventDefault()
    e.dataTransfer!.dropEffect = 'copy'
  })
  canvas.addEventListener('drop', (e: DragEvent) => {
    e.preventDefault()
    const assetId = e.dataTransfer?.getData('application/x-aw-model') || e.dataTransfer?.getData('text/plain')
    if (!assetId) return
    const world = scene.screenToWorld(e.clientX, e.clientY)
    const res = scene.dropModelOnWorld(world.x, world.z, assetId)
    lastDrop.value = res
  })
}

/** 世界宽度估算(与 TownScene3D 的 WORLD_W 对齐;仅供拖拽位移换算) */
const WORLD_W3D = 3200

const lastDrop = shallowRef<{ mode: string, agentId?: string, textureKey: string, x: number, y: number } | null>(null)

/** 模型落点反馈(供 HUD 显示) */
const lastDropText = computed(() => {
  const d = lastDrop.value
  if (!d) return ''
  return d.mode === 'rebind'
    ? `已为 ${d.agentId?.slice(0, 8) ?? '角色'} 换装 → ${d.textureKey}`
    : `已在落点放入居民 → ${d.textureKey}`
})

/** 轮询设备遥测 → 驱动 3D 设备节点状态/颜色(设备节点由 dev 模型拖入生成) */
function bindDevicePoll(scene: TownScene3D): void {
  setInterval(() => {
    // 刷新列表(轻量);对每个设备节点按 state 更新 3D 环色
    void deviceTwins.load()
    for (const node of scene.getDeviceNodes()) {
      const twin = deviceTwins.byId(node.twinId)
      if (twin) scene.updateDeviceNode(node.twinId, twin.state, twin.telemetry)
    }
  }, 1500)
}

/** 迷你地图:节流轮询场景 getMinimapState,渲染缩略世界 */
const minimap = shallowRef<ReturnType<TownScene['getMinimapState']> | null>(null)
/** 事件跑马灯:最近事件队列 */
const ticker = shallowRef<Array<{ channelId: string, agentName: string, text: string }>>([])
let miniTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  miniTimer = setInterval(() => {
    const s = sceneRef.value
    if (s?.getMinimapState) minimap.value = s.getMinimapState()
    if (s?.getRecentActivity) ticker.value = s.getRecentActivity()
  }, 400)
})
onBeforeUnmount(() => {
  if (miniTimer) clearInterval(miniTimer)
})

/** 首次挂载即建一次(若 entities 已有数据) */
onMounted(() => {
  boot()
  // 若快照尚未到达,稍后 snapshot 事件会触发 rebuild;这里先发一次初始基线
  const seed = buildTownInput()
  if (seed.length > 0 && sceneRef.value) {
    sceneRef.value.rebuild(seed)
  }
})

onBeforeUnmount(() => {
  const off = (sceneRef as unknown as { _off?: () => void })._off
  off?.()
  scene3dRef.value?.dispose()
  scene3dRef.value = null
  gameRef.value?.destroy(true)
  gameRef.value = null
  sceneRef.value = null
})
</script>

<template>
  <div class="town-view">
    <div class="town-frame">
      <div
        id="town-host"
        ref="hostRef"
        class="town-host"
      />
      <div class="hud pointer-events-none absolute inset-0 z-10 select-none">
        <!-- 左:模型库(可拖拽到场景,pointer-events 开启) -->
        <WorkshopAssetLibrary
          class="lib-panel"
          :channel-id="props.channelId"
          :agents="libraryAgents"
        />
        <!-- 左:数字孪生侧栏(设备列表/遥测/控制) -->
        <WorkshopDeviceTwinPanel class="twin-panel" />

        <!-- 选中 Agent/设备 → 缩放滑杆(客制化) -->
        <div
          v-if="selected"
          class="scale-panel"
        >
          <div class="scale-title">
            <span class="scale-kind">{{ selected.kind === 'agent' ? '角色' : '设备' }}</span>
            <span class="scale-id">{{ selected.id.slice(0, 8) }}</span>
            <button
              class="scale-close"
              @click="closeScale"
            >
              ×
            </button>
          </div>
          <div class="scale-row">
            <span class="scale-min">0.2×</span>
            <input
              class="scale-range"
              type="range"
              min="0.2"
              max="5"
              step="0.05"
              :value="selected.scale"
              @input="onScaleInput(Number(($event.target as HTMLInputElement).value))"
              @change="onScaleCommit(Number(($event.target as HTMLInputElement).value))"
            >
            <span class="scale-max">5×</span>
          </div>
          <div class="scale-val">
            {{ Math.round(selected.scale * 100) }}%
          </div>
        </div>

        <!-- 顶栏:标题 / 统计 / 连接 -->
        <div class="absolute top-0 left-0 right-0 flex items-start justify-between p-4">
          <div class="glass-chip">
            <span class="ch-dot" />
            <span class="hud-title">AGENTTEAM 小镇</span>
            <span class="hud-sub">Channel · {{ activeChannelName || '加载中' }}</span>
          </div>
          <div class="glass-chip">
            <span
              class="conn-dot"
              :class="conn.state === 'open' ? 'on' : 'off'"
            />
            {{ conn.state === 'open' ? '在线' : syncing ? '同步中' : '离线' }}
            <span class="hud-sep" />
            <span class="hud-mono">{{ blockCount }} 领地 · {{ agentCount }} 精魂</span>
            <span class="hud-sep" />
            <span class="hud-mono">{{ fps }} FPS</span>
          </div>
        </div>

        <!-- 事件跑马灯(最近几条"此刻谁在说话") -->
        <div
          v-if="ticker.length"
          class="ticker-box"
        >
          <div class="ticker-title">
            事件流
          </div>
          <div
            v-for="(t, i) in ticker"
            :key="`${t.agentName}-${i}`"
            class="ticker-row"
          >
            <span class="act-ava">{{ t.agentName.charAt(0).toUpperCase() }}</span>
            <span class="act-name">{{ t.agentName }}</span>
            <span class="act-text">{{ t.text }}</span>
          </div>
        </div>

        <!-- 模型落点反馈 -->
        <div
          v-if="lastDropText"
          class="drop-chip"
        >
          {{ lastDropText }}
        </div>

        <!-- 迷你地图(缩略世界;领地色点+角色+视口) -->
        <div
          v-if="minimap"
          class="mini-map"
          :title="'世界 · 点击跳转'"
        >
          <svg
            :viewBox="`0 0 ${minimap.world.w} ${minimap.world.h}`"
            class="mini-svg"
          >
            <rect
              x="0"
              y="0"
              :width="minimap.world.w"
              :height="minimap.world.h"
              fill="rgba(14,21,36,0.35)"
            />
            <circle
              v-for="b in minimap.blocks"
              :key="`b-${b.name}`"
              :cx="b.x * minimap.world.w"
              :cy="b.y * minimap.world.h"
              r="70"
              :fill="`#${b.color.toString(16).padStart(6, '0')}`"
              opacity="0.45"
            />
            <circle
              v-for="a in minimap.agents"
              :key="`a-${a.x}-${a.y}`"
              :cx="a.x * minimap.world.w"
              :cy="a.y * minimap.world.h"
              :r="a.busy ? 16 : 11"
              :fill="`#${a.color.toString(16).padStart(6, '0')}`"
            />
            <rect
              :x="(minimap.player.x - 0.04) * minimap.world.w"
              :y="(minimap.player.y - 0.04) * minimap.world.h"
              :width="0.08 * minimap.world.w"
              :height="0.08 * minimap.world.h"
              fill="rgba(255,255,255,0.18)"
              stroke="#fff"
              stroke-width="4"
            />
          </svg>
          <span class="mini-label">MAP · {{ blockCount }} 领地</span>
        </div>

        <!-- 错误态 -->
        <div
          v-if="errorText"
          class="error-chip"
        >
          {{ errorText }}
        </div>

        <!-- 加载遮罩 -->
        <div
          v-if="!ready"
          data-hud="town-loading"
          class="loading-mask"
        >
          <div class="loading-spinner" />
          <span class="loading-text">正在铺设小镇…</span>
        </div>
      </div>
    </div>
    <p class="town-foot">
      传奇共鸣城镇 · 每频道 = 一片共鸣领地,每角色 = 一个共鸣精魂 · 同频道共享同色灵光 · 角色可自由拖动 · 头顶气泡 = 实时事件
    </p>
  </div>
</template>

<style scoped>
.town-view {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.town-frame {
  position: relative;
  width: 100%;
  max-width: 1160px;
  aspect-ratio: 16 / 10;
  border-radius: var(--radius-panel);
  overflow: hidden;
  border: 1px solid var(--line);
  box-shadow: var(--shadow-float);
}
.town-host {
  position: absolute;
  inset: 0;
}
.town-host canvas { image-rendering: pixelated; }
.town-foot { margin-top: 10px; font-size: 11.5px; color: var(--ink-faint); text-align: center; }

.hud { font-family: var(--font-body); }

/* 模型库面板(可交互,脱离 pointer-events-none) */
.lib-panel {
  position: absolute;
  top: 56px;
  left: 16px;
  pointer-events: auto;
  max-height: min(56vh, 420px);
  overflow: hidden auto;
}

/* 数字孪生侧栏(右侧,迷你地图上方) */
.twin-panel {
  position: absolute;
  right: 16px;
  bottom: 290px;
  pointer-events: auto;
  max-height: min(34vh, 300px);
  overflow: hidden auto;
}

/* 选中缩放面板(点击角色/设备后弹出) */
.scale-panel {
  position: absolute;
  bottom: 46px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 260px;
  padding: 10px 14px;
  pointer-events: auto;
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--accent);
  border-radius: var(--radius-panel);
  box-shadow: var(--glass-highlight), var(--shadow-float);
}
.scale-title { display: flex; gap: 8px; align-items: center; font-size: 12px; color: var(--ink-soft); }
.scale-kind { font-weight: 700; color: var(--ink); }
.scale-id { font-family: var(--font-mono); font-size: 10px; color: var(--ink-faint); }
.scale-close { margin-left: auto; font-size: 14px; color: var(--ink-faint); background: transparent; border: 0; cursor: pointer; }
.scale-row { display: flex; gap: 8px; align-items: center; }
.scale-min, .scale-max { font-family: var(--font-mono); font-size: 9px; color: var(--ink-faint); }
.scale-range { flex: 1; accent-color: var(--accent); }
.scale-val { text-align: center; font-family: var(--font-mono); font-size: 11px; color: var(--ink); }

/* 模型落点反馈 */
.drop-chip {
  position: absolute;
  bottom: 16px;
  left: 188px;
  max-width: 60%;
  padding: 7px 12px;
  font-size: 12px;
  color: var(--ink-soft);
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--accent);
  border-radius: var(--radius-pill);
  box-shadow: var(--glass-highlight), var(--shadow-float);
}

.glass-chip {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 6px 12px;
  font-size: 12px;
  color: var(--ink-soft);
  background: var(--frost-bg);
  backdrop-filter: var(--frost-blur);
  -webkit-backdrop-filter: var(--frost-blur);
  border: 1px solid var(--glass-line);
  border-radius: var(--radius-panel-sm);
}
.hud-title { font-weight: 700; color: var(--ink); letter-spacing: 0.02em; }
.hud-sub { font-size: 11px; color: var(--ink-faint); }
.hud-mono { font-family: var(--font-mono); font-size: 11px; color: var(--ink-faint); }
.hud-sep { width: 1px; height: 12px; background: var(--line-strong); }
.ch-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--tone-info-dot); }
.conn-dot { width: 8px; height: 8px; border-radius: 50%; }
.conn-dot.on { background: var(--tone-success-dot); }
.conn-dot.off { background: var(--tone-danger-dot); }

/* 迷你地图 */
.mini-map {
  position: absolute;
  bottom: 74px;
  right: 16px;
  width: 168px;
  pointer-events: auto;
  overflow: hidden;
  background: var(--frost-bg);
  backdrop-filter: var(--frost-blur);
  -webkit-backdrop-filter: var(--frost-blur);
  border: 1px solid var(--glass-line);
  border-radius: var(--radius-panel-sm);
  box-shadow: var(--glass-highlight), var(--shadow-float);
}
.mini-svg {
  display: block;
  width: 100%;
  height: auto;
}
.mini-label {
  display: block;
  padding: 3px 8px;
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.08em;
  color: var(--ink-faint);
  background: var(--frost-bg);
  border-top: 1px solid var(--glass-line);
}

/* 事件跑马灯 */
.ticker-box {
  position: absolute;
  bottom: 16px;
  left: 188px;
  width: min(46%, 380px);
  max-height: 150px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 7px 10px;
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--glass-line);
  border-radius: var(--radius-panel-sm);
  box-shadow: var(--glass-highlight), var(--shadow-float);
}
.ticker-title {
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.1em;
  color: var(--ink-faint);
}
.ticker-row {
  display: flex;
  gap: 6px;
  align-items: center;
  overflow: hidden;
  font-size: 11px;
}
.act-name { flex: none; font-weight: 600; color: var(--ink); }
.act-text { overflow: hidden; color: var(--ink-soft); text-overflow: ellipsis; white-space: nowrap; }

/* 当前说话者 */
.activity-chip {
  position: absolute;
  bottom: 44px;
  left: 188px;
  display: flex;
  gap: 8px;
  align-items: center;
  max-width: 70%;
  padding: 6px 12px;
  font-size: 12px;
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--glass-line);
  border-radius: var(--radius-pill);
  box-shadow: var(--glass-highlight), var(--shadow-float);
}
.act-ava {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  font-size: 11px;
  font-weight: 600;
  color: var(--on-av);
  background: var(--av-fallback);
  border-radius: var(--radius-panel-sm);
}
.act-name { flex: none; font-weight: 600; color: var(--ink); }
.act-text {
  overflow: hidden;
  color: var(--ink-soft);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 错误态 */
.error-chip {
  position: absolute;
  bottom: 16px;
  right: 16px;
  max-width: 60%;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--tone-danger-dot);
  background: var(--tone-danger-bg);
  border: 1px solid color-mix(in srgb, var(--tone-danger-dot) 30%, transparent);
  border-radius: var(--radius-panel-sm);
}

/* 加载态 */
.loading-mask {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
  justify-content: center;
  background: var(--paper);
}
.loading-spinner {
  width: 26px;
  height: 26px;
  border: 2.5px solid var(--line-strong);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .loading-spinner { animation: none; } }
.loading-text { font-size: 12.5px; color: var(--ink-faint); }
</style>
