import {
  ADAPTER_ID,
  ADAPTER_VERSION,
  API_VERSION,
  DEFAULT_SCOPE_MAX_AGE_MS,
  LIFECYCLE_STATE_KEY,
  PERSISTENCE_STATE_KEY,
  PLUGIN_CONFIG,
  PLUGIN_NAME,
  REQUIRED_SCOPE_KEYS,
  SCOPE_STATE_KEY,
  adapterDescriptor,
  evaluateBetaScope,
  evaluateCapability,
  publicFlags,
  readBetaFlags,
  requestedScopeFromEvent,
  resolveAdapterRuntime,
} from './scope.mjs'

const statusPath = '/status'
const healthPath = '/health'
const scopePath = '/scope'
const adapterPath = '/adapter'
const metadataPath = '/metadata'
const researchPath = '/research'
const researchRunPath = '/research/run'
const researchCancelPath = '/research/cancel'
const evidencePath = '/evidence'
const RESEARCH_STATE_KEY = 'rsi.beta.research.state'
const RESEARCH_STATE_VERSION = 1
const READ_CAPABILITIES = new Set(['discover', 'snapshot', 'observe', 'query'])

const BETA_PROVENANCE = Object.freeze({
  context: Object.freeze({
    contract: 'context.v1',
    source: 'shared/context/contracts.ts',
    description: 'ContextSubject, DomainObject, Attribute, MaterialAssignment, and ContextSnapshot contracts',
  }),
  research: Object.freeze({
    contract: 'research-run.v1',
    source: 'server/services/workshop/research/contracts.ts',
    description: 'Bounded research requests, plans, runs, budgets, and candidate verdicts',
  }),
  evidence: Object.freeze({
    contract: 'EvidenceEnvelope',
    source: 'server/services/workshop/evidence/normalizer.ts',
    description: 'Immutable candidate evidence with source, revision, payload hash, scope, and freshness provenance',
  }),
})

const BETA_LIMITATIONS = Object.freeze([
  'Read-only diagnostics and bounded candidate research only; no domain operation is exposed here.',
  'Actuation, approval, promotion, and profile activation are outside the Beta boundary.',
  'Candidate evidence is not validated control authority and cannot be promoted by this plugin.',
  'A request without the exact active worker scope is denied; no implicit scope inheritance is used.',
])

function noOpLogger() {}

function safeCall(fn, fallback) {
  try {
    return fn()
  }
  catch {
    return fallback
  }
}

function bodyOf(event) {
  const body = event?.awBody ?? event?.body
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {}
}

function scopeOf(event, body = bodyOf(event)) {
  if (body.scope && typeof body.scope === 'object' && !Array.isArray(body.scope)) return body.scope
  return requestedScopeFromEvent(event)
}

function sameRequiredScope(left, right) {
  return REQUIRED_SCOPE_KEYS.every(key => String(left?.[key] ?? '') === String(right?.[key] ?? ''))
}

function readPersistence(ctx) {
  try {
    if (typeof ctx?.kv?.get !== 'function' || typeof ctx?.kv?.all !== 'function') {
      return { ok: false, code: 'PERSISTENCE_UNAVAILABLE', reason: 'ctx.kv is incomplete' }
    }
    const all = ctx.kv.all()
    if (!all || typeof all !== 'object' || Array.isArray(all)) {
      return { ok: false, code: 'PERSISTENCE_UNAVAILABLE', reason: 'ctx.kv did not return a state object' }
    }
    const marker = ctx.kv.get(PERSISTENCE_STATE_KEY)
    if (marker && typeof marker === 'object' && marker.ok === false) {
      return { ok: false, code: 'PERSISTENCE_UNAVAILABLE', reason: 'persisted state is marked unavailable' }
    }
    return { ok: true, scope: ctx.kv.get(SCOPE_STATE_KEY), marker: marker ?? null }
  }
  catch (error) {
    return { ok: false, code: 'PERSISTENCE_UNAVAILABLE', reason: error?.message ?? 'ctx.kv read failed' }
  }
}

