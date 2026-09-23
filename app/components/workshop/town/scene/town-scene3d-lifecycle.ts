/**
 * AgentTeam RPG 小镇(Three.js 3D 表现层)— 实例资源释放与整场重置。
 *
 * 自 TownScene3D.ts 抽出:
 *  - disposeCanvasTextures / disposeDeviceAssets / disposeAgentAssets:每实例独占资源释放;
 *  - resetAll:rebuild 用整场清空(角色/领地/设备/选中/手柄);
 *  - dispose:卸载(停 rAF、清探针、清定时器、断开观察器、释放手柄与后处理/渲染器)。
 *
 * 注意:GLB 克隆(clone)与 gltfCache 原件**共享** geometry/material/纹理,
 * 其 GPU 资源归缓存原件管理 —— 释放路径绝不可碰 GLB 克隆内部,否则同模型
 * 其他活动实例会被连带摧毁。这里只释放每实例独占的资源:
 * 名牌/气泡的 CanvasTexture(材质 map)、状态环/链路等自建几何与材质。
 *
 * 宿主契约:场景类实现 LifecycleHost(只列本模块触达的成员)。
 */
import type * as THREE from 'three'
import type { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import type { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import type { Agent3D, Block3D, DeviceNode } from './town-scene3d-nodes'
import type {
  ChannelMessageReceiver, ChannelResizeHandle, AgentRangeHandle, PointerDragState, ScaledTarget, SelectedTarget,
} from './town-scene3d-types'

/** 生命周期模块的宿主契约(一项 = 本模块真正用到的字段/方法) */
export interface LifecycleHost {
  readonly scene: THREE.Scene
  readonly renderer: THREE.WebGLRenderer
  readonly composer: EffectComposer
  /** 舞台 DOM(canvas 挂载点) */
  readonly el: HTMLDivElement
  readonly agents: Map<string, Agent3D>
  readonly blocks: Map<string, Block3D>
  readonly deviceNodes: Map<string, DeviceNode>
  readonly scalables: Map<string, ScaledTarget>
  readonly receivers: Map<string, ChannelMessageReceiver>
  readonly resizeHandles: ChannelResizeHandle[]
  readonly agentRangeHandles: AgentRangeHandle[]
  readonly pendingSaveTimers: Map<string, ReturnType<typeof setTimeout>>
  resizeOb: ResizeObserver | null
  tControls: TransformControls | null
  pointerDrag: PointerDragState
  selected: SelectedTarget | null
  selectedChannel: string | null
  disposed: boolean
  raf: number
  /** 退出框选绘制模式(清理预览与状态) */
  cancelRangeDraw(): void
}

/** 释放对象树内所有 Canvas 纹理(名牌/气泡 sprite 的独占资源) */
export function disposeCanvasTextures(root: THREE.Object3D | null): void {
  if (!root) return
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
    const mats = Array.isArray(mat) ? mat : mat ? [mat] : []
    for (const m of mats) {
      const std = m as THREE.Material & { map?: THREE.Texture | null }
      if (std.map && std.map.image instanceof HTMLCanvasElement) std.map.dispose()
      m.dispose()
    }
  })
}

/** 释放单个设备节点的实例资源(状态环 + 运行弧 + LED 环 + 名牌) */
export function disposeDeviceAssets(dev: DeviceNode): void {
  dev.ring.geometry.dispose()
  const rmat = dev.ring.material as THREE.Material & { map?: THREE.Texture | null }
  rmat.dispose()
  if (dev.arc) {
    dev.arc.geometry.dispose()
    ;(dev.arc.material as THREE.Material).dispose()
  }
  disposeCanvasTextures(dev.label)
}

/** 释放单个 agent 的实例资源(名牌/气泡纹理 + 光环 + 活动范围线几何;GLB 克隆不动) */
export function disposeAgentAssets(a: { nameSprite?: THREE.Sprite | null, bubble?: THREE.Sprite | null, rangeLine?: THREE.Line | null, aura?: THREE.Group | null }): void {
  disposeCanvasTextures(a.nameSprite ?? null)
  disposeCanvasTextures(a.bubble ?? null)
  a.rangeLine?.geometry.dispose()
  if (a.aura) {
    a.aura.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) {
        m.geometry.dispose()
        ;(m.material as THREE.Material).dispose()
      }
    })
    a.aura = null
  }
}

/** 重置全部(rebuild 用) */
export function resetAll(host: LifecycleHost): void {
  for (const a of host.agents.values()) {
    host.scene.remove(a.root)
    if (a.nameSprite) host.scene.remove(a.nameSprite)
    if (a.bubble) host.scene.remove(a.bubble)
    if (a.rangeLine) host.scene.remove(a.rangeLine)
    disposeAgentAssets(a)
  }
  for (const b of host.blocks.values()) {
    host.scene.remove(b.platform)
    host.scene.remove(b.padRing)
    host.scene.remove(b.beacon)
    host.scene.remove(b.boundary)
    host.scene.remove(b.label)
    disposeCanvasTextures(b.label)
  }
  for (const dev of host.deviceNodes.values()) {
    host.scene.remove(dev.root)
    host.scene.remove(dev.label)
    disposeDeviceAssets(dev)
  }
  host.deviceNodes.clear()
  host.scalables.clear()
  host.receivers.clear()
  host.pointerDrag = null
  host.cancelRangeDraw()
  host.selected = null
  host.selectedChannel = null
  for (const hl of host.resizeHandles) hl.mesh.visible = false
  for (const hl of host.agentRangeHandles) hl.mesh.visible = false
  host.agents.clear()
  host.blocks.clear()
}

/** 销毁(卸载时由 TownView 调用) */
export function dispose(host: LifecycleHost): void {
  host.disposed = true
  cancelAnimationFrame(host.raf)
  delete (globalThis as { __townScene3d?: unknown }).__townScene3d
  for (const t of host.pendingSaveTimers.values()) clearTimeout(t)
  host.pendingSaveTimers.clear()
  host.receivers.clear()
  host.resizeOb?.disconnect()
  host.resizeOb = null
  host.tControls?.dispose()
  host.tControls = null
  host.composer?.dispose()
  host.renderer.dispose()
  if (host.renderer.domElement.parentElement === host.el) host.renderer.domElement.remove()
}
