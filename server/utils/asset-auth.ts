/**
 * 资产类管理面守卫(2026-10-30 安全审计 P2-6)。
 *
 * 设备孪生(control/patch/delete)与 3D 模型上传此前只要求"已登录",
 * 任何 `user` 角色都能操控/删除平台设备、往 public/ 上传文件。
 * 这些是场景/资产的管理动作,收口到 editor 及以上(admin 越权放行)。
 */
import { AppError } from './errors'

export interface AssetActor { id: string, role: string }

export function assertAssetManager(user: AssetActor, what: string): void {
  if (user.role === 'admin' || user.role === 'editor') return
  throw new AppError(403, 'FORBIDDEN', `${what}需要编辑者(editor)或管理员(admin)权限`)
}
