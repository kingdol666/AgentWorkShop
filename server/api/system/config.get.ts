/**
 * GET /api/system/config —— 服务端配置视图(业务信息:端口/分页等)。
 * 需用户 token(业务面统一鉴权;与前端 useSiteConfig() 同源于 config.yml,用于验证前后端配置一致性)。
 */
import { defineApiHandler } from '../../utils/response'
import { useServerConfig } from '../../utils/config'
import { resolveUser } from '../workshop/caller'

export default defineApiHandler((event) => {
  resolveUser(event)
  return useServerConfig()
})
