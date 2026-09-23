/**
 * 小镇视图 — 场景运行时(引导/事件总线/输入接线/设备轮询/布局收敛)
 *
 * 自 TownView.vue 抽出(纯结构搬移,行为与模板契约逐字保持)。
 * 依赖经参数对象显式注入(父组件仍是共享状态唯一持有者):
 *   - 2D?render=2d(Phaser)/ 3D(Three.js)引导与公共事件订阅;
 *   - townBus → 场景增量收敛(snapshot/device/scene.layout);
 *   - 设备孪生轮询、布局版本幂等收敛、E2E 钩子。
 */
import { onBeforeUnmount, onMounted } from 'vue'
import type { ComputedRef, Ref, ShallowRef } from 'vue'
import type Phaser from 'phaser'
import type { useEntitiesStore } from '@/app/stores/workshop/entities'
import type { useSceneLayouts } from '@/app/composables/workshop/useSceneLayouts'
import type { useCharacterAssets } from '@/app/composables/workshop/useCharacterAssets'
import type { useDeviceTwins, DeviceTwinView } from '@/app/composables/workshop/useDeviceTwins'
import type { useDaqStream } from '@/app/composables/workshop/useDaqStream'
import type { useTownBus } from '@/app/composables/workshop/useTownBus'
import type { ChannelLayout, AgentRangeLayout, TownScene3D } from '@/app/components/workshop/town/TownScene3D'
import type { TownEntityInput } from '@/app/components/workshop/town/TownScene'
import type { CommonTownScene, TownViewScene } from '@/app/components/workshop/town/TownView.vue'
import { mapEnvelopeToIntent } from '#shared/town-protocol'
import type { QualityMode } from './useTownSceneControl'

