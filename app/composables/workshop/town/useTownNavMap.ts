/**
 * 小镇视图 — 3D 导航地图(全域缩略图 + 镜头联动)
 *
 * 自 TownView.vue 抽出(纯结构搬移,行为与模板契约逐字保持):
 * 相机注视点钉死图心,世界内容随镜头滑动;拖拽 = 平移镜头,点击 = 聚焦该点。
 * 150ms 节拍同时回填相机位姿与标注跟随坐标(与标注层共用同一拍)。
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import type { ComputedRef, Ref, ShallowRef } from 'vue'
import type { useDaqStream } from '@/app/composables/workshop/useDaqStream'
import type { DeviceTwinView } from '@/app/composables/workshop/useDeviceTwins'
import type { TownScene3D } from '@/app/components/workshop/town/TownScene3D'
import type { TownViewScene } from '@/app/components/workshop/town/TownView.vue'
import type { MiniState } from './town-view-types'

export function useTownNavMap(params: {
  sceneRef: ShallowRef<TownViewScene | null>
  scene3dRef: ShallowRef<TownScene3D | null>
  stageRef: Ref<HTMLElement | null>
  camPose: Ref<{ pos: { x: number, y: number, z: number }, target: { x: number, z: number }, yaw: number, dolly: number }>
  calloutPos: Ref<Record<string, { x: number, y: number }>>
  showCallouts: Ref<boolean>
  daq: ReturnType<typeof useDaqStream>
  daqTwins: ComputedRef<DeviceTwinView[]>
  boundDeviceOf: (daqId: string) => string | null
}) {
  const { sceneRef, scene3dRef, stageRef, camPose, calloutPos, showCallouts, daq, daqTwins, boundDeviceOf } = params

  /** 迷你地图节拍(卸载时清理;150ms 保证镜头居中滑动跟手) */
  let miniTimer: ReturnType<typeof setInterval> | null = null

  /* ============================================================
   * 小地图(设计稿 drawMinimap):全域固定比例导航图 + 相机锥/准星。
   * 画布重绘在 miniTimer(150ms);拖拽 = panWorldBy,滚轮 = dolly。
   * ============================================================ */
  const WORLD_W3D = 3200
  const WORLD_H3D = 2400
  const minimap = shallowRef<MiniState | null>(null)
  const toHex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`
  /* ============================================================
   * 3D 导航地图(RPG 规范):相机注视点钉死图心,世界内容随镜头移动在图下滑动。
   * 缩放与 3D 视角同源:窗口宽 = NAV_BASE_WIN × dolly(滚轮/+- 直接调 3D dolly,
   * 小地图与视角永远同步);窗外实体以边缘信标(clamped blip)呈现,全域可见。
   * 拖拽 = 平移镜头;点击 = 聚焦该点。
   * ============================================================ */
  const navCanvas = ref<HTMLCanvasElement | null>(null)
  /** 导航图画布元素回填(画布随 components/TownNavMap.vue 搬移,导航图绘制仍由父组件持有) */
  function setNavCanvas(el: Element | ComponentPublicInstance | null): void {
    navCanvas.value = (el as HTMLCanvasElement | null)
  }
  const NAV_BASE_WIN = 1600
  /** 地图窗口缩放随 3D dolly(夹在 0.4~5;dolly 再深地图不再放大) */
  const navScale = computed(() => Math.min(5, Math.max(0.4, camPose.value.dolly)))
  let navDrag: { lx: number, ly: number, moved: boolean } | null = null
  /** 投影:镜头注视点 = 图心;返回 比例尺(s) 与 画布尺寸。 */
  function navProj(cv: HTMLCanvasElement): { s: number, w: number, h: number } {
    const w = cv.clientWidth || 220
    const h = cv.clientHeight || 148
    const winW = NAV_BASE_WIN * navScale.value
    return { s: w / winW, w, h }
  }
  function drawNavMap(): void {
    const cv = navCanvas.value
    const mm = minimap.value
    const s3 = scene3dRef.value
    if (!cv) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const P = navProj(cv)
    if (cv.width !== Math.round(P.w * dpr) || cv.height !== Math.round(P.h * dpr)) {
      cv.width = Math.round(P.w * dpr)
      cv.height = Math.round(P.h * dpr)
    }
    const x = cv.getContext('2d')
    if (!x) return
    x.setTransform(dpr, 0, 0, dpr, 0, 0)
    x.fillStyle = '#060b13'
    x.fillRect(0, 0, P.w, P.h)
    // 相机注视点(RPG 的"你在这里")= 图心;投影:世界 → 画布
    const pose = s3?.getCameraPose()
    const cx = pose ? pose.target.x : WORLD_W3D / 2
    const cz = pose ? pose.target.z : WORLD_H3D / 2
    const halfW = P.w / 2 / P.s
    const halfH = P.h / 2 / P.s
    const toPx = (wx: number, wz: number): { x: number, y: number } => ({
      x: P.w / 2 + (wx - cx) * P.s,
      y: P.h / 2 + (wz - cz) * P.s,
    })
    const inWin = (wx: number, wz: number, pad = 60): boolean =>
      wx > cx - halfW - pad && wx < cx + halfW + pad && wz > cz - halfH - pad && wz < cz + halfH + pad
    // 网格点阵(仅窗口内;固定世界步长,内容随镜头滑动)
    x.fillStyle = 'rgba(65,200,244,.10)'
    const step = 250
    for (let gx = Math.floor((cx - halfW) / step) * step; gx <= cx + halfW; gx += step) {
      for (let gz = Math.floor((cz - halfH) / step) * step; gz <= cz + halfH; gz += step) {
        const p = toPx(gx, gz)
        x.fillRect(p.x - 1, p.y - 1, 1.6, 1.6)
      }
    }
    // 世界边界(绿框;越界即出画布,提示世界边沿)
    const b0 = toPx(0, 0)
    const b1 = toPx(WORLD_W3D, WORLD_H3D)
    x.strokeStyle = 'rgba(53,224,160,.35)'
    x.lineWidth = 1
    x.strokeRect(b0.x, b0.y, b1.x - b0.x, b1.y - b0.y)
    // 领地(色环 + 淡填充;窗口外跳过)
    for (const b of mm?.blocks ?? []) {
      const wx = b.x * WORLD_W3D
      const wz = b.y * WORLD_H3D
      if (!inWin(wx, wz, 400)) continue
      const p = toPx(wx, wz)
      const rx = Math.max(4, (b.rx ?? 0.03) * WORLD_W3D * P.s)
      const ry = Math.max(3, (b.rz ?? 0.03) * WORLD_H3D * P.s)
      x.strokeStyle = toHex(b.color)
      x.globalAlpha = 0.6
      x.lineWidth = 1
      x.beginPath()
      x.ellipse(p.x, p.y, rx, ry, 0, 0, Math.PI * 2)
      x.stroke()
      x.globalAlpha = 0.08
      x.fillStyle = toHex(b.color)
      x.fill()
      x.globalAlpha = 1
    }
    // 绑定链路(数采→设备 青色细线;server 绑定为权威)
    x.strokeStyle = 'rgba(65,200,244,.28)'
    const boundSet = new Set(daq.nodes.filter(n => n.deviceBindingId).map(n => n.id))
    for (const [daqId, devId] of daq.nodes.filter(n => n.deviceBindingId).map(n => [n.id, n.deviceBindingId!] as const)) {
      const dn = (mm?.devices ?? []).find(d => d.twinId === daqId)
      const dv = (mm?.devices ?? []).find(d => d.twinId === devId)
      if (!dn || !dv) continue
      const a = toPx(dn.x * WORLD_W3D, dn.y * WORLD_H3D)
      const b = toPx(dv.x * WORLD_W3D, dv.y * WORLD_H3D)
      x.beginPath()
      x.moveTo(a.x, a.y)
      x.lineTo(b.x, b.y)
      x.stroke()
    }
    // 实体:设备方点 / 数采绿点(绑定光环)/ Agent 圆点;窗外实体 → 边缘信标(夹到图框,
    // 缩小 + 降透明度)—— 所有实体始终在图上有落点,全景不丢导航信息
    const blip = (p: { x: number, y: number }): { x: number, y: number, edge: boolean } => {
      const m = 7
      if (p.x >= m && p.x <= P.w - m && p.y >= m && p.y <= P.h - m) return { ...p, edge: false }
      return { x: Math.min(P.w - m, Math.max(m, p.x)), y: Math.min(P.h - m, Math.max(m, p.y)), edge: true }
    }
    for (const d of mm?.devices ?? []) {
      const wx = d.x * WORLD_W3D
      const wz = d.y * WORLD_H3D
      const p = blip(toPx(wx, wz))
      if (d.daq) {
        x.globalAlpha = p.edge ? 0.4 : 1
        x.fillStyle = '#35e0a0'
        x.beginPath()
        x.arc(p.x, p.y, p.edge ? 1.8 : 2.4, 0, 7)
        x.fill()
        if (!p.edge && d.twinId && boundSet.has(d.twinId)) {
          x.strokeStyle = 'rgba(53,224,160,.5)'
          x.beginPath()
          x.arc(p.x, p.y, 4.4, 0, 7)
          x.stroke()
        }
      }
      else {
        x.globalAlpha = p.edge ? 0.4 : 1
        x.fillStyle = toHex(d.color)
        const s = p.edge ? 3.6 : 5.2
        x.fillRect(p.x - s / 2, p.y - s / 2, s, s)
      }
      x.globalAlpha = 1
    }
    for (const a of mm?.agents ?? []) {
      const wx = a.x * WORLD_W3D
      const wz = a.y * WORLD_H3D
      const p = blip(toPx(wx, wz))
      x.globalAlpha = p.edge ? 0.35 : 1
      x.fillStyle = toHex(a.color)
      x.beginPath()
      x.arc(p.x, p.y, p.edge ? 1.6 : 2.2, 0, 7)
      x.fill()
      x.globalAlpha = 1
    }
    // 图心准星(RPG 规范:钉死中央不随内容移动):
    // 视锥扇形指向注视方向(相机→注视点 = -(sinYaw, cosYaw)),相机本体若在窗内画白点
    if (pose) {
      const viewAng = Math.atan2(-Math.cos(pose.yaw), -Math.sin(pose.yaw))
      const r = Math.min(P.w, P.h) * 0.36
      x.fillStyle = 'rgba(65,200,244,.14)'
      x.strokeStyle = 'rgba(65,200,244,.5)'
      x.lineWidth = 1
      x.beginPath()
      x.moveTo(P.w / 2, P.h / 2)
      x.arc(P.w / 2, P.h / 2, r, viewAng - 0.4, viewAng + 0.4)
      x.closePath()
      x.fill()
      x.stroke()
      const cam = toPx(pose.pos.x, pose.pos.z)
      if (cam.x > 4 && cam.x < P.w - 4 && cam.y > 4 && cam.y < P.h - 4) {
        x.fillStyle = 'rgba(255,255,255,.85)'
        x.beginPath()
        x.arc(cam.x, cam.y, 2.4, 0, 7)
        x.fill()
      }
    }
    x.fillStyle = '#fff'
    x.beginPath()
    x.arc(P.w / 2, P.h / 2, 3, 0, 7)
    x.fill()
    x.strokeStyle = 'rgba(255,255,255,.4)'
    x.beginPath()
    x.arc(P.w / 2, P.h / 2, 5.5, 0, 7)
    x.stroke()
  }
  /** 地图缩放 = 3D dolly(与视角同源):滚轮/+- 直接驱动场景缩放,小地图自动跟随 */
  function onNavWheel(e: WheelEvent): void {
    scene3dRef.value?.zoomBy(e.deltaY > 0 ? 0.14 : -0.12)
  }
  function onNavDown(e: PointerEvent): void {
    navDrag = { lx: e.clientX, ly: e.clientY, moved: false }
    // headless/合成事件无活动指针 → setPointerCapture 会抛 NotFoundError
    try {
      ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    }
    catch { /* 无真实指针时忽略 */ }
  }
  function onNavMove(e: PointerEvent): void {
    const cv = navCanvas.value
    const s3 = scene3dRef.value
    if (!navDrag || !cv || !s3) return
    const P = navProj(cv)
    const dx = e.clientX - navDrag.lx
    const dy = e.clientY - navDrag.ly
    if (Math.abs(dx) + Math.abs(dy) > 3) navDrag.moved = true
    const dxw = dx / P.s
    const dzw = dy / P.s
    navDrag.lx = e.clientX
    navDrag.ly = e.clientY
    // 抓取语义:拖右 = 世界右移 = 镜头左扫(注视点/相机同步平移)
    s3.panWorldBy(dxw, dzw)
  }
  function onNavUp(e: PointerEvent): void {
    // 无拖拽的单击 = RPG 点图移动:镜头聚焦到该世界点
    const cv = navCanvas.value
    const s3 = scene3dRef.value
    if (navDrag && !navDrag.moved && cv && s3) {
      const rect = cv.getBoundingClientRect()
      const P = navProj(cv)
      const pose = s3.getCameraPose()
      const wx = pose.target.x + (e.clientX - rect.left - rect.width / 2) / P.s
      const wz = pose.target.z + (e.clientY - rect.top - rect.height / 2) / P.s
      s3.focusTo(wx, wz)
    }
    navDrag = null
  }
  function miniTick(): void {
    const s = sceneRef.value
    if (s?.getMinimapState) minimap.value = s.getMinimapState()
    drawNavMap()
    // 标注跟随:锚定绑定设备的模型顶面(无绑定 → 数采立杆顶),150ms 跟手
    const s3 = scene3dRef.value
    if (s3) {
      camPose.value = s3.getCameraPose()
      if (showCallouts.value) {
        const nodes = s3.getDeviceNodes()
        // worldToScreen 返回页面坐标;callout-layer 是 stage 相对定位 → 换算成 stage 内坐标
        const sRect = stageRef.value?.getBoundingClientRect()
        const next: Record<string, { x: number, y: number }> = {}
        for (const t of daqTwins.value) {
          const boundDev = boundDeviceOf(t.id)
          const anchor = boundDev ? nodes.find(n => n.twinId === boundDev) : nodes.find(n => n.twinId === t.id)
          if (!anchor) continue
          const p = s3.worldToScreen(anchor.x, (anchor.topY ?? 92) + 26, anchor.z)
          if (p && sRect) next[t.id] = { x: p.x - sRect.left, y: p.y - sRect.top }
        }
        calloutPos.value = next
      }
    }
  }

  /** 后台标签页暂停小地图节拍(前台恢复;恒定 CPU 底噪归零) */
  function onVisChange(): void {
    if (document.hidden) {
      if (miniTimer) {
        clearInterval(miniTimer)
        miniTimer = null
      }
      return
    }
    if (!miniTimer) miniTimer = setInterval(miniTick, 150)
  }

  onMounted(() => {
    document.addEventListener('visibilitychange', onVisChange)
    miniTimer = setInterval(miniTick, 150)
  })
  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', onVisChange)
    if (miniTimer) clearInterval(miniTimer)
    miniTimer = null
  })

  return { minimap, navScale, setNavCanvas, onNavWheel, onNavDown, onNavMove, onNavUp, drawNavMap, miniTick }
}
