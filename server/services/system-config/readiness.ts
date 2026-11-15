/**
 * 插件设置写入就绪闸门。
 *
 * 插件设置描述符是**装载期**注册进 SystemConfigService 的(key 为
 * `plugins.<name>.<key>`),而插件宿主在 Nitro 启动后异步装载。此前设置页/自动化
 * 在宿主就绪前 PATCH 会收到「未知设置项」,只能靠客户端轮询重试(实测启动竞态)。
 *
 * 本模块在服务端等待宿主初始化落定:
 *  - 非 plugins.* 键 → 立即放行;
 *  - 描述符已齐全 → 立即放行;
 *  - 宿主仍在装载 → 轮询至超时(pending,调用方返回 503 可重试);
 *  - 宿主已落定但键仍不存在 → unknown(交给设置服务给出精确的未知项错误)。
 */
export type PluginSettingsReadiness = 'not-plugin' | 'ready' | 'pending' | 'unknown'

export interface PluginSettingsWaitResult {
  status: PluginSettingsReadiness
  /** 等待后仍缺失的 plugins.* 键 */
  missing: string[]
}

export interface PluginSettingsWaitOptions {
  timeoutMs?: number
  pollMs?: number
}

/** 可注入依赖:生产用真实插件宿主/系统设置快照,测试用纯内存实现。 */
export interface PluginSettingsWaitDeps {
  /** 当前已注册的设置键(含全局与插件命名空间) */
  listRegisteredKeys: () => readonly string[] | Promise<readonly string[]>
  /** 插件宿主初始化是否已落定(成功或失败退出) */
  hostSettled: () => boolean
}

const PLUGIN_KEY_PREFIX = 'plugins.'

/** 从一批设置键中筛出插件命名空间键(纯函数,便于测试) */
export function pluginSettingKeys(keys: readonly string[]): string[] {
  return keys.filter(key => typeof key === 'string' && key.startsWith(PLUGIN_KEY_PREFIX))
}

async function defaultDeps(): Promise<PluginSettingsWaitDeps> {
  const [{ getPluginHost, pluginHostReady }, { getSystemConfigService }] = await Promise.all([
    import('../workshop/plugins/host.mjs'),
    import('../system-config'),
  ])
  return {
    listRegisteredKeys: () => getSystemConfigService().snapshot().descriptors.map(d => d.key),
    hostSettled: () => pluginHostReady() || Boolean(getPluginHost()?.initError),
  }
}

export async function awaitPluginSettings(
  keys: readonly string[],
  options: PluginSettingsWaitOptions = {},
  deps?: PluginSettingsWaitDeps,
): Promise<PluginSettingsWaitResult> {
  const pluginKeys = pluginSettingKeys(keys)
  if (pluginKeys.length === 0) return { status: 'not-plugin', missing: [] }

  const resolved = deps ?? await defaultDeps()
  const missingOf = async (registered: readonly string[]) => {
    const set = new Set(registered)
    return pluginKeys.filter(key => !set.has(key))
  }
  let missing = await missingOf(await resolved.listRegisteredKeys())
  if (missing.length === 0) return { status: 'ready', missing: [] }

  const timeoutMs = Math.max(0, options.timeoutMs ?? 15_000)
  const pollMs = Math.max(20, options.pollMs ?? 200)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (resolved.hostSettled()) {
      // 宿主已落定:缺失键是真正的未知项(拼写错误/插件未安装),不再空等。
      missing = await missingOf(await resolved.listRegisteredKeys())
      return { status: missing.length === 0 ? 'ready' : 'unknown', missing }
    }
    await new Promise(resolve => setTimeout(resolve, pollMs))
    missing = await missingOf(await resolved.listRegisteredKeys())
    if (missing.length === 0) return { status: 'ready', missing: [] }
  }
  missing = await missingOf(await resolved.listRegisteredKeys())
  return { status: missing.length === 0 ? 'ready' : 'pending', missing }
}
