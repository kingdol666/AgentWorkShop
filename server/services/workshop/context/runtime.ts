import { createIndustrialReadAdapter } from './adapters/industrial-read'
import { ContextAdapterRegistry } from './registry'
import type { ContextAdapter, ContextAdapterRegistrationResult } from './contracts'
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
export type ContextRuntimeScope = { workspaceId?: string, channelId?: string, workerId?: string }
export type ContextRuntimeAuthorization
  = | { ok: true, scope: Required<ContextRuntimeScope> }
    | { ok: false, code: 'SCOPE_FORBIDDEN' }

export type ContextRuntimeRepositories = {
  users: UserRepo
  channels: ChannelRepo
  channelAgents: ChannelAgentRepo
  channelMembers?: ChannelMemberRepo
}

/** Host-owned context runtime and adapter lifecycle authority. */
export class ContextRuntimeService {
  readonly apiVersion = CONTEXT_RUNTIME_API_VERSION
  readonly registry: ContextAdapterRegistry
  private disposed = false
  private readonly repos?: ContextRuntimeRepositories

  constructor(options: { registry?: ContextAdapterRegistry, repos?: ContextRuntimeRepositories } = {}) {
    this.registry = options.registry ?? new ContextAdapterRegistry()
    this.repos = options.repos
  }

  registerOne(adapter: ContextAdapter, ownerId = adapter.owner.ownerId): ContextAdapterRegistrationResult {
    this.ensureOpen()
    if (!ownerId || adapter.owner.ownerId !== ownerId) throw new Error('context adapter owner does not match registering owner')
    return this.registry.registerOne(adapter)
  }

  createIndustrialReadAdapter(options: { adapterId?: string, version?: string, generation?: number, ownerId?: string } = {}): ContextAdapter {
    this.ensureOpen()
    return createIndustrialReadAdapter(options)
  }

  lineIdsForScope(scope?: ContextRuntimeScope | null): string[] {
    const normalized = this.normalizeScope(scope)
    if (!normalized) return []
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
        && worker?.role === 'worker'
        && this.lineIdsForScope(normalized).length > 0)
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

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.registry.dispose()
  }

  private normalizeScope(scope?: ContextRuntimeScope | null): Required<ContextRuntimeScope> | null {
    if (!scope?.workspaceId || !scope.channelId || !scope.workerId) return null
    return { workspaceId: String(scope.workspaceId), channelId: String(scope.channelId), workerId: String(scope.workerId) }
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

export function createContextRuntimeService(options: { registry?: ContextAdapterRegistry, repos?: ContextRuntimeRepositories } = {}): ContextRuntimeService {
  return new ContextRuntimeService(options)
}
