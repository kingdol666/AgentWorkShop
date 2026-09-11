/**
 * 绑定面权限收敛 —— Agent↔工业节点绑定的**读取/改写**统一鉴权。
 *
 * 背景(审计实测):`POST /agent-tools/bindings` 有完整的产线权限闸门,
 * 但它的兄弟端点全都没有:
 *   - `PATCH /agent-tools/bindings/:id` 只 resolveUser → 任意登录用户可把**任意**
 *     绑定从 manual 改成 auto,即**摘掉人类审批闸门**(HITL 直接失效);
 *   - `DELETE /agent-tools/bindings/:id` 同理,还会 `cancelPendingFor` 取消受害者
 *     正在等待的审批(否决他人控制权);
 *   - `GET /agent-tools/bindings`(不带 agentId)返回**全量授权表** —— 既是越权读取,
 *     也是上面两条的枚举原语。
 * 这三件事叠加 = 一条完整的「探测 → 摘闸门 → 冒充执行」链路。
 *
 * 本模块把「用户能否支配这条绑定」判定收敛为单一入口,语义与 index.post.ts 对齐:
 *   - 绑定所属节点必须存在(否则 404 —— 悬空绑定不构成任何授权);
 *   - admin/editor 放行;
 *   - 普通用户:daq 需对该产线「仅查看」及以上,dcw(写向)需「可操控」;
 *   - 其余 → 403。
 *
 * 读与写共用同一判据:能读到别人的绑定本身就已越权(授权表是控制面数据,不是目录)。
 */
import type { AgentNodeBinding } from './node-bindings.repo'
import { getDaqController } from '../daq/daq-controller'
import { getDcwController } from '../dcw/dcw-controller'
import { lineMode } from '../permissions'
import { AppError, ErrorCodes } from '../../../utils/errors'

/** 绑定 → 所属产线 id(节点不存在返回 null) */
export function lineIdOfBinding(binding: Pick<AgentNodeBinding, 'nodeId' | 'kind'>): string | null | undefined {
  return binding.kind === 'daq'
    ? getDaqController().byId(binding.nodeId)?.lineId
    : getDcwController().byId(binding.nodeId)?.lineId
}

/**
 * 断言用户可支配该绑定(读或写)。不通过即抛 403;节点已消失则抛 404。
 * @param what 用于错误文案的资源名(如 '绑定')
 */
export function requireBindingAccess(
  user: { id: string, role: string },
  binding: Pick<AgentNodeBinding, 'id' | 'nodeId' | 'kind'>,
  what = '绑定',
): void {
  const lineId = lineIdOfBinding(binding)
  if (lineId === undefined || lineId === null) {
    // 悬空绑定:节点已删除。它不授予任何权限,也不该被任何人改写。
    throw new AppError(404, ErrorCodes.NOT_FOUND, `${what} ${binding.id} 指向的节点已不存在: ${binding.nodeId}`)
  }
  const mode = lineMode(user, lineId)
  const needOperate = binding.kind === 'dcw'
  if (mode === 'operate' || (needOperate === false && mode === 'readonly')) return
  const need = needOperate ? '可操控' : '仅查看'
  if (mode === 'readonly') {
    throw new AppError(403, 'LINE_READONLY', `该绑定涉及写控节点,需对产线「${lineId}」拥有${need}权限(当前:仅查看)`)
  }
  throw new AppError(403, 'LINE_FORBIDDEN', `无该产线权限:该绑定涉及产线「${lineId}」,需${need}及以上权限`)
}
