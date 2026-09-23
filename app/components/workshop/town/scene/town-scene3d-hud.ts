/**
 * AgentTeam RPG 小镇(Three.js 3D 表现层)— 调试 / HUD 数据面。
 *
 * 自 TownScene3D.ts 抽出:与 2D 场景同构的只读快照 ——
 *  - getDebugState:渲染态全量快照(浏览器/E2E 断言用);
 *  - getMinimapState:归一化(0~1)的领地/角色/设备/镜头坐标 + 色相,供 Vue HUD 渲染缩略图;
 *  - getRecentActivity:HUD 跑马灯数据。
 *
 * 宿主契约:场景类实现 HudHost(只列本模块触达的成员)。
 */
import { WORLD_H, WORLD_W } from '#shared/town-scene-math'
import type { Agent3D, Block3D, DeviceNode } from './town-scene3d-nodes'

/** HUD 数据模块的宿主契约(一项 = 本模块真正用到的字段/方法) */
export interface HudHost {
  readonly blocks: Map<string, Block3D>
  readonly agents: Map<string, Agent3D>
  readonly deviceNodes: Map<string, DeviceNode>
  /** 调试气泡(最近事件;仅取末 8 条) */
  readonly dbgBubbles: Array<{ text: string, at: number }>
  /** 最后一个气泡(去重去抖动) */
  readonly lastActivity: { channelId: string, agentName: string, text: string, at?: number } | null
  /** 最近活动队列(跑马灯) */
  readonly recentActivity: Array<{ channelId: string, agentName: string, text: string }>
  /** 相机(玩家/镜头坐标来源) */
  readonly camera: { position: { x: number, y: number, z: number } }
  /** 相机注视目标(小地图准星锚点) */
  readonly camTarget: { x: number, z: number }
}

export function getDebugState(host: HudHost): {
  blocks: number
  agents: Array<{ agentId: string, name: string, role: string, channelId: string, state: string, progress: number | null, x: number, y: number, visible: boolean, draggable: boolean, auraColor: number, behavior: string, targetId: string | null, homeX: number, homeY: number, textureKey: string, modelRef: string, decorated: boolean, range: { x: number, z: number, radiusX: number, radiusZ: number, shape: string } | null, bubbleText: string | null, anim: string }>
  bubbles: Array<{ text: string, at: number }>
  activity: { channelId: string, agentName: string, text: string } | null
  player: { x: number, y: number }
} {
  return {
    blocks: host.blocks.size,
    agents: [...host.agents.values()].map(a => ({
      agentId: a.agentId,
      name: a.name,
      role: a.role,
      channelId: a.channelId,
      state: a.state,
      progress: a.progress,
      x: Math.round(a.root.position.x),
      y: Math.round(a.root.position.z),
      visible: true,
      draggable: true,
      auraColor: a.colorNum,
      behavior: a.behavior.mode,
      targetId: a.behavior.targetId,
      homeX: Math.round(a.homeX),
      homeY: Math.round(a.homeZ),
      textureKey: a.textureKey,
      modelRef: a.modelRef,
      decorated: !a.channelId,
      range: a.range
        ? { x: Math.round(a.range.x), z: Math.round(a.range.z), radiusX: Math.round(a.range.radiusX), radiusZ: Math.round(a.range.radiusZ), shape: a.range.shape }
        : null,
      bubbleText: a.bubbleText,
      anim: a.animState,
    })),
    bubbles: host.dbgBubbles.slice(-8),
    activity: host.lastActivity,
    player: { x: Math.round(host.camera.position.x), y: Math.round(host.camera.position.z) },
  }
}

export function getMinimapState(host: HudHost): {
  world: { w: number, h: number }
  blocks: Array<{ x: number, y: number, color: number, name: string, shape?: 'ellipse' | 'rect', rx?: number, rz?: number, rot?: number }>
  agents: Array<{ x: number, y: number, color: number, busy: boolean }>
  devices: Array<{ x: number, y: number, color: number, state: string }>
  player: { x: number, y: number }
} {
  const stateColor = (state: 'idle' | 'running' | 'offline' | 'alarm'): number =>
    state === 'alarm' ? 0xff6b6b : state === 'offline' ? 0x8496a5 : state === 'running' ? 0x35e0a0 : 0xf6c453
  return {
    world: { w: WORLD_W, h: WORLD_H },
    // 领地含真实形状/半轴/朝向(归一化;镜头居中小地图按形状绘制)
    blocks: [...host.blocks.values()].map(b => ({
      x: b.x / WORLD_W,
      y: b.z / WORLD_H,
      color: b.color,
      name: b.name,
      shape: b.shape,
      rx: b.radiusX / WORLD_W,
      rz: b.radiusZ / WORLD_H,
      rot: b.rotationY,
    })),
    agents: [...host.agents.values()].map(a => ({ x: a.root.position.x / WORLD_W, y: a.root.position.z / WORLD_H, color: a.colorNum, busy: a.state === 'busy' })),
    devices: [...host.deviceNodes.values()].map(d => ({
      twinId: d.twinId,
      x: d.root.position.x / WORLD_W,
      y: d.root.position.z / WORLD_H,
      color: stateColor(d.state),
      state: d.state,
      daq: d.modelRef.startsWith('daq-') || d.modelRef.includes('daq'),
      bound: false,
    })),
    // 镜头 = camTarget(画面注视中心;小地图准星锚点)
    player: { x: host.camTarget.x / WORLD_W, y: host.camTarget.z / WORLD_H },
  }
}

export function getRecentActivity(host: HudHost): Array<{ channelId: string, agentName: string, text: string }> {
  return [...host.recentActivity]
}
