/**
 * 小镇视图 — 场景输入接线(相机拖拽/滚轮/拖放)与落点反馈
 *
 * 自 TownView.vue 抽出(纯结构搬移,行为与模板契约逐字保持):
 *   - 2D(Phaser cam.worldView)与 3D(OrbitLite)相机手势与滚轮;
 *   - 频道坞/数采节点/智控节点/模型库拖放落点;
 *   - window 级监听器清理登记(卸载统一移除)与落点提示文案。
 */
import { computed, onBeforeUnmount, shallowRef } from 'vue'
import type { ComputedRef, Ref, ShallowRef } from 'vue'
import type { useDaqStream } from '@/app/composables/workshop/useDaqStream'
import type { useDcwStream } from '@/app/composables/workshop/useDcwStream'
import type { DeviceTwinView } from '@/app/composables/workshop/useDeviceTwins'
import type { TownScene3D } from '@/app/components/workshop/town/TownScene3D'
import type { TownViewScene } from '@/app/components/workshop/town/TownView.vue'
import type { DockChannelRow } from './town-view-types'

export function useTownSceneInput(params: {
  mode: Ref<'browse' | 'edit'>
  runHint: () => void
  dockChannels: ComputedRef<DockChannelRow[]>
  dropChannelAt: (channelId: string, x: number, z: number) => boolean
  daq: ReturnType<typeof useDaqStream>
  dcw: ReturnType<typeof useDcwStream>
  nearestDeviceTwin: (x: number, z: number, maxDist: number) => DeviceTwinView | null
  bindDaq: (daqId: string, deviceId: string) => void
  syncSceneDevices: (scene: TownViewScene) => void
  sceneRef: ShallowRef<TownViewScene | null>
  errorText: Ref<string>
}) {
  const { mode, runHint, dockChannels, dropChannelAt, daq, dcw, nearestDeviceTwin, bindDaq, syncSceneDevices, sceneRef, errorText } = params
  const { t } = useI18n()

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
  /** window 级监听器清理登记(卸载统一移除;匿名 window 监听器持已销毁场景 = 悬空引用) */
  const windowCleanups: Array<() => void> = []

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
    const onCamPointerMove = (e: PointerEvent): void => {
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
    }
    const onCamPointerUp = (): void => {
      draggingCam = false
    }
    window.addEventListener('pointermove', onCamPointerMove)
    window.addEventListener('pointerup', onCamPointerUp)
    windowCleanups.push(() => window.removeEventListener('pointermove', onCamPointerMove))
    windowCleanups.push(() => window.removeEventListener('pointerup', onCamPointerUp))

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
  /** 3D(Three.js):相机交互 1:1 设计稿 OrbitLite ——
   *  左键拖拽=环绕 / 中键·右键·Shift+左键=平移 / 滚轮=dolly(乘性);
   *  实体/领地/手柄拖拽优先,双击实体=flyTo 聚焦(场景内部已实现)。 */
  function bindSceneInput3D(scene: TownScene3D): void {
    const canvas = scene.canvas
    if (!canvas) return

    let camMode = 0 // 0 无 / 1 环绕 / 2 平移
    let lastCX = 0
    let lastCY = 0
    canvas.addEventListener('contextmenu', e => e.preventDefault())
    canvas.addEventListener('mousedown', (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault()
    })
    canvas.addEventListener('pointerdown', (e: PointerEvent) => {
      // 变换手柄悬停/拖拽 → 让出(手柄优先)
      if (scene.isGizmoBusy?.()) return
      const panGesture = e.button === 1 || e.button === 2 || e.shiftKey
      if (panGesture) {
        e.preventDefault()
        camMode = 2
        lastCX = e.clientX
        lastCY = e.clientY
        return
      }
      if (e.button !== 0) return
      // 编辑模式:实体/领地/范围/边界等场景拖拽接管;未接管(空白处)→ 左键环绕
      if (scene.tryStartPointerDrag(e.clientX, e.clientY)) return
      camMode = 1
      lastCX = e.clientX
      lastCY = e.clientY
    })
    const onScenePointerMove = (e: PointerEvent): void => {
      if (scene.isGizmoBusy?.()) return
      if (scene.isPointerDragging()) {
        scene.movePointerDrag(e.clientX, e.clientY)
        return
      }
      if (!camMode) return
      const dx = e.clientX - lastCX
      const dy = e.clientY - lastCY
      lastCX = e.clientX
      lastCY = e.clientY
      if (camMode === 1) scene.orbitBy(dx, dy)
      else scene.panByScreen(dx, dy)
    }
    const onScenePointerUp = (): void => {
      if (scene.isPointerDragging()) {
        scene.endPointerDrag()
        return
      }
      camMode = 0
    }
    window.addEventListener('pointermove', onScenePointerMove)
    window.addEventListener('pointerup', onScenePointerUp)
    windowCleanups.push(() => window.removeEventListener('pointermove', onScenePointerMove))
    windowCleanups.push(() => window.removeEventListener('pointerup', onScenePointerUp))

    // ---- 滚轮 dolly(设计稿:乘性缩放,任意层级手感一致) ----
    canvas.addEventListener('wheel', (e: WheelEvent) => {
      e.preventDefault()
      scene.zoomBy(e.deltaY > 0 ? 0.12 : -0.11)
    }, { passive: false })

    // ---- 拖放(频道坞→安放频道;模型库→换装/生成居民) ----
    canvas.addEventListener('dragover', (e: DragEvent) => {
      e.preventDefault()
      e.dataTransfer!.dropEffect = 'copy'
    })
    canvas.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault()
      const dt = e.dataTransfer
      if (!dt) return
      // 运行模式只读:不接受任何场景投放(频道/数采/设备)
      if (mode.value !== 'edit') {
        runHint()
        return
      }
      // 1) 频道坞拖入 → 安放频道 + 其 Agent
      const channelId = dt.getData('application/x-aw-channel') || dt.getData('text/plain')
      if (channelId && dockChannels.value.some(c => c.channelId === channelId)) {
        const world = scene.screenToWorld(e.clientX, e.clientY)
        dropChannelAt(channelId, world.x, world.z)
        return
      }
      // 1.5) 数采节点拖入 → 既有 server 节点落位(PATCH 位置;WS 收敛全端)
      //      未绑定设备时:落点 ±95 内最近设备自动绑定(已绑定保持不重绑)
      const daqNodeId = dt.getData('application/x-aw-daq-node')
      if (daqNodeId) {
        const n = daq.nodeById(daqNodeId)
        if (n) {
          const world = scene.screenToWorld(e.clientX, e.clientY)
          void daq.patchNode(daqNodeId, { posX: Math.round(world.x), posZ: Math.round(world.z) }).then(() => {
            if (!n.deviceBindingId) {
              const near = nearestDeviceTwin(world.x, world.z, 95)
              if (near) bindDaq(daqNodeId, near.id)
            }
          }).catch((err: unknown) => {
            errorText.value = apiErrorMessage(err)
          })
        }
        return
      }
      // 1.6) 智控节点拖入 → 落位 + 未绑定时 ±95 内设备自动绑定(绑定后可直写下发)
      const dcwNodeId = dt.getData('application/x-aw-dcw-node')
      if (dcwNodeId) {
        const n = dcw.nodes.find(x => x.id === dcwNodeId)
        if (n) {
          const world = scene.screenToWorld(e.clientX, e.clientY)
          void dcw.patchNode(dcwNodeId, { posX: Math.round(world.x), posZ: Math.round(world.z) }).then(() => {
            if (!n.deviceBindingId) {
              const near = nearestDeviceTwin(world.x, world.z, 95)
              if (near) {
                void dcw.bindNode(dcwNodeId, near.id).catch((err: unknown) => {
                  errorText.value = apiErrorMessage(err)
                })
              }
            }
            if (sceneRef.value) syncSceneDevices(sceneRef.value)
          }).catch((err: unknown) => {
            errorText.value = apiErrorMessage(err)
          })
        }
        return
      }
      // 2) 模型拖放 → 换装/生成
      const assetId = dt.getData('application/x-aw-model') || dt.getData('text/plain')
      if (assetId) {
        const world = scene.screenToWorld(e.clientX, e.clientY)
        const res = scene.dropModelOnWorld(world.x, world.z, assetId)
        lastDrop.value = res
      }
    })
  }
  const lastDrop = shallowRef<{ mode: string, agentId?: string, textureKey: string, x: number, y: number } | null>(null)

  /** 模型落点反馈(供 HUD 显示) */
  const lastDropText = computed(() => {
    const d = lastDrop.value
    if (!d) return ''
    return d.mode === 'rebind'
      ? t('townView.kgz2nej193', { p0: d.agentId?.slice(0, 8) ?? t('townView.k479op189'), p1: d.textureKey })
      : t('townView.k5e2460194', { p0: d.textureKey })
  })

  onBeforeUnmount(() => {
    for (const fn of windowCleanups) {
      try {
        fn()
      }
      catch { /* 尽力清理 */ }
    }
    windowCleanups.length = 0
  })

  return { bindSceneInput, lastDropText }
}
