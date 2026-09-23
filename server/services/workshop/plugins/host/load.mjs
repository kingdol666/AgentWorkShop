/**
 * 单个插件的装载与校验(配置事件中继 + 主装载流程)
 * (由 server/services/workshop/plugins/host.mjs 按职责拆出;内容逐行原文搬运)
 */
import { createPluginContext, validatePluginGroups, validatePluginModule, validatePluginSettings } from '@/sdk/index.mjs'
import { discoverPluginDirs, readDisabledSet } from './state.mjs'
import { loadPermissions, modePaths, pathToUrl, permissionsOf, pluginI18nPath, userRepositoryOf } from './config.mjs'
import { join, resolve } from 'node:path'
import { rollbackPartialLoad, selfOriginRef, syncPluginSettings } from './rollback.mjs'
import { seedRuntimeServices, servicesExt } from './services.mjs'

export function relayConfigEvents(host) {
  if (host.configRelayOff) return
  void import('@/server/services/system-config')
    .then(({ getSystemConfigService }) => {
      host.configRelayOff = getSystemConfigService().subscribe((payload) => {
        host.bus.emit('config:changed', {
          type: payload.type,
          changed: payload.changed ?? [],
          effective: payload.effective,
          sources: payload.sources,
        })
      })
    })
    .catch(err => host.logger.warn('设置变更转发到插件总线失败(插件收不到 config:changed):', err?.message ?? err))
}

