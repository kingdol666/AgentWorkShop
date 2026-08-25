/**
 * TownSceneMath 纯函数单测(node + tsx 直跑,无浏览器依赖)
 *
 * 覆盖:
 *  1. 边界几何:椭圆/矩形线框点、normLayout 下限钳制
 *  2. clampToBoundary:椭圆内钳/矩形内钳/旋转边界/内缩 margin
 *  3. pointInBoundary:内部命中/外部排除/旋转边界
 *  4. boundaryExtremePoints:矩形四角与椭圆轴向四点(旋转)
 *  5. clampRangeToLayout:中心钳入 + 半径收缩进边界
 *  6. clampToAgentRange:椭圆/矩形/旋转/已在内不位移
 *  7. distToRangeBoundary:矩形边距与椭圆近似
 *  8. 身份色:hashHue 稳定性 / channelColorCss 同源
 *  9. town-behavior:stepToward 到达判定 / parseActionFromEnvelope 任务投递语义
 */
import {
  ARRIVE, AGENT_SPEED,
  boundaryExtremePoints, boundaryPoints, bubbleDisplayMs, channelColorCss, channelColorNum,
  clampRangeToLayout, clampToAgentRange, clampToBoundary, distToRangeBoundary,
  hashHue, normLayout, pointInBoundary,
} from '../shared/town-scene-math'
import { parseActionFromEnvelope, stepToward } from '../shared/town-behavior'
import type { AepEnvelope } from '../shared/workshop-protocol'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}
const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps

const round = (v: { x: number, z: number } | null): { x: number, z: number } | null =>
  v ? { x: Math.round(v.x * 1e6) / 1e6, z: Math.round(v.z * 1e6) / 1e6 } : v

// ---- 1. 边界几何 ----
{
  const pts = boundaryPoints('ellipse', 100, 60, 48)
  check('ellipse points count', pts.length === 48)
  check('ellipse radius X', near(pts[0][0], 100, 1e-9), `x=${pts[0][0]}`)
  check('ellipse radius Z(90°)', near(pts[12][1], 60, 1e-6))
  const rect = boundaryPoints('rect', 200, 100, 48)
  check('rect points count', rect.length === 4)
  check('rect corners use radius as half extent', rect.some(([x, z]) => near(x, 200) && near(z, 100)) && rect.some(([x, z]) => near(x, -200) && near(z, -100)))
  const nl = normLayout({ channelId: 'c', x: 0, z: 0, radiusX: 10, radiusZ: 5, shape: 'ellipse', rotationY: 0 })
  check('normLayout floor radiusX=60', nl.radiusX === 60 && nl.radiusZ === 40)
}

// ---- 2. clampToBoundary ----
{
  const l = { channelId: 'c', x: 0, z: 0, radiusX: 100, radiusZ: 60, shape: 'ellipse', rotationY: 0 }
  check('ellipse inside unchanged', near(clampToBoundary(l, 20, 10).x, 20) && near(clampToBoundary(l, 20, 10).z, 10))
  check('ellipse outside pulled-in', (() => {
    const c = clampToBoundary(l, 1000, 0)
    return near(c.x, 100) && near(c.z, 0, 1e-9)
  })(), JSON.stringify(round(clampToBoundary(l, 1000, 0))))
  check('ellipse diagonal clamp inside unit circle', (() => {
    const c = clampToBoundary(l, 500, 300)
    const nx = c.x / 100
    const nz = c.z / 60
    return near(nx * nx + nz * nz, 1, 1e-4)
  })())
  const r = { channelId: 'c', x: 0, z: 0, radiusX: 200, radiusZ: 100, shape: 'rect', rotationY: 0 }
  check('rect clamp', near(clampToBoundary(r, 999, 999).x, 200) && near(clampToBoundary(r, 999, 999).z, 100))
  check('rect margin', near(clampToBoundary(r, 999, 0, 16).x, 200 - 16))
  const rot = { channelId: 'c', x: 0, z: 0, radiusX: 100, radiusZ: 60, shape: 'ellipse', rotationY: 90 }
  const rotated = clampToBoundary(rot, -500, 0)
  // 旋转 90°:椭圆短轴(Z=60)转到 X 轴 → 东侧最远 60
  check('rotated boundary clamp(90°)', near(Math.abs(rotated.x), 60, 1e-6) && near(rotated.z, 0, 1e-6), JSON.stringify(round(rotated)))
}

// ---- 3. pointInBoundary ----
{
  const l = { channelId: 'c', x: 100, z: 100, radiusX: 100, radiusZ: 60, shape: 'ellipse', rotationY: 0 }
  check('inside true', pointInBoundary(l, 160, 130))
  check('outside false', !pointInBoundary(l, 400, 100))
  check('on edge true', pointInBoundary(l, 200, 100))
  const rot = { channelId: 'c', x: 0, z: 0, radiusX: 100, radiusZ: 60, shape: 'ellipse', rotationY: 90 }
  check('rotated: point on east axis(now 60) inside', pointInBoundary(rot, 60, 0))
  // 旋转 90°:主轴(X=100)转到世界 Z 方向 → (0,60) 仍在内,(0,150) 越界在外
  check('rotated: point on world-Z 60 inside', pointInBoundary(rot, 0, 60))
  check('rotated: point beyond major axis outside', !pointInBoundary(rot, 0, 150))
  const r = { channelId: 'c', x: 0, z: 0, radiusX: 200, radiusZ: 100, shape: 'rect' as const, rotationY: 0 }
  check('rect edge uses full radius', pointInBoundary(r, 200, 100))
  check('rect beyond full radius excluded', !pointInBoundary(r, 201, 0))
}
// ---- 4. boundaryExtremePoints ----
{
  const l = { x: 100, z: 100, radiusX: 200, radiusZ: 100, shape: 'rect' as const, rotationY: 0 }
  const p = boundaryExtremePoints(l)
  check('rect 4 corners use half extents', p.length === 4 && p.every(([x, z]) => near(Math.abs(x - 100), 200) && near(Math.abs(z - 100), 100)))
  const e = boundaryExtremePoints({ x: 0, z: 0, radiusX: 100, radiusZ: 60, shape: 'ellipse' as const, rotationY: 90 })
  // 旋转 90°:轴向点互换
  check('ellipse rotated axial swap', e.some(([x]) => near(x, 60)) && e.some(([, z]) => near(z, 100)))
}

