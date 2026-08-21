<script setup lang="ts">
/**
 * Channel 模板中心(v10):场景 + 工作目录 + 团队组合的可复用模板。
 * - 用户隔离:私有仅本人;公开全员可实例化(仅属主可改删);内置(锁)公开只读。
 * - 创建:手写组合(lead + 成员模板引用 + 场景 + 工作目录 + 可见性)。
 * - 实例化:一键按模板新建 Channel(成员自动装配);workspace 挂载入口见左侧会话栏。
 * - admin:全量视图(含他人私有),附创建者。
 */
import { message } from 'ant-design-vue'
import { useWorkshopApi, type ChannelTemplateDto, type AgentTemplateDto, type ChannelTemplateMemberDto } from '../../composables/workshop/useWorkshopApi'
import { useUserStore } from '../../stores/workshop/user'

definePageMeta({ layout: 'default' })

const api = useWorkshopApi()
const userStore = useUserStore()
const templates = ref<ChannelTemplateDto[]>([])
const agentTemplates = ref<AgentTemplateDto[]>([])
const loading = ref(false)

const load = async (): Promise<void> => {
  loading.value = true
  try {
    const [t, a] = await Promise.all([api.listChannelTemplates(), api.listTemplates()])
    templates.value = (t as unknown as { data?: ChannelTemplateDto[] })?.data ?? []
    agentTemplates.value = (a as unknown as { data?: AgentTemplateDto[] })?.data ?? []
  }
  finally {
    loading.value = false
  }
}
void load()

type Filter = 'all' | 'mine' | 'public' | 'builtin'
const filter = ref<Filter>('all')
const shown = computed(() => {
  const uid = userStore.user?.id
  switch (filter.value) {
    case 'mine': return templates.value.filter(t => t.ownerUserId === uid)
    case 'public': return templates.value.filter(t => t.visibility === 'public')
    case 'builtin': return templates.value.filter(t => t.isBuiltin)
    default: return templates.value
  }
})

const canWrite = (t: ChannelTemplateDto): boolean =>
  !t.isBuiltin && (t.ownerUserId === userStore.user?.id || userStore.isAdmin)

const visTag = (t: ChannelTemplateDto): { text: string, color: string, icon?: string } => {
  if (t.isBuiltin) return { text: '内置', color: 'default', icon: 'i-tabler-lock' }
  if (t.visibility === 'public') return { text: '公开', color: 'green' }
  return { text: '私有', color: 'default' }
}

/** 成员预览名(引用模板 → 当前名;内联 → 快照名) */
const memberLabel = (m: ChannelTemplateMemberDto): string =>
  'templateId' in m
    ? (agentTemplates.value.find(a => a.id === m.templateId)?.name ?? m.templateId.slice(0, 8))
    : m.inline.name

const createOpen = ref(false)
const createForm = reactive({
  name: '',
  description: '',
  scenarioPrompt: '',
  workspace: '',
  visibility: 'private' as 'private' | 'public',
  leadId: '' as string,
  memberIds: [] as string[],
})
const openCreate = (): void => {
  createForm.name = ''
  createForm.description = ''
  createForm.scenarioPrompt = ''
  createForm.workspace = ''
  createForm.visibility = 'private'
  createForm.leadId = ''
  createForm.memberIds = []
  createOpen.value = true
}
const create = async (): Promise<void> => {
  if (!createForm.name.trim()) {
    message.warning('模板名必填')
    return
  }
  const leadTpl = createForm.leadId ? agentTemplates.value.find(a => a.id === createForm.leadId) : undefined
  const members: ChannelTemplateMemberDto[] = createForm.memberIds
    .filter(id => id !== createForm.leadId)
    .map(id => ({ templateId: id, role: 'worker' as const }))
  try {
    await api.createChannelTemplate({
      name: createForm.name.trim(),
      description: createForm.description || undefined,
      scenarioPrompt: createForm.scenarioPrompt || undefined,
      workspace: createForm.workspace || undefined,
      lead: leadTpl ? { name: leadTpl.name, harness: leadTpl.harness, config: leadTpl.config } : null,
      members,
      visibility: createForm.visibility,
    })
    message.success('模板已创建;可在工作区左侧会话栏一键实例化挂载')
    createOpen.value = false
    void load()
  }
  catch (e) {
    message.error(e instanceof Error ? e.message : String(e))
  }
}

