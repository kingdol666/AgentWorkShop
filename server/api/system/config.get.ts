import { defineApiHandler } from '../../utils/response'
import { useServerConfig } from '../../utils/config'

/**
 * GET /api/system/config —— 服务端配置视图
 * 与前端 useSiteConfig() 同源于 config.yml，用于验证「前后端配置一致性」。
 */
export default defineApiHandler(() => useServerConfig())