export function useTownSceneRuntime(params: {
  props: { channelId: string, allChannels?: boolean }
  entities: ReturnType<typeof useEntitiesStore>
  sceneLayouts: ReturnType<typeof useSceneLayouts>
  characterAssets: ReturnType<typeof useCharacterAssets>
  deviceTwins: ReturnType<typeof useDeviceTwins>
  townBus: ReturnType<typeof useTownBus>
  daq: ReturnType<typeof useDaqStream>
  sceneRef: ShallowRef<TownViewScene | null>
  scene3dRef: ShallowRef<TownScene3D | null>
  gameRef: ShallowRef<Phaser.Game | null>
  hostRef: Ref<HTMLDivElement | null>
  render3d: boolean
  ready: Ref<boolean>
  fps: Ref<number>
  agentCount: Ref<number>
  blockCount: Ref<number>
  activity: Ref<{ channelId: string, agentName: string, text: string } | null>
  selected: Ref<{ kind: 'agent' | 'device', id: string, scale: number, rotation: number } | null>
  errorText: Ref<string>
  saveState: Ref<{ state: 'idle' | 'dirty' | 'saving' | 'saved' | 'error', at: number } | null>
  fpsCap: Ref<'60' | '120' | '0'>
  qualityMode: Ref<QualityMode>
  selectedChannel: Ref<string | null>
  boundaryDraft: Ref<ChannelLayout | null>
  agentRangeDraft: Ref<{ radiusX: number, radiusZ: number, shape: 'ellipse' | 'rect' } | null>
  onSelectChannel: (cid: string | null) => void
  buildTownInput: () => TownEntityInput[]
  updateAgentHome: (agentId: string, channelId: string, x: number, z: number) => Promise<unknown>
  updateAgentRange: (agentId: string, channelId: string, range: AgentRangeLayout | null) => Promise<unknown>
  sceneTwinPool: ComputedRef<DeviceTwinView[]>
  sceneTwinById: (id: string) => DeviceTwinView | undefined
  syncSceneDevices: (scene: TownViewScene) => void
  appendLiveChat: (agentId: string, kind: string, text: string, atRaw: number | string | undefined, seq?: number) => void
  bindSceneInput: (scene: TownViewScene) => void
  dockRev: Ref<number>
}) {
  const { props, entities, sceneLayouts, characterAssets, deviceTwins, townBus, daq, sceneRef, scene3dRef, gameRef, hostRef, render3d, ready, fps, agentCount, blockCount, activity, selected, errorText, saveState, fpsCap, qualityMode, selectedChannel, boundaryDraft, agentRangeDraft, onSelectChannel, buildTownInput, updateAgentHome, updateAgentRange, sceneTwinPool, sceneTwinById, syncSceneDevices, appendLiveChat, bindSceneInput, dockRev } = params
  const { t } = useI18n()

  let devicePollTimer: ReturnType<typeof setInterval> | null = null

  function syncSceneModels(scene: TownViewScene | null): void {
    if (!scene || !('registerModelsFromList' in scene)) return
    if ('screenToWorld' in scene) {
      scene.registerModelsFromList(characterAssets.models.map(m => ({ id: m.id, file: m.file, name: m.name, kind: m.kind, hFactor: m.hFactor ?? 1 })))
    }
    else {
      scene.registerModelsFromList(characterAssets.models.map(m => ({ id: m.id, file: m.file, name: m.name })))
    }
  }
  // 签名对比替代 deep 监听:模型资产任何字段变化都曾触发全量 syncSceneModels;
  // 实际只有增删/换文件才需要同步(id+file 签名)
  watch(() => characterAssets.models.map(m => `${m.id}:${m.file}`).join('|'), () => syncSceneModels(sceneRef.value))

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
    // 布局加载不阻塞场景 ready:先建空场地,布局异步到达后 apply + rebuild。
    // 若加载失败(401/网络),keep catch 静默 → 场景保持空场地,用户手动拖入频道。
    const [{ TownScene3D: Scene3D }] = await Promise.all([import('@/app/components/workshop/town/TownScene3D')])
    const scene = new Scene3D(buildTownInput(), host as HTMLDivElement)
    scene.resolveTaskAssignee = (taskId: string) => {
      const task = (entities.tasks as Record<string, Array<{ id: string, assigneeId: string }>>)[props.channelId]?.find(t => t.id === taskId)
      return task?.assigneeId ?? null
    }
    // 注入数字孪生设备 API(拖 dev 模型进场景时创建设备;场景 transform 变更落库)
    scene.devices = {
      async create(input) {
        const t = await deviceTwins.create({
          name: input.name,
          modelRef: input.modelRef,
          kind: input.kind,
          controls: input.controls,
          posX: input.posX,
          posZ: input.posZ,
          scale: input.scale,
        })
        return { id: t.id }
      },
      async update(id, patch) {
        // 数采节点伪孪生 → 场景落点走 daq REST(节点实体在 server)
        if (daq.nodeById(id)) {
          await daq.saveTransform(id, patch.posX, patch.posZ)
          return undefined
        }
        await deviceTwins.update(id, patch)
        return undefined
      },
      async remove(id) {
        if (daq.nodeById(id)) {
          await daq.removeNode(id)
          return
        }
        await deviceTwins.remove(id)
      },
      async control(id, command, args) {
        return deviceTwins.control(id, command, args)
      },
    }
    // 注入管理员布局:持久化角色落点 + 独立活动范围
    scene.agentApi = {
      async updateHome(agentId, channelId, x, z) {
        return updateAgentHome(agentId, channelId, x, z)
      },
      async updateRange(agentId, channelId, range) {
        return updateAgentRange(agentId, channelId, range)
      },
    }
    // 注入频道布局持久化:频道整体拖拽 / 边界手柄调整后经 useSceneLayouts 落库
    scene.channelApi = {
      async save(channelId, layout) {
        return sceneLayouts.save(channelId, layout)
      },
    }
    sceneRef.value = scene
    syncSceneModels(scene)
    scene3dRef.value = scene
    // 应用持久化的帧率上限与画质档(渲染配置;数据消费不受影响)
    scene.setFpsCap(Number(fpsCap.value))
    scene.setQualityMode(qualityMode.value)

    wireCommon(scene)

    // 选中(3D 专用):点选 Agent/设备 → 弹缩放/旋转滑杆
    scene.on('select', (v) => {
      selected.value = v
    })
    // 保存状态(布局落库进度 → HUD 徽标)
    scene.on('saveState', (v) => {
      saveState.value = v
    })
    // 点选频道 → 打开边界编辑面板
    scene.on('selectChannel', (cid) => {
      onSelectChannel(cid)
    })
    // 频道被拖拽/手柄调整 → 边界面板草稿即时跟随(避免保存时回退旧值)
    scene.on('channelResized', (e) => {
      if (!e) return
      if (selectedChannel.value === e.channelId) boundaryDraft.value = e.layout
    })
    // Agent 活动范围被框选绘制/整框移动/手柄调整/清除 → 对象面板草稿即时跟随
    scene.on('agentRangeChanged', (e) => {
      if (!e) return
      if (selected.value?.kind === 'agent' && selected.value.id === e.agentId) {
        const r = scene3dRef.value?.getAgentRange?.(e.agentId)
        agentRangeDraft.value = r ? { radiusX: r.radiusX, radiusZ: r.radiusZ, shape: r.shape } : null
      }
    })

    // 3D 立即可交互(canvas 同步挂载)
    ready.value = true
    bindSceneInput(scene)
    // 轮询设备遥测 → 驱动 3D 设备节点状态/颜色
    devicePollTimer = bindDevicePoll(scene)

    // 布局异步加载:到达后按数据库元数据统一实例化并初始化场景内全部实例
    // (频道布局 + 实体基线 + 设备孪生 → hydrate;仅放置的频道呈现)。
    // 健壮性:composable 内部已 3 次退避重试;此处再兜底 —— 失败浮出错误并定时重拉,
    // rev-watch 会在数据到达后自动收敛重建,任何时序下频道都不会"消失"。
    void sceneLayouts.load().then(() => {
      scene.hydrate(buildTownInput(), Object.values(sceneLayouts.layouts), sceneTwinPool.value)
      syncChannelDock()
    }).catch((err) => {
      errorText.value = t('townView.k1hmf2ut192', { p0: apiErrorMessage(err) })
      window.setTimeout(() => {
        void sceneLayouts.load()
      }, 2500)
    })
  }
  /** 2D 引导(?render=2d):Phaser TownScene */
  async function boot2D(): Promise<void> {
    const host = hostRef.value
    if (!host) return
    const [Phaser, { TownScene: Scene }] = await Promise.all([
      import('phaser'),
      import('@/app/components/workshop/town/TownScene'),
    ])
    const scene = new Scene(buildTownInput())
    sceneRef.value = scene
    syncSceneModels(scene)
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
      dockRev.value++
    })
    s.on('lastActivity', (v) => {
      activity.value = v
    })

    // 事件总线 → 场景(channel.snapshot 重建;其它实时事件驱动)
    const off = townBus.subscribe((e) => {
      try {
        if (e.type === 'channel.snapshot') {
          scene.rebuild(buildTownInput())
          // rebuild 内部 resetAll 清掉全部设备/数采节点,必须立即按全量池恢复
          if (sceneRef.value) syncSceneDevices(sceneRef.value)
          if (props.channelId) scene.focusChannel(props.channelId)
          return
        }
        // 设备场景事件:updated(含遥测直推,1s 节流)走增量合并;
        // created 走全量重拉(新孪生需完整字段);deleted 本地移除
        if (e.type === 'device.updated') {
          deviceTwins.applyRemote((e.payload as unknown as DeviceTwinView))
          if (sceneRef.value) syncSceneDevices(sceneRef.value)
          return
        }
        if (e.type === 'device.created') {
          void deviceTwins.load().then(() => {
            if (sceneRef.value) syncSceneDevices(sceneRef.value)
          })
          return
        }
        if (e.type === 'device.deleted') {
          deviceTwins.removeRemote((e.payload as { id: string }).id)
          if (sceneRef.value) syncSceneDevices(sceneRef.value)
          return
        }
        // 频道布局事件(他人编辑边界/移入移除):重拉布局 → 场景即时收敛
        if (e.type === 'scene.layout.saved' || e.type === 'scene.layout.removed') {
          void sceneLayouts.load().then(() => {
            syncSceneLayouts(sceneRef.value)
            syncChannelDock()
          })
          return
        }
        // 会话台实时缓冲:气泡意图 → 所属角色的近实时消息(与头顶气泡同语义;
        // 独立于事件日志 30 条上限,选中角色的消息不会被其他角色刷屏挤掉)
        const bub = mapEnvelopeToIntent(e)?.bubble
        if (bub?.agentId) appendLiveChat(bub.agentId, bub.kind, bub.text, e.at, e.seq)
        scene.handleTownEvent(e)
      }
      catch (err) {
        errorText.value = apiErrorMessage(err)
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
  // 布局数据版本 → 幂等收敛:load 晚到/save/remove/他人编辑后,场景一律重建对齐
  // (hydrates 是 resetAll+rebuild,幂等;这是"每次进场都能从数据库实例化"的最终保证)
  watch(() => sceneLayouts.rev, (rev) => {
    const scene = scene3dRef.value
    if (!scene || !sceneLayouts.loaded || rev === 0) return
    // 设备输入必须是全量池(含 DAQ 投影):hydrate→syncDevices 按清单对账,漏 daq 会清场
    scene.hydrate(buildTownInput(), Object.values(sceneLayouts.layouts), sceneTwinPool.value)
    syncChannelDock()
  })

  /** 用频道布局清单收敛场景(已放置频道存在性/边界;供 WS 事件后即时同步) */
  function syncSceneLayouts(scene: TownViewScene | null): void {
    if (!scene || !('applySceneLayouts' in scene)) return
    const s = scene as TownScene3D
    // 先应用全部布局到场景(新增/变更/移除),再 rebuild 实体基线(仅放置的频道呈现)
    s.applySceneLayouts(Object.values(sceneLayouts.layouts))
    s.rebuild(buildTownInput())
  }

  /** 频道坞已放置/未放置标记刷新(布局变化后) */
  function syncChannelDock(): void {
    void sceneLayouts.load().finally(() => {
      // 由场景 hasChannel 反映;以下依赖已完成加载
    })
  }

  /** 设备控制台行点击 → 场景镜头聚焦该实体并选中(工业 HMI 联动手感) */
  function onFocusDevice(t: { id: string, posX?: number, posZ?: number }): void {
    const s = scene3dRef.value
    if (!s) return
    if (typeof t.posX === 'number' && typeof t.posZ === 'number') s.focusTo(t.posX, t.posZ)
    ;(s as unknown as { setSelected?: (x: { kind: 'device', id: string }) => void }).setSelected?.({ kind: 'device', id: t.id })
  }
  /** 轮询设备孪生 → 场景节点同步 + 状态环颜色(设备节点由 dev 模型拖入/服务端恢复生成) */
  function bindDevicePoll(scene: TownScene3D): ReturnType<typeof setInterval> {
    // 5s 兜底轮询:遥测/状态主通道是 WS device.updated 直推(server 1s 节流),
    // 轮询仅覆盖断线窗口(useDeviceTwins.load 已 in-flight 去重)
    return setInterval(() => {
      void deviceTwins.load().then(() => {
        if (sceneRef.value !== scene) return
        scene.syncDevices(sceneTwinPool.value)
        for (const node of scene.getDeviceNodes()) {
          const twin = sceneTwinById(node.twinId)
          if (twin) scene.updateDeviceNode(node.twinId, twin.state, twin.telemetry)
        }
      })
    }, 5000)
  }
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
    if (devicePollTimer) clearInterval(devicePollTimer)
    devicePollTimer = null
    const off = (sceneRef as unknown as { _off?: () => void })._off
    off?.()
    scene3dRef.value?.dispose()
    scene3dRef.value = null
    gameRef.value?.destroy(true)
    gameRef.value = null
    sceneRef.value = null
  })

  return { onFocusDevice, syncSceneLayouts }
}