function publicPersistence(persistence) {
  if (!persistence?.ok) return { ok: false, code: persistence?.code ?? 'PERSISTENCE_UNAVAILABLE' }
  return { ok: true }
}

function publicAdapterStatus(status) {
  return {
    ok: status?.ok === true,
    code: status?.ok === true ? 'REGISTERED' : (status?.code ?? 'ADAPTER_UNAVAILABLE'),
    service: status?.service ?? null,
  }
}

/**
 * P1 capability 真相(2026-11-14):对外可见能力 = 注册 adapter 实况 ∩ ALLOWED,
 * 不再照抄静态 descriptor(adapter 支持 snapshot;observe/simulate/replay/verify
 * 未实现即不展示)。registry 不可用时回退 descriptor(保守:只列总是可判定的键)。
 */
function advertisedCapabilities(state) {
  const base = adapterDescriptor.capabilities
  try {
    const summaries = typeof state.runtime?.registry?.list === 'function'
      ? state.runtime.registry.list()
      : []
    const mine = summaries.find(item => item?.adapterId === ADAPTER_ID)
      ?? summaries.find(item => item?.ownerId === PLUGIN_NAME)
    if (!mine || typeof mine.capabilities !== 'object') return [...base]
    const truth = base.filter(capability => mine.capabilities[capability] === true)
    return truth.length ? truth : [...base]
  }
  catch {
    return [...base]
  }
}

function publicMetadata(state, event) {
  const flags = readBetaFlags()
  const persistence = state.persistenceReady ? readPersistence(state.ctx) : { ok: false, code: 'PERSISTENCE_UNAVAILABLE' }
  const persistedScope = persistence.ok && persistence.scope && typeof persistence.scope === 'object' ? persistence.scope : null
  const principal = event?.awUser ?? event?.context?.awUser ?? event?.request?.principal ?? null
  const runtimeScope = persistedScope && state.runtime?.authorizeScope?.({
    principal,
    scope: persistedScope,
  })
  const scopeResult = flags.globallyEnabled && persistence.ok && persistedScope && runtimeScope?.ok
    ? evaluateBetaScope({ flags, persistence, requested: persistedScope, persisted: persistedScope, maxAgeMs: state.maxAgeMs })
    : { ok: false, code: flags.globallyEnabled ? (persistence.ok ? (runtimeScope?.code ?? 'SCOPE_FORBIDDEN') : persistence.code) : 'BETA_DISABLED' }
  const adapter = publicAdapterStatus(state.adapterStatus)
  const scoped = scopeResult.ok
  const ready = scoped && adapter.ok
  const caps = advertisedCapabilities(state)
  return {
    apiVersion: API_VERSION,
    plugin: PLUGIN_NAME,
    status: ready ? 'ready' : scoped ? 'degraded' : 'default-deny',
    available: ready,
    visible: scoped,
    code: ready ? 'READY' : (flags.hardDenied ? 'BETA_HARD_DENY' : scopeResult.code ?? adapter.code),
    flags: publicFlags(flags),
    requiredFlags: ['AW_RSI_BETA_ENABLED', 'AW_RSI_BETA_RESEARCH_ENABLED', 'AW_RSI_BETA_UI_ENABLED'],
    requiredScope: [...REQUIRED_SCOPE_KEYS],
    scopeState: scoped ? 'bound' : 'denied',
    scopeCode: scoped ? 'SCOPE_BOUND' : scopeResult.code,
    scope: scoped ? scopeResult.scope : null,
    persistence: publicPersistence(persistence),
    adapter: {
      ...adapter,
      health: adapter.ok ? 'healthy' : 'unavailable',
      capabilities: caps,
    },
    capabilities: caps,
    research: {
      wired: Boolean(state.research),
      persisted: state.researchPersistenceReady === true,
      candidateOnly: true,
    },
    readOnly: true,
    actuation: false,
    promotion: false,
    provenance: BETA_PROVENANCE,
    limitations: [...BETA_LIMITATIONS],
  }
}