/** 装载/重载全部插件(跳过 disabled;manifest 仍可见) */
export async function loadAllPlugins(host, { config, paths }) {
  const homeDir = modePaths(host.cwd).homeDir
  const disabled = readDisabledSet(homeDir)
  host.disabledSet = disabled
  host.lastDisabledSnapshot = new Set(disabled) // 重装载竞态检测基线(见 reloadPluginHost)

  // 产线权限服务(ctx.permissions 注入用;失败降级)
  await loadPermissions()
  await seedRuntimeServices()

  const entries = discoverPluginDirs(host.cwd)
  if (entries.length) host.logger.info(`发现 ${entries.length} 个插件(停用 ${disabled.size}),开始装载 ...`)

  for (const { dir, scope } of entries) {
    const entry = join(dir, 'index.mjs')
    // 提到 try 外:catch 回滚需要知道插件名(def 在 try 内声明时 catch 不可见)
    let def = null
    try {
      // cache-busting:热重载时 ESM 按 URL 缓存,不带 query 永远拿到旧模块(插件改代码不生效)
      const mod = await import(`${pathToUrl(entry)}?t=${Date.now()}`)
      const check = validatePluginModule(mod, entry)
      if (!check.ok) throw new Error(check.error)
      def = check.def

      if (host.plugins.has(def.name)) throw new Error(`插件重名(后装载者跳过): ${def.name}`)
      if (disabled.has(def.name)) {
        host.plugins.set(def.name, {
          name: def.name,
          version: String(def.version ?? '0.0.0'),
          description: String(def.description ?? ''),
          auth: String(def.auth ?? 'none'),
          scope,
          dir,
          entry,
          clientPath: def.client ? resolve(dir, def.client) : null,
          i18nPath: pluginI18nPath(dir),
          settings: [],
          groups: [],
          routes: [],
          enabled: false,
          error: null,
        })
        host.logger.info(`⊘ 跳过(已停用) [${scope}] ${def.name}`)
        continue
      }

      // 插件设置声明 → 平台设置描述符(key 编址 plugins.<name>.<key>;校验失败仅告警跳过条目)
      const settingsCheck = validatePluginSettings(def.name, def.settings)
      for (const e of settingsCheck.errors) host.logger.warn(`[${def.name}] 设置声明已跳过: ${e}`)
      // 插件配置分组声明(manifest.configGroups;setup 里还可经 ctx.config.defineGroup 动态增加)
      const groupsCheck = validatePluginGroups(def.name, def.configGroups ?? [])

      const rec = {
        name: def.name,
        version: String(def.version ?? '0.0.0'),
        description: String(def.description ?? ''),
        auth: String(def.auth ?? 'none'),
        scope,
        dir,
        entry,
        clientPath: def.client ? resolve(dir, def.client) : null,
        i18nPath: pluginI18nPath(dir),
        settings: settingsCheck.descriptors,
        /** 本插件声明的配置分组(独占命名空间;卸载时随插件一起摘除) */
        groups: groupsCheck.groups,
        routes: [],
        enabled: true,
        error: null,
      }
      for (const e of groupsCheck.errors) host.logger.warn(`[${def.name}] 分组声明已跳过: ${e}`)

      const emitter = {
        /** @returns {boolean} 注册结果(SDK 契约 `ctx.route(...) → boolean`,勿丢返回值) */
        registerRoute: (n, m, p, h) => {
          const ok = host.routes.register(n, m, p, h)
          if (ok) rec.routes.push({ method: String(m).toUpperCase(), path: p })
          return ok
        },
      }
      const perPluginDisposables = []
      const hookOffs = []
      host.disposables.set(def.name, perPluginDisposables)
      host.hookOffs.set(def.name, hookOffs)
      const scopedHooks = {
        on: (t, fn) => {
          const off = host.bus.on(t, fn)
          hookOffs.push(off)
          return off
        },
        once: (t, fn) => {
          const off = host.bus.once(t, fn)
          hookOffs.push(off)
          return off
        },
        off: (t, fn) => host.bus.off(t, fn),
        emit: (t, p) => host.bus.emit(t, p),
      }
      const ctx = createPluginContext({
        name: def.name,
        scope,
        dir,
        hooks: scopedHooks,
        logger: {
          debug: (...a) => host.logger.info(`[${def.name}][debug]`, ...a),
          info: (...a) => host.logger.info(`[${def.name}]`, ...a),
          warn: (...a) => host.logger.warn(`[${def.name}]`, ...a),
          error: (...a) => host.logger.error(`[${def.name}]`, ...a),
        },
        config,
        paths,
        emitter,
        onDispose: (fn) => {
          perPluginDisposables.push(fn)
          return fn
        },
        selfOrigin: () => selfOriginRef(host),
        // 插件配置分组/字段注册面(SDK ctx.config.defineGroup / defineField):
        // 插件可在 setup 里按条件增加自己的配置分区与字段,登记后立即回流设置页。
        registerGroup: (g) => {
          const chk = validatePluginGroups(def.name, [g])
          // validatePluginGroups 返回 { groups, errors }(无 ok 字段)——只认 groups 长度
          if (!chk.groups.length) {
            for (const e of chk.errors) host.logger.warn(`[${def.name}] ctx.config.defineGroup 失败: ${e}`)
            return null
          }
          const group = chk.groups[0]
          rec.groups = [...rec.groups.filter(x => x.id !== group.id), group]
          void syncPluginSettings()
          return group
        },
        registerField: (decl) => {
          const chk = validatePluginSettings(def.name, [decl])
          if (!chk.descriptors.length) {
            for (const e of chk.errors) host.logger.warn(`[${def.name}] ctx.config.defineField 失败: ${e}`)
            return null
          }
          const d = chk.descriptors[0]
          rec.settings = [...rec.settings.filter(x => x.key !== d.key), d]
          void syncPluginSettings()
          return d
        },
        removeGroup: (id) => {
          const before = rec.groups.length
          rec.groups = rec.groups.filter(x => x.id !== String(id))
          if (rec.groups.length !== before) void syncPluginSettings()
          return rec.groups.length !== before
        },
        removeField: (key) => {
          const full = `plugins.${def.name}.${String(key)}`
          const before = rec.settings.length
          rec.settings = rec.settings.filter(x => x.key !== full)
          if (rec.settings.length !== before) void syncPluginSettings()
          return rec.settings.length !== before
        },
        groups: () => rec.groups,
        fields: () => rec.settings,
        // 产线权限拓展面(SDK ctx.permissions):插件可查询/管理用户×产线授权
        permissions: {
          lineMode: (user, lineId) => permissionsOf().lineMode(user, lineId),
          visibleLineIds: user => permissionsOf().visibleLineIds(user),
          listGrants: userId => userRepositoryOf().listGrants(userId),
          setGrants: (userId, entries, grantedBy = 'plugin') => {
            for (const g of (entries ?? [])) {
              if (!g?.lineId) continue
              userRepositoryOf().setGrant(userId, String(g.lineId), (g.mode ?? null), grantedBy)
            }
            permissionsOf().notifyGrantsChanged(userId)
            return userRepositoryOf().listGrants(userId)
          },
        },
      })
      // DAQ 扩展面(v2 帧管线):插件注册自定义驱动与下沉处理器。
      // 桥经 globalThis 排队 —— daq 模块晚于插件宿主装载时,注册项先排队、
      // daq 侧 plugin-bridge 接管后回放;重复装载由同名覆盖语义兜底。
      const daqExt = (globalThis.__daqPluginExt ??= {
        pendingDrivers: [],
        pendingProcessors: [],
        pendingTemplates: [],
        registerDriver(d) {
          this.pendingDrivers.push(d)
          this._drain?.()
        },
        registerProcessor(kind, name, fn) {
          this.pendingProcessors.push({ kind, name, fn })
          this._drain?.()
        },
        registerTemplate(def) {
          this.pendingTemplates.push(def)
          this._drain?.()
        },
        drain(onDriver, onProcessor, onTemplate) {
          this._drain = () => {
            for (const d of this.pendingDrivers.splice(0)) onDriver(d)
            for (const p of this.pendingProcessors.splice(0)) onProcessor(p.kind, p.name, p.fn)
            for (const t of this.pendingTemplates.splice(0)) onTemplate(t)
          }
          this._drain()
        },
      })
      ctx.daq = {
        registerDriver: d => daqExt.registerDriver(d),
        registerProcessor: (kind, name, fn) => daqExt.registerProcessor(kind, name, fn),
        /** 注册数采节点模板(signalKind/sink.processors/metrics 全量可用;同名覆盖) */
        registerTemplate: def => daqExt.registerTemplate(def),
        /** 帧消费便捷别名(= hooks.on('daq:frame') / hooks.on('daq:sample')) */
        onFrame: fn => scopedHooks.on('daq:frame', fn),
        onSample: fn => scopedHooks.on('daq:sample', fn),
        /** 时序查询直通(queryTagged):插件免鉴权拉取产线/节点窗口样本(bucket/raw),诊断取数用 */
        query: async (q) => {
          const m = await import('@/server/services/workshop/daq/storage/index')
          return m.getTsdb().queryTagged(q)
        },
        /** 数采节点元数据快照(含产线归属,插件定位某产线的全部节点) */
        nodes: async () => {
          const m = await import('@/server/services/workshop/daq/daq-node.repo')
          return m.getDaqNodeRepo().snapshot()
        },
      }
      // DCW 写驱动扩展面:与 daq.registerDriver 对称(排队桥 globalThis.__dcwPluginExt,
      // dcw-controller 侧 plugin-bridge 接管回放)。写驱动契约见 server/services/workshop/dcw/drivers.ts。
      const dcwExt = (globalThis.__dcwPluginExt ??= {
        pendingDrivers: [],
        registerWriteDriver(d) {
          this.pendingDrivers.push(d)
          this._drain?.()
        },
        drain(onDriver) {
          this._drain = () => {
            for (const d of this.pendingDrivers.splice(0)) onDriver(d)
          }
          this._drain()
        },
      })
      ctx.dcw = {
        registerWriteDriver: d => dcwExt.registerWriteDriver(d),
      }
      // OMP 工具扩展面:插件注册自定义 host 工具 → omp 会话运行时热注入
      const ompExt = (globalThis.__ompPluginToolsBridge ??= {
        pending: [],
        register(plugin, tool) {
          this.pending.push({ plugin, tool })
          this._drain?.()
        },
        drain(onTool) {
          this._drain = () => {
            for (const def of this.pending.splice(0)) onTool(def)
          }
          this._drain()
        },
      })
      ctx.omp = {
        registerTool: (tool) => {
          ompExt.register(def.name, tool)
          ctx.logger.info(`已注册 omp 工具:「${tool?.name}」`)
        },
      }
      // 后端运行时对象面:ctx.services.get('daq'|'lines'|'channels'|'plugins') /
      // ctx.services.provide(name, getter) 跨插件供服务(自动 <plugin>. 前缀)
      ctx.services = {
        names: () => servicesExt.names(),
        get: name => servicesExt.get(name),
        provide: (name, get) => servicesExt.provide(def.name, name, get),
      }

      // 先 setup 再注册路由:反过来会在 setup 抛错时留下"路由活着、host.plugins 无记录"的幽灵路由,
      // 而 doReload 的清退以 host.plugins.keys() 为准 → 该插件的 omp 工具与路由永久泄漏(不可回收)。
      await def.setup?.(ctx)
      for (const r of (Array.isArray(def.routes) ? def.routes : [])) {
        emitter.registerRoute(def.name, r.method ?? 'GET', r.path, r.handler)
      }

      host.plugins.set(def.name, rec)
      host.logger.info(`✔ 已装载 [${scope}] ${def.name}@${rec.version}${rec.clientPath ? ' (+client)' : ''}`)
    }
    catch (err) {
      // setup/注册失败:逐项回滚已产生的半注册状态,保证"要么完整装载,要么完全无痕"
      rollbackPartialLoad(host, def?.name)
      host.failures.push({ source: entry, error: err?.message ?? String(err) })
      host.logger.error(`装载失败 ${entry}:`, err?.message ?? err)
    }
  }

  host.initedAt = new Date().toISOString()
  await host.bus.emit('plugin:host:init', { plugins: [...host.plugins.keys()], failures: host.failures.length })
  host.logger.info(`装载完成: ${host.plugins.size} 个(含停用)/ ${host.failures.length} 失败 / 活跃路由 ${host.routes.size} 条`)
}

/**
 * 回滚一次失败的插件装载 —— 保证「要么完整装载,要么完全无痕」。
 * 覆盖 setup 抛错 / 路由注册抛错两条路径:路由、disposables、hookOffs、omp 待注入工具、服务注册
 * 全部按插件名回收,避免出现「路由活着但 host.plugins 无记录」的幽灵态
 * (doReload 以 host.plugins.keys() 为清退依据,漏掉即永久泄漏)。
 */
