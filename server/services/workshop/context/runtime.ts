import { createIndustrialReadAdapter } from './adapters/industrial-read'
import { ContextAdapterRegistry } from './registry'
import type {
  ContextAdapter,
  ContextAdapterAuthorizationContext,
  ContextAdapterAuthorizationInput,
  ContextAdapterAuthorizer,
  ContextAdapterRegistrationResult,
} from './contracts'
import type { ChannelMemberRepo } from '../db/channel-member.repo'
import type { UserRepo } from '../db/user.repo'
import type { ChannelRepo } from '../db/channel.repo'
import type { ChannelAgentRepo } from '../db/channel-agent.repo'
import { getAgentNodeBindingRepo } from '../agents/node-bindings.repo'
import { getDaqNodeRepo } from '../daq/daq-node.repo'
import { getDcwNodeRepo } from '../dcw/dcw-node.repo'
import { getDcwRecipeRepo } from '../dcw/dcw-recipe.repo'

export const CONTEXT_RUNTIME_API_VERSION = 'context-runtime.v1' as const

export type ContextRuntimePrincipal = { id: string, role?: string }
export type ContextRuntimeScope = {
  workspaceId?: string
  channelId?: string
  workerId?: string
  lineId?: string
  lineIds?: readonly string[]
  projection?: string
  industrial?: boolean
}
type NormalizedContextRuntimeScope = ContextRuntimeScope & { workspaceId: string, channelId: string, workerId: string }
export type ContextRuntimeAuthorization
  = | { ok: true, scope: NormalizedContextRuntimeScope }
    | { ok: false, code: 'SCOPE_FORBIDDEN' }

export type ContextRuntimeRepositories = {
  users: UserRepo
  channels: ChannelRepo
  channelAgents: ChannelAgentRepo
  channelMembers?: ChannelMemberRepo
}

type ContextRuntimeOptions = {
  registry?: ContextAdapterRegistry
  repos?: ContextRuntimeRepositories
  /** Test seam; production continues to resolve the persisted binding repo. */
  lineIdsForWorker?: (workerId: string) => readonly string[]
}

/** Host-owned context runtime and adapter lifecycle authority. */
export class ContextRuntimeService {
  readonly apiVersion = CONTEXT_RUNTIME_API_VERSION
  readonly registry: ContextAdapterRegistry
  private disposed = false
  private readonly repos?: ContextRuntimeRepositories
  private readonly lineIdsForWorker?: (workerId: string) => readonly string[]

  constructor(options: ContextRuntimeOptions = {}) {
    this.registry = options.registry ?? new ContextAdapterRegistry()
    this.repos = options.repos
    this.lineIdsForWorker = options.lineIdsForWorker
  }

  registerOne(adapter: ContextAdapter, ownerId = adapter.owner.ownerId): ContextAdapterRegistrationResult {
    this.ensureOpen()
    if (!ownerId || adapter.owner.ownerId !== ownerId) throw new Error('context adapter owner does not match registering owner')
    return this.registry.registerOne(adapter)
  }

  /** Build an industrial adapter with selectors owned by the adapter boundary. */
  createIndustrialReadAdapter(options: { adapterId?: string, version?: string, generation?: number, ownerId?: string } = {}): ContextAdapter {
    this.ensureOpen()
    const authorize: ContextAdapterAuthorizer = (input) => {
      const principal = input.principal
      const scope = input.scope
      if (!principal || !scope) return false
      return this.authorizeAdapterRequest({ ...input, principal, scope })
    }
    return createIndustrialReadAdapter({ ...options, authorize })
  }

  lineIdsForScope(scope?: ContextRuntimeScope | null): string[] {
    const normalized = this.normalizeScope(scope)
    if (!normalized) return []
    if (this.lineIdsForWorker) {
      try {
        return [...new Set(this.lineIdsForWorker(normalized.workerId).map(String).filter(Boolean))]
      }
      catch {
        return []
      }
    }
    try {
      const lineIds = new Set<string>()
      for (const binding of getAgentNodeBindingRepo().byAgent(normalized.workerId)) {
        if (binding.kind === 'line-recipe') {
          if (binding.nodeId) lineIds.add(binding.nodeId)
        }
        else if (binding.kind === 'recipe') {
          const lineId = getDcwRecipeRepo().byId(binding.nodeId)?.lineId
          if (lineId) lineIds.add(lineId)
        }
        else if (binding.kind === 'daq') {
          const lineId = getDaqNodeRepo().byId(binding.nodeId)?.lineId
          if (lineId) lineIds.add(lineId)
        }
        else if (binding.kind === 'dcw') {
          const lineId = getDcwNodeRepo().byId(binding.nodeId)?.lineId
          if (lineId) lineIds.add(lineId)
        }
      }
      return [...lineIds]
    }
    catch {
      return []
    }
  }

