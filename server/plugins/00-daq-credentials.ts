/**
 * 数采基础设施凭据引导(必须在任何配置解析之前跑)。
 *
 * Nitro 按文件名排序装载插件:`00-daq-credentials` < `00-local-time` < `system-config`,
 * 因此本插件写入的 `AW_DAQ_*` 环境变量会被 system-config 的 env 覆盖解析捕获。
 *
 * 凭据来源优先级(见 infra-credentials.ts):运维显式配置 > 本机凭据文件 >
 * 存量容器自省 > 随机生成。`daq.startInfrastructure=never`(隔离测试实例)
 * 跳过容器自省,避免每次冷启动多花 docker inspect 的时间。
 */
import { loadEffective, findUp, settingsPathFor } from '@/shared/config/engine.mjs'
import { loadOrCreateCredentials, publishCredentialsToEnv } from '@/server/services/workshop/daq/infra-credentials'
import { dirname } from 'node:path'

function startInfrastructurePolicy(): unknown {
  try {
    const configPath = findUp(process.cwd(), 'config.yml')
    const root = configPath ? dirname(configPath) : process.cwd()
    const eff = loadEffective({ configPath: configPath ?? undefined, settingsPath: settingsPathFor(root) }) as {
      effective: Record<string, unknown>
    }
    return eff.effective['daq.startInfrastructure']
  }
  catch {
    return 'auto'
  }
}

export default defineNitroPlugin(() => {
  const policy = startInfrastructurePolicy()
  const creds = loadOrCreateCredentials({ adopt: policy !== 'never' })
  publishCredentialsToEnv(creds)
})