// ---- 5. clampRangeToLayout ----
{
  const l = { channelId: 'c', x: 0, z: 0, radiusX: 200, radiusZ: 120, shape: 'ellipse', rotationY: 0 }
  const big = clampRangeToLayout(l, { x: 0, z: 0, radiusX: 500, radiusZ: 300, shape: 'ellipse', rotationY: 0 })
  const extreme = boundaryExtremePoints(big)
  check('big range shrunk into layout', extreme.every(([x, z]) => pointInBoundary(l, x, z)), JSON.stringify(extreme))
  const offCenter = clampRangeToLayout(l, { x: 900, z: 0, radiusX: 100, radiusZ: 80, shape: 'ellipse', rotationY: 0 })
  check('off-center range center pulled in', near(offCenter.x, 200 - 20, 1e-6) && near(offCenter.z, 0, 1e-6))
}

// ---- 6. clampToAgentRange ----
{
  const r = { x: 0, z: 0, radiusX: 100, radiusZ: 60, shape: 'ellipse', rotationY: 0 }
  check('agent range inside unchanged', near(clampToAgentRange(r, 10, 5).x, 10))
  check('agent range east clamp', near(clampToAgentRange(r, 500, 0).x, 100))
  const rr = { x: 0, z: 0, radiusX: 100, radiusZ: 60, shape: 'rect', rotationY: 0 }
  check('agent range rect clamp', near(clampToAgentRange(rr, 500, 500).x, 100) && near(clampToAgentRange(rr, 500, 500).z, 60))
}

// ---- 7. distToRangeBoundary ----
{
  const rr = { x: 0, z: 0, radiusX: 100, radiusZ: 60, shape: 'rect', rotationY: 0 }
  check('rect boundary distance on edge ~0', distToRangeBoundary(rr, 100, 0) < 1e-6)
  check('rect inside distance to top', near(distToRangeBoundary(rr, 0, 50), 10, 1e-6))
  const e = { x: 0, z: 0, radiusX: 100, radiusZ: 60, shape: 'ellipse', rotationY: 0 }
  check('ellipse boundary distance ~0', distToRangeBoundary(e, 100, 0) < 0.5)
}

// ---- 8. 身份色 ----
{
  check('hashHue stable', hashHue('abc') === hashHue('abc'))
  check('hashHue differs for diff input', hashHue('a') !== hashHue('b'))
  check('channelColorCss matches hsl of hashHue', channelColorCss('c1') === `hsl(${Math.round(hashHue('c1'))}, 58%, 60%)`)
  const n1 = channelColorNum('c1')
  const n2 = channelColorNum('c1')
  check('channelColorNum stable', n1 === n2, `0x${n1.toString(16)}`)
  check('bubbleDisplayMs bounds', bubbleDisplayMs('') === 1400 && bubbleDisplayMs('x'.repeat(500)) === 3400)
}

// ---- 9. town-behavior ----
{
  const speed = AGENT_SPEED
  const dt = 1 / 60
  const far = 2000
  const s1 = stepToward({ x: 0, y: 0 }, { x: far, y: 0 }, speed, dt)
  check('stepToward moves speed·dt', near(s1.x, speed * dt, 1e-9) && !s1.arrived, `x=${s1.x}`)
  const s2 = stepToward({ x: 0, y: 0 }, { x: ARRIVE - 1, y: 0 }, speed, dt)
  check('stepToward arrives within ARRIVE', s2.arrived)
  const s3 = stepToward({ x: 10, y: 0 }, { x: 0, y: 0 }, speed, dt)
  check('stepToward direction left', s3.dir === 'left')
  const s4 = stepToward({ x: 0, y: 0 }, { x: 10, y: 0 }, speed, dt)
  check('stepToward direction right', s4.dir === 'right')
  const s5 = stepToward({ x: 5, y: 0 }, { x: 5, y: 0 }, speed, dt)
  check('stepToward same point arrived', s5.arrived && s5.dir === 'none')

  const taskEnv = {
    type: 'a2a.message',
    channelId: 'ch1',
    taskId: 't1',
    payload: {
      parts: [{ text: '修复样式' }],
      metadata: { 'x-aw-from-agent': 'lead-1', 'x-aw-task-kind': 'assign', 'x-aw-task-id': 't1' },
    },
  } as AepEnvelope
  const act = parseActionFromEnvelope(taskEnv, { resolveTaskAssignee: () => 'worker-1' })
  check('parse task assign → kind=task + requireReply', act !== null && act.kind === 'task' && act.requireReply, act ? `${act.kind}/${act.taskKind}` : 'null')
  check('parse task assign → toId via resolveTaskAssignee', act?.toId === 'worker-1')
  check('parse task assign → text fallback', act?.text === '修复样式' || act?.text === '下发任务')

  const noTarget = parseActionFromEnvelope({ type: 'a2a.message', channelId: 'ch1', payload: { parts: [], metadata: {} } } as AepEnvelope)
  check('no target → null', noTarget === null)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
if (failures > 0) process.exitCode = 1