function persistLifecycle(ctx, state) {
  try {
    if (typeof ctx?.kv?.set !== 'function') return false
    ctx.kv.set(LIFECYCLE_STATE_KEY, state)
    return true
  }
  catch {
    return false
  }
}

function persistResearchState(state) {
  if (!state.research || typeof state.ctx?.kv?.set !== 'function' || typeof state.ctx?.kv?.get !== 'function') return false
  try {
    const serialized = state.research.orchestrator.serialize()
    const value = {
      version: RESEARCH_STATE_VERSION,
      runs: serialized.runs,
      idempotency: serialized.idempotency,
      candidates: state.research.candidates.serialize(),
    }
    state.ctx.kv.set(RESEARCH_STATE_KEY, value)
    const stored = state.ctx.kv.get(RESEARCH_STATE_KEY)
    if (!stored || stored.version !== RESEARCH_STATE_VERSION || !Array.isArray(stored.runs) || !Array.isArray(stored.candidates)) return false
    return true
  }
  catch (error) {
    state.logger.warn(`research persistence failed: ${error?.message ?? error}`)
    return false
  }
}

function restoreResearchState(state) {
  if (!state.research || typeof state.ctx?.kv?.get !== 'function') return false
  try {
    const raw = state.ctx.kv.get(RESEARCH_STATE_KEY)
    if (raw === undefined || raw === null) return true
    if (!raw || raw.version !== RESEARCH_STATE_VERSION || !Array.isArray(raw.runs) || !Array.isArray(raw.candidates)) return false
    state.research.candidates.restore(raw.candidates)
    state.research.orchestrator.restore({ runs: raw.runs, idempotency: raw.idempotency ?? {} })
    return true
  }
  catch (error) {
    state.logger.warn(`research restore failed: ${error?.message ?? error}`)
    return false
  }
}

/**
 * P0 授权语义修订(2026-11-14):授权事实源自宿主持久记录
 * (runtime.resolveScopeBinding:workspace 挂载 + channel 启用 + worker 启用/角色
 * + principal 归属/成员关系)。插件 kv 的 rsi.beta.scope 不再是授权前提,
 * 只在存在时作为**附加收窄约束**(foreign/stale/disabled 仍拒)——
 * 真实部署无需手工预置 kv 即可工作,且既有 kv 约束语义不放宽。
 */