/** 一键切换可见性 */
const toggleVisibility = async (t: ChannelTemplateDto, pub: boolean): Promise<void> => {
  try {
    await api.updateChannelTemplate(t.id, { visibility: pub ? 'public' : 'private' })
    message.success(pub ? '已公开:全员可实例化' : '已转为私有')
    void load()
  }
  catch (e) {
    message.error(e instanceof Error ? e.message : String(e))
  }
}

/** 实例化(不挂载;工作区内挂载走会话栏) */
const instantiating = ref<string | null>(null)
const instantiate = async (t: ChannelTemplateDto): Promise<void> => {
  instantiating.value = t.id
  try {
    const res = await api.instantiateChannelTemplate(t.id)
    const data = (res as unknown as { data?: { channelId: string, agentCount: number } })?.data
    message.success(`已实例化:${t.name}(成员 ${data?.agentCount ?? 0} 个),到工作区挂载使用`)
  }
  catch (e) {
    message.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    instantiating.value = null
  }
}

const remove = async (t: ChannelTemplateDto): Promise<void> => {
  await api.deleteChannelTemplate(t.id)
  message.success('已删除模板')
  void load()
}

useHead({ title: 'Channel 模板中心 · Workshop' })
</script>

<template>
  <div class="page">
    <div class="head">
      <div>
        <h2>Channel 模板中心</h2>
        <p class="sub">
          场景 + 工作目录 + 团队的组合模板;一键实例化为 Channel(成员自动装配)。模板按用户隔离,公开后全员可用。
        </p>
      </div>
      <a-space>
        <a-button @click="navigateTo('/workshop')">
          返回工作区
        </a-button>
        <a-button
          type="primary"
          @click="openCreate"
        >
          新建模板
        </a-button>
      </a-space>
    </div>

    <div class="toolbar">
      <a-segmented
        v-model:value="filter"
        size="small"
        :options="[
          { value: 'all', label: `全部 ${templates.length}` },
          { value: 'mine', label: '我的' },
          { value: 'public', label: '公开' },
          { value: 'builtin', label: '内置' },
        ]"
      />
      <span
        v-if="userStore.isAdmin"
        class="admin-note"
      ><span class="i-tabler-shield-check" /> admin 视图:可见全部用户的模板与创建者</span>
    </div>

    <a-spin :spinning="loading">
      <div class="grid">
        <div
          v-for="t in shown"
          :key="t.id"
          class="card"
        >
          <div class="card-head">
            <span class="name">{{ t.name }}</span>
            <a-tag
              :color="visTag(t).color"
              class="vis-tag"
            >
              <span
                v-if="visTag(t).icon"
                :class="visTag(t).icon"
              />{{ visTag(t).text }}
            </a-tag>
            <a-switch
              v-if="!t.isBuiltin && canWrite(t)"
              :checked="t.visibility === 'public'"
              size="small"
              checked-children="公开"
              un-checked-children="私有"
              @change="(v: unknown) => toggleVisibility(t, v === true)"
            />
            <span class="owner">{{ t.ownerName ?? '-' }}</span>
          </div>
          <p
            v-if="t.description"
            class="desc"
          >
            {{ t.description }}
          </p>
          <div class="member-line">
            <span class="i-tabler-users-group" />
            <template v-if="t.lead || t.members.length > 0">
              <a-tag color="gold">
                lead
              </a-tag>
              <span class="lead-name">{{ t.lead?.name ?? memberLabel(t.members.find(m => m.role === 'lead') ?? t.members[0]!) }}</span>
              <span
                v-if="t.members.filter(m => m.role !== 'lead').length > 0"
                class="count"
              >+ {{ t.members.filter(m => m.role !== 'lead').length }} worker</span>
            </template>
            <span
              v-else
              class="count"
            >空团队</span>
          </div>
          <div
            v-if="t.scenarioPrompt"
            class="scenario"
            :title="t.scenarioPrompt"
          >
            {{ t.scenarioPrompt.slice(0, 90) }}{{ t.scenarioPrompt.length > 90 ? '…' : '' }}
          </div>
          <div class="card-foot">
            <span
              v-if="t.workspace"
              class="ws"
              :title="t.workspace"
            ><span class="i-tabler-folder" /> {{ t.workspace }}</span>
            <span class="spacer" />
            <a-popconfirm
              v-if="canWrite(t)"
              title="删除模板?(已实例化的 Channel 不受影响)"
              @confirm="remove(t)"
            >
              <a-button
                size="small"
                type="text"
                danger
              >
                删除
              </a-button>
            </a-popconfirm>
            <a-button
              size="small"
              type="primary"
              ghost
              :loading="instantiating === t.id"
              title="按模板新建 Channel(成员自动装配)"
              @click="instantiate(t)"
            >
              实例化
            </a-button>
          </div>
        </div>
        <div
          v-if="shown.length === 0"
          class="card placeholder"
          @click="openCreate"
        >
          <span class="i-tabler-layout-grid-add big" />
          <span>新建第一个 Channel 模板</span>
        </div>
      </div>
    </a-spin>

    <a-modal
      v-model:open="createOpen"
      title="新建 Channel 模板"
      ok-text="创建"
      cancel-text="取消"
      @ok="create"
    >
      <a-form layout="vertical">
        <a-form-item label="模板名称">
          <a-input v-model:value="createForm.name" />
        </a-form-item>
        <a-form-item label="描述">
          <a-input v-model:value="createForm.description" />
        </a-form-item>
        <a-form-item label="Lead 模板(实例化时克隆为 channel lead)">
          <a-select
            v-model:value="createForm.leadId"
            allow-clear
            placeholder="选择 lead 模板(可空)"
            :options="agentTemplates.map(a => ({ value: a.id, label: `${a.name}(${a.harness})` }))"
          />
        </a-form-item>
        <a-form-item label="Worker 成员模板(实例化时逐个克隆)">
          <a-select
            v-model:value="createForm.memberIds"
            mode="multiple"
            placeholder="选择成员模板(可空)"
            :options="agentTemplates.filter(a => a.id !== createForm.leadId).map(a => ({ value: a.id, label: `${a.name}(${a.harness})` }))"
          />
        </a-form-item>
        <a-form-item label="作业场景 Prompt(注入全部成员)">
          <a-textarea
            v-model:value="createForm.scenarioPrompt"
            :rows="3"
          />
        </a-form-item>
        <a-form-item label="工作目录(留空 = 实例化时默认)">
          <a-input
            v-model:value="createForm.workspace"
            placeholder="data/workspaces/<channelId>"
          />
        </a-form-item>
        <a-form-item label="可见性">
          <a-radio-group v-model:value="createForm.visibility">
            <a-radio value="private">
              私有(仅本人可见)
            </a-radio>
            <a-radio value="public">
              公开(全员可实例化,仅本人可修改)
            </a-radio>
          </a-radio-group>
        </a-form-item>
      </a-form>
    </a-modal>
  </div>
