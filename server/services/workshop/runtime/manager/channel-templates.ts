/**
 * ManagerChannelTemplates —— Channel 模板与一键实例化
 * (拆分层,承 ManagerTeams)
 */
import { ManagerTeams } from './teams'
import type { ActingUser, ChannelTemplateDetail } from './types'
import type { ChannelTemplateMember, ChannelTemplateRepo } from '../../db/channel-template.repo'
import type { ChannelTemplateRow } from '../../db/database'
import type { ChannelMode } from '../../channel-mode'
import { AppError } from '../../../../utils/errors'
import { KNOWN_HARNESSES } from './helpers'
import { parseJson } from '../../db/database'
import { setHybridChannelProfile } from '../../aml/twin/channel-profile'
import { defaultInjectionScene } from '../../aml/twin/physics-runtime'
import { getChannelPluginsRepo } from '../../db/channel-plugins.repo'
import { KNOWLEDGE_BASE_PROMPT_SECTION, KNOWLEDGE_BASE_TEMPLATE_IDS } from './channel-template-constants'
import { createAgentPrefabService, parseAgentPrefabBinding, validateBindingSlots } from '../../agent-prefabs/service'
// 常量本体已下沉到纯模块(避免单测 import 触发 nitro #imports);此处保持原导出面不变
export { KNOWLEDGE_BASE_PROMPT_SECTION, KNOWLEDGE_BASE_TEMPLATE_IDS } from './channel-template-constants'

export abstract class ManagerChannelTemplates extends ManagerTeams {
  /**
   * Validate a persisted binding before it crosses a template visibility boundary.
   * Public templates may only carry public Prefabs; private templates additionally
   * require the importing user to own the Prefab (unless they are an admin).
   */
  private validateTemplatePrefabBinding(raw: string | undefined, templateVisibility: string, user: ActingUser): void {
    if (!raw || !raw.trim()) return
    let binding
    try {
      binding = parseAgentPrefabBinding(raw)
    }
    catch {
      throw new AppError(403, 'PREFAB_FORBIDDEN', 'Channel 模板包含非法 AgentPrefab 绑定')
    }
    if (!binding) return
    const service = createAgentPrefabService(this.deps.db)
    const loaded = service.loadRevision(binding.prefabId, binding.revision)
    if (!loaded || loaded.revision.contentHash !== binding.contentHash) {
      throw new AppError(403, 'PREFAB_FORBIDDEN', 'Channel 模板包含失效或篡改的 AgentPrefab revision')
    }
    if (templateVisibility === 'public' && loaded.row.visibility !== 'public') {
      throw new AppError(403, 'PREFAB_FORBIDDEN', '公开 Channel 模板不能携带私有 AgentPrefab')
    }
    if (loaded.row.visibility !== 'public' && loaded.row.ownerUserId !== user.id && user.role !== 'admin') {
      throw new AppError(403, 'PREFAB_FORBIDDEN', '当前用户无权转移该 AgentPrefab')
    }
    if (loaded.row.archivedAt) {
      throw new AppError(409, 'PREFAB_ARCHIVED', 'Channel 模板引用了已归档的 AgentPrefab，请先更新模板绑定')
    }
    validateBindingSlots(loaded.draft, binding.slotValues, true)
  }

  private validateTemplatePrefabBindings(
    lead: { prefabBindingJson?: string } | null | undefined,
    members: ChannelTemplateMember[],
    templateVisibility: string,
    user: ActingUser,
  ): void {
    this.validateTemplatePrefabBinding(lead?.prefabBindingJson, templateVisibility, user)
    for (const member of members) {
      this.validateTemplatePrefabBinding(
        'templateId' in member ? member.prefabBindingJson : member.inline.prefabBindingJson,
        templateVisibility,
        user,
      )
    }
  }

  /** 可见性感知 Channel 模板列表:普通用户 = 本人 + public(含内置);admin = 全量 */
  listChannelTemplatesVisibleTo(user: ActingUser): ChannelTemplateDetail[] {
    const rows = user.role === 'admin'
      ? this.deps.repos.channelTemplates.list()
      : this.deps.repos.channelTemplates.listVisible(user.id)
    return rows.map(row => this.channelTemplateDetailOf(row))
  }

  /** Channel 模板详情;不存在返回 undefined */
  getChannelTemplate(templateId: string): ChannelTemplateDetail | undefined {
    const row = this.deps.repos.channelTemplates.findById(templateId)
    if (!row) return undefined
    return this.channelTemplateDetailOf(row)
  }