function authorizeScopeBinding(state, event, requested, capability) {
  const flags = readBetaFlags()
  // kv 可用性仍是硬前提(研究状态/生命周期落盘依赖它):读失败即 default-deny,
  // 不降级为「仅宿主推导」—— 防止持久层故障时的静默放行。
  const persistence = state.persistenceReady ? readPersistence(state.ctx) : { ok: false, code: 'PERSISTENCE_UNAVAILABLE', reason: 'plugin state persistence failed' }
  if (!persistence.ok) {
    return {
      ok: false,
      response: {
        apiVersion: API_VERSION,
        plugin: PLUGIN_NAME,
        ok: false,
        available: false,
        code: persistence.code ?? 'PERSISTENCE_UNAVAILABLE',
        reason: 'Beta scope persistence is unavailable',
        capability: capability ?? null,
        flags: publicFlags(flags),
        persistence: publicPersistence(persistence),
        adapter: publicAdapterStatus(state.adapterStatus),
      },
    }
  }
  const principal = event?.awUser ?? event?.context?.awUser ?? null
  const binding = state.runtime?.resolveScopeBinding?.({ principal, scope: requested })
  if (!binding?.ok) {
    return {
      ok: false,
      response: {
        apiVersion: API_VERSION,
        plugin: PLUGIN_NAME,
        ok: false,
        available: false,
        code: flags.globallyEnabled ? 'SCOPE_FORBIDDEN' : (flags.hardDenied ? 'BETA_HARD_DENY' : 'BETA_DISABLED'),
        reason: flags.globallyEnabled ? 'requested Beta scope is not authorized against host records' : 'Beta flags are not explicitly enabled',
        capability: capability ?? null,
        flags: publicFlags(flags),
        persistence: publicPersistence(persistence),
        adapter: publicAdapterStatus(state.adapterStatus),
      },
    }
  }
  // kv scope 条目是**可选附加约束**:存在即相交校验(foreign/stale/disabled 仍拒);
  // 不存在(未 provision)时宿主推导单独授权 —— 真实部署不再被空 kv 卡死。
  const persistedScope = persistence.scope && typeof persistence.scope === 'object' ? persistence.scope : null
  if (persistedScope) {
    const exact = evaluateBetaScope({
      flags,
      persistence,
      requested: binding.scope,
      persisted: persistedScope,
      capability,
      maxAgeMs: state.maxAgeMs,
    })
    if (!exact.ok) {
      return {
        ok: false,
        response: {
          apiVersion: API_VERSION,
          plugin: PLUGIN_NAME,
          ok: false,
          available: false,
          code: exact.code ?? 'SCOPE_FORBIDDEN',
          reason: exact.reason ?? 'Beta scope provisioning constraint not satisfied',
          capability: capability ?? null,
          flags: publicFlags(flags),
          persistence: publicPersistence(persistence),
          adapter: publicAdapterStatus(state.adapterStatus),
        },
      }
    }
  }
  const capabilityResult = evaluateCapability({ flags, capability })
  if (!capabilityResult.ok) {
    return {
      ok: false,
      response: {
        apiVersion: API_VERSION,
        plugin: PLUGIN_NAME,
        ok: false,
        available: false,
        code: capabilityResult.code,
        reason: capabilityResult.reason,
        capability: capability ?? null,
        flags: publicFlags(flags),
        persistence: publicPersistence(persistence),
        adapter: publicAdapterStatus(state.adapterStatus),
      },
    }
  }
  return { ok: true, scope: binding.scope, binding, persistence }
}

function routeResult(state, event, capability) {
  const authorized = authorizeScopeBinding(state, event, requestedScopeFromEvent(event), capability)
  if (!authorized.ok) return authorized.response
  const { binding } = authorized
  return {
    apiVersion: API_VERSION,
    plugin: PLUGIN_NAME,
    ok: true,
    available: true,
    code: 'READY',
    capability: capability ?? null,
    scope: binding.scope,
    flags: publicFlags(readBetaFlags()),
    persistence: publicPersistence(authorized.persistence),
    adapter: publicAdapterStatus(state.adapterStatus),
  }
}

function researchError(error) {
  return {
    ok: false,
    available: false,
    code: error?.code ?? 'RESEARCH_FAILURE',
    reason: error?.message ?? String(error),
    candidateOnly: true,
    actuation: false,
    promotion: false,
  }
}

function authorizeResearch(state, event, body) {
  const requested = scopeOf(event, body)
  const authorized = authorizeScopeBinding(state, event, requested, 'query')
  if (!authorized.ok) return { ok: false, response: authorized.response }
  // 研究状态仍需 kv 持久化可用(run/candidate 断电续跑契约)
  if (!state.research || state.researchPersistenceReady !== true) return { ok: false, response: researchError({ code: 'PERSISTENCE_UNAVAILABLE', message: 'research persistence is unavailable' }) }
  return { ok: true, scope: authorized.scope }
}

function scopeRun(run, scope) {
  return sameRequiredScope(run?.scope, scope)
}