</template>

<style scoped>
.page { padding: 4px; }
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
h2 { margin: 0 0 4px; }
.sub { margin: 0; font-size: 12px; opacity: 0.55; }
.toolbar {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 12px;
}
.admin-note {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  font-size: 11px;
  color: var(--ink-faint);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 12px;
}
.card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  transition: border-color var(--transition-fast);
}
.card:hover { border-color: var(--line-strong); }
.card-head {
  display: flex;
  gap: 8px;
  align-items: center;
}
.name {
  flex: 1 1 auto;
  overflow: hidden;
  font-size: 15px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vis-tag { margin-right: 2px; }
.owner { font-size: 11px; color: var(--ink-faint); }
.desc {
  margin: 0;
  font-size: 12px;
  color: var(--ink-soft);
}
.member-line {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 12px;
}
.lead-name { font-weight: 500; }
.count {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-faint);
}
.scenario {
  display: -webkit-box;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--ink-faint);
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.card-foot {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-top: 2px;
}
.ws {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  overflow: hidden;
  max-width: 60%;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--ink-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.spacer { flex: 1 1 auto; }
.card.placeholder {
  align-items: center;
  justify-content: center;
  min-height: 160px;
  font-size: 13px;
  opacity: 0.55;
  cursor: pointer;
  border-style: dashed;
}
.big { font-size: 28px; }
</style>