  /** 创建 Channel 模板 */
  createChannelTemplate(input: {
    name: string
    description?: string
    scenarioPrompt?: string
    workspace?: string
    lead?: { name: string, harness: string, config?: Record<string, unknown> } | null
    members?: ChannelTemplateMember[]
    visibility?: string
    ownerUserId: string
  }): ChannelTemplateDetail {
    this.assertHarness(input.lead?.harness)
    const row = this.deps.repos.channelTemplates.create({
      name: input.name,
      description: input.description,
      scenarioPrompt: input.scenarioPrompt,
      workspace: input.workspace,
      lead: input.lead ?? null,
      members: input.members ?? [],
      visibility: input.visibility,
      ownerUserId: input.ownerUserId,
    })
    return this.channelTemplateDetailOf(row)
  }

  /** 从既有 Channel 实例捕获模板:场景 + 工作目录 + lead(内联)+ 成员(有模板引用则引用,否则内联快照) */
  createChannelTemplateFromChannel(channelId: string, input: { name: string, description?: string, visibility?: string }, ownerUserId: string): ChannelTemplateDetail {
    const channel = this.requireChannelRow(channelId)
    const members = this.deps.repos.channelAgents.listByChannel(channelId)
      .filter(m => m.id !== channel.leadAgentId)
      .map((m): ChannelTemplateMember => m.templateId
        ? { templateId: m.templateId, role: m.role === 'lead' ? 'lead' : 'worker', prefabBindingJson: m.prefabBindingJson ?? '' }
        : { inline: { name: m.name, harness: m.harness, config: parseJson<Record<string, unknown>>(m.configJson, {}), prefabBindingJson: m.prefabBindingJson ?? '' }, role: m.role === 'lead' ? 'lead' : 'worker' })
    const leadInst = channel.leadAgentId
      ? this.deps.repos.channelAgents.findById(channel.leadAgentId)
      : undefined
    const lead = leadInst
      ? {
          name: leadInst.name,
          harness: leadInst.harness,
          config: parseJson<Record<string, unknown>>(leadInst.configJson, {}),
          prefabBindingJson: leadInst.prefabBindingJson ?? '',
        }
      : null
    const visibility = input.visibility ?? 'private'
    this.validateTemplatePrefabBindings(lead, members, visibility, { id: ownerUserId })
    const row = this.deps.repos.channelTemplates.create({
      name: input.name,
      description: input.description,
      scenarioPrompt: channel.scenarioPrompt,
      workspace: channel.workspace,
      lead,
      members,
      visibility,
      ownerUserId,
    })
    return this.channelTemplateDetailOf(row)
  }

  /** 更新 Channel 模板(属主/admin;内置拒绝) */
  updateChannelTemplate(templateId: string, patch: Parameters<ChannelTemplateRepo['update']>[1]): ChannelTemplateDetail {
    const current = this.deps.repos.channelTemplates.findById(templateId)
    if (!current) throw new AppError(404, 'NOT_FOUND', `Channel 模板不存在: ${templateId}`)
    const nextVisibility = patch.visibility ?? current.visibility
    const nextLead: { prefabBindingJson?: string } | null = patch.lead !== undefined
      ? patch.lead
      : (current.leadJson ? parseJson<{ prefabBindingJson?: string }>(current.leadJson, {}) : null)
    const nextMembers = patch.members ?? parseJson<ChannelTemplateMember[]>(current.membersJson, [])
    this.validateTemplatePrefabBindings(nextLead, nextMembers, nextVisibility, { id: current.ownerUserId ?? '' })
    const updated = this.deps.repos.channelTemplates.update(templateId, patch)
    if (!updated) throw new AppError(404, 'NOT_FOUND', `Channel 模板不存在: ${templateId}`)
    return this.channelTemplateDetailOf(updated)
  }

  /** 删除 Channel 模板(属主/admin;内置拒绝) */
  removeChannelTemplate(templateId: string): void {
    this.deps.repos.channelTemplates.remove(templateId)
  }