function ensureReadPlan(plan) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.steps)) return null
  if (plan.steps.some(step => !READ_CAPABILITIES.has(String(step?.capability ?? '').toLowerCase()))) {
    return researchError({ code: 'RESEARCH_READ_ONLY_FORBIDDEN', message: 'research routes accept read capabilities only' })
  }
  return null
}

export default {
  name: PLUGIN_NAME,
  version: ADAPTER_VERSION,
  description: 'Default-deny, read-only RSI Beta adapter/plugin interface',
  apiVersion: API_VERSION,
  auth: 'user',
  client: './client.mjs',
  clientFlags: ['AW_RSI_BETA_UI_ENABLED'],
  config: PLUGIN_CONFIG,
  settings: [
    {
      key: 'scope_max_age_ms',
      type: 'number',
      default: DEFAULT_SCOPE_MAX_AGE_MS,
      min: 1,
      max: 86_400_000,
      label: 'Beta scope maximum age (ms)',
      description: 'Stale scope state is denied; this setting never widens scope.',
    },
  ],
  async setup(ctx) {
    const logger = ctx?.logger ?? { info: noOpLogger, warn: noOpLogger, error: noOpLogger }
    const state = {
      ctx,
      logger,
      flags: readBetaFlags(),
      maxAgeMs: Number(ctx?.config?.get?.(`plugins.${PLUGIN_NAME}.scope_max_age_ms`)) || DEFAULT_SCOPE_MAX_AGE_MS,
      adapterStatus: { ok: false, code: 'BETA_DISABLED' },
      persistenceReady: false,
      researchPersistenceReady: false,
      runtime: null,
      research: null,
    }

    const initialFlags = state.flags
    const initialPersistence = readPersistence(ctx)
    state.persistenceReady = initialPersistence.ok
    if (!initialPersistence.ok) logger.warn(`persistence unavailable; Beta remains default-deny: ${initialPersistence.reason}`)

    // Feature-off is a true no-op: no routes, lifecycle markers, provider, or client panel.
    if (!initialFlags.globallyEnabled) return

    if (initialFlags.globallyEnabled && initialPersistence.ok) {
      const runtimeResult = await resolveAdapterRuntime(ctx)
      state.runtime = runtimeResult.runtime
      if (!state.runtime) {
        state.adapterStatus = { ok: false, code: runtimeResult.reason }
      }
      else {
        const industrial = typeof state.runtime.createIndustrialReadAdapter === 'function'
          ? state.runtime.createIndustrialReadAdapter({ adapterId: ADAPTER_ID, version: ADAPTER_VERSION, ownerId: PLUGIN_NAME })
          : null
        const registry = state.runtime.registry
        if (industrial && registry && typeof state.runtime.registerOne === 'function') {
          try {
            const registration = state.runtime.registerOne(industrial, PLUGIN_NAME)
            state.adapterStatus = { ok: true, service: 'context.runtime', registration }
            state.research = await (async () => {
              const [{ LocalResearchOrchestrator }, { CandidateEvidenceStore }] = await Promise.all([
                import('@/server/services/workshop/research/orchestrator'),
                import('@/server/services/workshop/evidence/candidate-store'),
              ])
              const candidates = new CandidateEvidenceStore()
              const orchestrator = new LocalResearchOrchestrator(registry, candidates)
              return { orchestrator, candidates }
            })()
            state.researchPersistenceReady = restoreResearchState(state)
            // P1 生命周期(2026-11-14):dispose 不再自行注销 adapter ——
            // 热重载期间先卸后装曾留下"路由可见但 adapter 已死"的窗口;
            // 现在交给宿主:重载后按 ownerId 清理不再活跃插件的注册(见 reload.mjs)。
          }
          catch (error) {
            logger.warn(`adapter registration failed: ${error?.message ?? error}`)
            state.adapterStatus = { ok: false, code: 'ADAPTER_REGISTRATION_FAILED' }
          }
        }
        else {
          state.adapterStatus = { ok: false, code: 'ADAPTER_RUNTIME_UNSUPPORTED' }
        }
      }
    }

    ctx.onDispose(() => {
      state.adapterStatus = { ok: false, code: 'DISPOSED' }
    })

    const statusHandler = event => routeResult(state, event, null)
    const healthHandler = event => routeResult(state, event, 'observe')
    const scopeHandler = event => routeResult(state, event, 'query')
    const metadataHandler = event => publicMetadata(state, event)
    const adapterHandler = event => ({
      ...routeResult(state, event, null),
      adapterDescriptor,
      requiredScope: REQUIRED_SCOPE_KEYS,
      registered: state.adapterStatus.ok === true,
      readOnly: true,
      actuation: false,
      promotion: false,
    })

    ctx.route('GET', statusPath, statusHandler)
    ctx.route('GET', healthPath, healthHandler)
    ctx.route('GET', scopePath, scopeHandler)
    ctx.route('GET', metadataPath, metadataHandler)
    ctx.route('GET', adapterPath, adapterHandler)

    const listResearch = (event) => {
      const body = bodyOf(event)
      const authorized = authorizeResearch(state, event, body)
      if (!authorized.ok) return authorized.response
      try {
        const id = event?.query?.id ?? body.id
        // P1 oracle 修复:显式请求 foreign run id 必须显式 SCOPE_FORBIDDEN,
        // 不再返回 ok:true + 空列表(空列表仅用于无 id 的范围列表查询)。
        const runs = id ? [state.research.orchestrator.get(String(id))] : state.research.orchestrator.list()
        const matched = runs.filter(run => scopeRun(run, authorized.scope))
        if (id && matched.length === 0) {
          auditDenial(state, event, 'research.list.denied', 'run outside the exact active worker scope')
          return researchError({ code: 'SCOPE_FORBIDDEN', message: 'research run is outside the exact active worker scope' })
        }
        return {
          ok: true,
          available: true,
          scope: authorized.scope,
          runs: matched,
          candidateOnly: true,
          actuation: false,
          promotion: false,
        }
      }
      catch (error) {
        return researchError(error)
      }
    }

    /** 拒绝审计(隐私安全:只记 actor/scope/capability/原因,不带业务载荷) */
    function auditDenial(state, event, action, reason) {
      try {
        const principal = event?.awUser ?? event?.context?.awUser ?? null
        void import('@/server/services/workshop/ops/ops').then(({ recordOps }) => {
          recordOps({
            actor: principal?.id ?? 'unknown',
            actorName: principal?.name ?? '',
            actorKind: principal ? 'user' : 'system',
            action,
            kind: 'read',
            scope: 'system',
            targetKind: 'rsi_beta_research',
            summary: `RSI Beta 拒绝(${action}):${reason}`,
          })
        }).catch(() => { /* 审计不可用不改变拒绝语义 */ })
      }
      catch { /* 审计不可用不改变拒绝语义 */ }
    }

    const runResearch = async (event) => {
      const body = bodyOf(event)
      const authorized = authorizeResearch(state, event, body)
      if (!authorized.ok) return authorized.response
      const { plan, execute, ...request } = body
      request.scope = authorized.scope
      request.principal = event?.awUser ?? event?.context?.awUser ?? event?.request?.principal ?? null
      request.authorizationScope = {
        ...authorized.scope,
        ...(body.projection === 'industrial' || body.industrial === true ? { projection: 'industrial', industrial: true } : {}),
      }
      const planError = plan ? ensureReadPlan(plan) : null
      if (planError) return planError
      try {
        const created = state.research.orchestrator.create(request)
        let run = created.run
        if (plan) {
          run = state.research.orchestrator.plan(run.id, plan)
          run = state.research.orchestrator.approveRead(run.id)
        }
        if (execute === true) {
          run = await state.research.orchestrator.execute(run.id, {
            principal: request.principal,
            authorizationScope: request.authorizationScope,
          })
        }
        if (!persistResearchState(state)) return researchError({ code: 'PERSISTENCE_UNAVAILABLE', message: 'research state could not be persisted' })
        state.researchPersistenceReady = true
        return { ok: true, available: true, scope: authorized.scope, run, idempotent: created.idempotent, candidateOnly: true, actuation: false, promotion: false }
      }
      catch (error) {
        return researchError(error)
      }
    }

    const cancelResearch = (event) => {
      const body = bodyOf(event)
      const authorized = authorizeResearch(state, event, body)
      if (!authorized.ok) return authorized.response
      try {
        const current = state.research.orchestrator.get(String(body.id ?? ''))
        if (!current) {
          auditDenial(state, event, 'research.cancel.denied', 'run not found')
          return researchError({ code: 'SCOPE_FORBIDDEN', message: 'research run is outside the exact active worker scope' })
        }
        if (!scopeRun(current, authorized.scope)) {
          auditDenial(state, event, 'research.cancel.denied', 'run outside the exact active worker scope')
          return researchError({ code: 'SCOPE_FORBIDDEN', message: 'research run is outside the exact active worker scope' })
        }
        const run = state.research.orchestrator.cancel(current.id)
        if (!persistResearchState(state)) return researchError({ code: 'PERSISTENCE_UNAVAILABLE', message: 'research state could not be persisted' })
        return { ok: true, available: true, scope: authorized.scope, run, candidateOnly: true, actuation: false, promotion: false }
      }
      catch (error) {
        return researchError(error)
      }
    }

    const listEvidence = (event) => {
      const body = bodyOf(event)
      const authorized = authorizeResearch(state, event, body)
      if (!authorized.ok) return authorized.response
      try {
        const id = String(event?.query?.id ?? body.id ?? '')
        if (id) {
          // P1 oracle 修复:显式 foreign evidence id 显式 SCOPE_FORBIDDEN(可审计)
          let record
          try {
            record = state.research.candidates.require(id)
          }
          catch {
            record = null
          }
          if (!record || !sameRequiredScope(record.accessScope, authorized.scope)) {
            auditDenial(state, event, 'research.evidence.denied', 'evidence outside the exact active worker scope')
            return researchError({ code: 'SCOPE_FORBIDDEN', message: 'evidence is outside the exact active worker scope' })
          }
          return { ok: true, available: true, scope: authorized.scope, evidence: [record], candidateOnly: true, actuation: false, promotion: false }
        }
        // 范围列表:worker scope 精确匹配;请求携带 subjectRefs 时按交集收窄
        const requestedRefs = Array.isArray(body.subjectRefs) ? body.subjectRefs.map(v => String(v ?? '').trim()).filter(Boolean) : []
        const evidence = state.research.candidates.list().filter((value) => {
          if (!sameRequiredScope(value.accessScope, authorized.scope)) return false
          if (requestedRefs.length) {
            const owned = Array.isArray(value.accessScope?.subjectRefs) ? value.accessScope.subjectRefs.map(v => String(v ?? '')) : []
            if (!requestedRefs.some(ref => owned.includes(ref))) return false
          }
          return true
        })
        return { ok: true, available: true, scope: authorized.scope, evidence, candidateOnly: true, actuation: false, promotion: false }
      }
      catch (error) {
        return researchError(error)
      }
    }

    // These routes are registered only after the global feature gate passes.
    ctx.route('GET', researchPath, listResearch)
    ctx.route('POST', researchRunPath, runResearch)
    ctx.route('POST', researchCancelPath, cancelResearch)
    ctx.route('GET', evidencePath, listEvidence)

    safeCall(() => logger.info(`ready apiVersion=${API_VERSION} flags=enabled research=${state.research ? 'wired' : 'unavailable'}`), undefined)
    state.persistenceReady = persistLifecycle(ctx, { state: 'ready', apiVersion: API_VERSION, at: new Date().toISOString() })
  },
}