  /** Industrial selectors are adapter-owned; generic scope deployment only checks host bindings. */
  isDeployedScope(scope?: ContextRuntimeScope | null): boolean {
    const normalized = this.normalizeScope(scope)
    const repos = this.repos ?? this.resolveRepositories()
    if (!normalized || !repos) return false
    try {
      const workspace = repos.users.getWorkspace(normalized.workspaceId)
      const channel = repos.channels.findById(normalized.channelId)
      const worker = repos.channelAgents.findByChannelAgent(normalized.channelId, normalized.workerId)
      return Boolean(workspace
        && repos.users.listMountedChannels(workspace.id).includes(normalized.channelId)
        && channel?.enabled === 1
        && worker?.enabled !== 0
        && worker?.role === 'worker')
    }
    catch {
      return false
    }
  }

  /** All failures intentionally collapse to one public code to prevent scope probing. */
  authorizeScope(input: { principal?: ContextRuntimePrincipal | null, scope?: ContextRuntimeScope | null }): ContextRuntimeAuthorization {
    const scope = this.normalizeScope(input.scope)
    const principal = input.principal
    const repos = this.repos ?? this.resolveRepositories()
    if (!principal?.id || !scope || !repos || !this.isDeployedScope(scope)) return { ok: false, code: 'SCOPE_FORBIDDEN' }
    try {
      const workspace = repos.users.getWorkspace(scope.workspaceId)
      const channel = repos.channels.findById(scope.channelId)
      if (!workspace || !channel) return { ok: false, code: 'SCOPE_FORBIDDEN' }
      const admin = principal.role === 'admin'
      if (!admin && workspace.ownerUserId !== principal.id) return { ok: false, code: 'SCOPE_FORBIDDEN' }
      if (!admin && channel.ownerUserId !== principal.id && !repos.channelMembers?.isActiveMember(scope.channelId, principal.id)) return { ok: false, code: 'SCOPE_FORBIDDEN' }
      return { ok: true, scope }
    }
    catch {
      return { ok: false, code: 'SCOPE_FORBIDDEN' }
    }
  }

  /**
   * Build adapter authorization from the generic deployment scope. Industrial
   * bindings are derived here and exposed only as authorization output.
   */
  authorizeAdapterRequest(input: Omit<ContextAdapterAuthorizationInput, 'authorization'> & { principal: ContextRuntimePrincipal, scope: ContextRuntimeScope }): ContextAdapterAuthorizationContext | false {
    const decision = this.authorizeScope({ principal: input.principal, scope: input.scope })
    if (!decision.ok) return false
    const industrialScope = input.scope as ContextRuntimeScope
    const industrial = Boolean(industrialScope.lineId || industrialScope.lineIds?.length || industrialScope.projection === 'industrial' || industrialScope.industrial)
    const lineIds = this.lineIdsForScope(decision.scope)
    return {
      scope: decision.scope,
      principal: { id: input.principal.id, ...(input.principal.role ? { role: input.principal.role } : {}) },
      metadata: { boundLineIds: lineIds },
      industrial,
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.registry.dispose()
  }

  private normalizeScope(scope?: ContextRuntimeScope | null): NormalizedContextRuntimeScope | null {
    if (!scope || typeof scope !== 'object') return null
    if (!scope.workspaceId || !scope.channelId || !scope.workerId) return null
    return {
      workspaceId: String(scope.workspaceId),
      channelId: String(scope.channelId),
      workerId: String(scope.workerId),
    }
  }

  private resolveRepositories(): ContextRuntimeRepositories | null {
    try {
      const manager = (globalThis as typeof globalThis & { __workshopManager?: { deps?: { repos?: ContextRuntimeRepositories } } }).__workshopManager
      return manager?.deps?.repos ?? null
    }
    catch {
      return null
    }
  }

  private ensureOpen(): void {
    if (this.disposed) throw new Error('context runtime is disposed')
  }
}

export function createContextRuntimeService(options: ContextRuntimeOptions = {}): ContextRuntimeService {
  return new ContextRuntimeService(options)
}