  /**
   * 实例化 Channel 模板 → 新 channel(属主 = 操作用户):
   * 场景/工作目录照搬;lead 内联创建;成员逐个克隆(引用模板时校验操作者可读)。
   * 返回 createChannel 同构结果 + 成员实例数。
   */
  async instantiateChannelTemplate(templateId: string, user: ActingUser, nameOverride?: string, options?: { channelMode?: ChannelMode, scenarioPrompt?: string, scene?: Record<string, unknown>, promptVariables?: Record<string, unknown>, objective?: Record<string, unknown>, toolProfile?: string, controlPolicy?: 'recommendation_only' | 'hitl_governed' | 'bounded_auto', providerId?: string, providerVersion?: string, providerHash?: string, scenePackId?: string, optimizationMode?: 'exploration' | 'aml', boundModelId?: string, enableKnowledgeBase?: boolean }): Promise<{ channelId: string, workspace: string, agentCount: number, leadAgentId?: string, agents: Array<{ id: string, templateId?: string | null, name: string, role: string }> }> {
    const tpl = this.deps.repos.channelTemplates.findById(templateId)
    if (!tpl) throw new AppError(404, 'NOT_FOUND', `Channel 模板不存在: ${templateId}`)
    this.requireTemplateReadable(tpl, user, 'Channel 模板')
    const lead = tpl.leadJson
      ? parseJson<{ name: string, harness: string, config?: Record<string, unknown>, prefabBindingJson?: string } | null>(tpl.leadJson, null)
      : null
    // 知识库集成:显式 true → 启用 rag-bridge 并在场景提示词追加 KB 作业段;
    // 显式 false → 显式停用(频道内 kb_* 工具不注入);缺省 → 不写开关行(平台默认)。
    const kb = options?.enableKnowledgeBase
    const kbOn = kb === true
    const baseScenarioPrompt = kbOn && KNOWLEDGE_BASE_TEMPLATE_IDS.has(tpl.id)
      ? (tpl.scenarioPrompt ?? '') + KNOWLEDGE_BASE_PROMPT_SECTION
      : tpl.scenarioPrompt
    // 工况上下文在创建时一次写入,避免创建后 PATCH 触发 lead 运行时重装(seed task 滞留根因之一)。
    const extraScenarioPrompt = String(options?.scenarioPrompt ?? '').trim()
    const scenarioPrompt = extraScenarioPrompt
      ? `${baseScenarioPrompt ?? ''}${baseScenarioPrompt ? '\n\n' : ''}${extraScenarioPrompt}`
      : baseScenarioPrompt
    const members = parseJson<ChannelTemplateMember[]>(tpl.membersJson, [])
    this.validateTemplatePrefabBindings(lead, members, tpl.ownerUserId === null ? 'public' : tpl.visibility, user)
    const created = await this.createChannel({
      name: (nameOverride && nameOverride.trim()) || tpl.name,
      channelMode: options?.channelMode ?? 'generic',
      description: tpl.description,
      scenarioPrompt,
      workspace: tpl.workspace || undefined,
      leadAgent: lead ? { name: lead.name, harness: lead.harness, config: lead.config, prefabBindingJson: lead.prefabBindingJson } : undefined,
      ownerUserId: user.id,
      actor: user,
    })
    if (kb !== undefined) {
      getChannelPluginsRepo().setMany(created.channelId, [{ name: 'rag-bridge', enabled: kbOn }])
    }
    const agents: Array<{ id: string, templateId?: string | null, name: string, role: string }> = []
    if (created.leadAgentId) agents.push({ id: created.leadAgentId, name: lead?.name ?? 'lead', role: 'lead' })
    let agentCount = lead ? 1 : 0
    for (const m of members) {
      if ('templateId' in m) {
        const tplRow = this.deps.repos.agents.findById(m.templateId)
        if (!tplRow) throw new AppError(404, 'NOT_FOUND', `成员 Agent 模板不存在: ${m.templateId}`)
        this.requireTemplateReadable(tplRow, user, '成员 Agent 模板')
        const inst = await this.addAgentToChannel({ channelId: created.channelId, agentId: m.templateId, role: m.role, by: 'template', actor: user, prefabBindingJson: m.prefabBindingJson })
        agents.push({ id: inst.id, templateId: inst.templateId, name: inst.name, role: inst.role })
      }
      else {
        this.assertHarness(m.inline.harness)
        const inlineTpl = await this.createAgent({ name: m.inline.name, harness: m.inline.harness, config: m.inline.config, ownerUserId: user.id })
        const inst = await this.addAgentToChannel({ channelId: created.channelId, agentId: inlineTpl.id, role: m.role, by: 'template', actor: user, prefabBindingJson: m.inline.prefabBindingJson })
        agents.push({ id: inst.id, templateId: inst.templateId, name: inst.name, role: inst.role })
      }
      agentCount += 1
    }
    const hybrid = options?.toolProfile === 'hybrid_twin' || tpl.id === 'chtpl-hybrid-twin-mpc-default'
    if (hybrid) {
      const scene = options?.scene ?? (defaultInjectionScene('channel-template') as unknown as Record<string, unknown>)
      await Promise.resolve(setHybridChannelProfile({ channelId: created.channelId, profile: 'hybrid_twin', capability: { twin: true, amlTraining: true, trial: true, mpcRecommendation: true, explorationWrite: true, phase: 'exploration', controlMode: 'safe_small_step' }, sceneId: String(scene.sceneId ?? 'injection-hold-control'), sceneVersion: String(scene.sceneVersion ?? '1.0.0'), sceneContract: scene, objective: options?.objective ?? {}, controlPolicy: options?.controlPolicy ?? 'recommendation_only', providerId: options?.providerId ?? String((scene as Record<string, unknown>).physicsProfileId ?? 'injection-greybox-v1'), providerVersion: options?.providerVersion ?? '1.0.0', providerHash: options?.providerHash, scenePackId: options?.scenePackId ?? String(scene.sceneId ?? 'injection-hold-control'), createdBy: user.id }))
    }
    // AML 解耦模板:训练通道 / 工艺优化通道(实例化时可带 scene/objective/optimizationMode/boundModelId)
    const trainingProfile = options?.toolProfile === 'aml_training' || tpl.id === 'chtpl-aml-training-default'
    const optimizationProfile = options?.toolProfile === 'aml_optimization' || tpl.id === 'chtpl-aml-optimization-default'
    if (trainingProfile || optimizationProfile) {
      const scene = options?.scene ?? (defaultInjectionScene('channel-template') as unknown as Record<string, unknown>)
      const sceneId = String(scene.sceneId ?? 'injection-hold-control')
      const sceneVersion = String(scene.sceneVersion ?? '1.0.0')
      const mode = optimizationProfile ? (options?.optimizationMode === 'aml' ? 'aml' : 'exploration') : undefined
      await Promise.resolve(setHybridChannelProfile({
        channelId: created.channelId,
        profile: trainingProfile ? 'aml_training' : 'aml_optimization',
        capability: trainingProfile
          ? { datasets: true, training: true, evaluation: true, plans: true, phase: 'training' }
          : { exploration: true, modelBinding: mode === 'aml', trial: mode === 'aml', mpcRecommendation: mode === 'aml', bayes: mode === 'aml', phase: mode === 'aml' ? 'model_backed' : 'exploration' },
        sceneId, sceneVersion, sceneContract: scene,
        objective: options?.objective ?? {},
        controlPolicy: options?.controlPolicy ?? 'recommendation_only',
        providerId: options?.providerId ?? String((scene as Record<string, unknown>).physicsProfileId ?? 'injection-greybox-v1'),
        providerVersion: options?.providerVersion ?? '1.0.0',
        providerHash: options?.providerHash,
        scenePackId: options?.scenePackId ?? sceneId,
        optimizationMode: mode,
        boundModelId: options?.boundModelId,
        boundAt: options?.boundModelId ? new Date().toISOString() : undefined,
        createdBy: user.id,
      }))
    }
    // 产线 Co-Pilot 观察面模板(2026-10-01 计划 §5.2/§5.3):经验工程师 / 诊断工程师 —— 零写只读档位。
    // 档位落频道 profile(工具面由 host-tool-bridge/catalog 按档位白名单装配,物理零写);
    // controlPolicy 强制 recommendation_only(观察面只建议不下发,P2 引入下发族时再放开)。
    const expMinerProfile = options?.toolProfile === 'exp-miner' || tpl.id === 'chtpl-exp-miner-default'
    const lineDoctorProfile = options?.toolProfile === 'line-doctor' || tpl.id === 'chtpl-line-doctor-default'
    if (expMinerProfile || lineDoctorProfile) {
      await Promise.resolve(setHybridChannelProfile({
        channelId: created.channelId,
        profile: expMinerProfile ? 'exp-miner' : 'line-doctor',
        capability: { observer: true, knowledgeBase: true, phase: expMinerProfile ? 'experience_mining' : 'diagnosis' },
        objective: options?.objective ?? {},
        controlPolicy: 'recommendation_only',
        providerId: options?.providerId,
        providerVersion: options?.providerVersion,
        providerHash: options?.providerHash,
        scenePackId: options?.scenePackId,
        createdBy: user.id,
      }))
    }
    return { channelId: created.channelId, workspace: created.workspace, agentCount, leadAgentId: created.leadAgentId, agents }
  }

  protected assertHarness(harness: string | undefined): void {
    if (harness && !KNOWN_HARNESSES.has(harness)) {
      throw new AppError(400, 'BAD_REQUEST', `未知 harness: ${harness}`)
    }
  }

  protected channelTemplateDetailOf(row: ChannelTemplateRow): ChannelTemplateDetail {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      scenarioPrompt: row.scenarioPrompt,
      workspace: row.workspace,
      lead: row.leadJson ? parseJson<ChannelTemplateDetail['lead']>(row.leadJson, null) : null,
      members: parseJson<ChannelTemplateMember[]>(row.membersJson, []),
      visibility: row.ownerUserId === null ? 'public' : row.visibility,
      isBuiltin: row.ownerUserId === null,
      ownerUserId: row.ownerUserId ?? null,
      knowledgeBaseCapable: KNOWLEDGE_BASE_TEMPLATE_IDS.has(row.id),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  // ===== 任务作业面 =====
}
