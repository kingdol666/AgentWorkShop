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

const { t } = useI18n()

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
  if (t.isBuiltin) return { text: t('ctpl.k3x23c021'), color: 'default', icon: 'i-tabler-lock' }
  if (t.visibility === 'public') return { text: t('ctpl.k3wv1t022'), color: 'green' }
  return { text: t('ctpl.k447jj023'), color: 'default' }
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
    message.warning(t('ctpl.k1i0ji0y024'))
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
    message.success(t('ctpl.kyppebc025'))
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
    message.success(pub ? t('ctpl.kkziya3026') : t('ctpl.k1xxabaf027'))
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
    message.success(t('ctpl.kefkfnl030', { p0: t.name, p1: data?.agentCount ?? 0 }))
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
  message.success(t('ctpl.k1oxfuqj028'))
  void load()
}

useHead({ title: () => t('titles.ctpl') })
</script>

<template>
  <div class="page">
    <div class="head">
      <div>
        <h2>Channel {{ $t('ctpl.k1f54iqd029') }}</h2>
        <p class="sub">
          {{ $t('ctpl.k18gglgp011') }}
        </p>
      </div>
      <a-space>
        <a-button @click="navigateTo('/workshop')">
          {{ $t('ctpl.krpx6qa012') }}
        </a-button>
        <a-button
          type="primary"
          @click="openCreate"
        >
          {{ $t('ctpl.k1efixrj013') }}
        </a-button>
      </a-space>
    </div>

    <div class="toolbar">
      <a-segmented
        v-model:value="filter"
        size="small"
        :options="[
          { value: 'all', label: $t('chips.chipAll', { n: templates.length }) },
          { value: 'mine', label: $t('chips.mine') },
          { value: 'public', label: $t('chips.public') },
          { value: 'builtin', label: $t('chips.builtin') },
        ]"
      />
      <span
        v-if="userStore.isAdmin"
        class="admin-note"
      ><span class="i-tabler-shield-check" /> {{ $t('ctpl.ka1gpdj014') }}</span>
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
            >{{ $t('ctpl.k3rx4ps015') }}</span>
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
              :title="$t('ctpl.k117jag9001')"
              @confirm="remove(t)"
            >
              <a-button
                size="small"
                type="text"
                danger
              >
                {{ $t('ctpl.k3xakp016') }}
              </a-button>
            </a-popconfirm>
            <a-button
              size="small"
              type="primary"
              ghost
              :loading="instantiating === t.id"
              :title="$t('ctpl.knjomku002')"
              @click="instantiate(t)"
            >
              {{ $t('ctpl.k3mr1fo017') }}
            </a-button>
          </div>
        </div>
        <div
          v-if="shown.length === 0"
          class="card placeholder"
          @click="openCreate"
        >
          <span class="i-tabler-layout-grid-add big" />
          <span>{{ $t('ctpl.k19fglby018') }}</span>
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
        <a-form-item :label="$t('ctpl.k1f55q76003')">
          <a-input v-model:value="createForm.name" />
        </a-form-item>
        <a-form-item :label="$t('ctpl.k40gkk004')">
          <a-input v-model:value="createForm.description" />
        </a-form-item>
        <a-form-item label="Lead 模板(实例化时克隆为 channel lead)">
          <a-select
            v-model:value="createForm.leadId"
            allow-clear
            :placeholder="$t('ctpl.k1ju32o7005')"
            :options="agentTemplates.map(a => ({ value: a.id, label: `${a.name}(${a.harness})` }))"
          />
        </a-form-item>
        <a-form-item :label="$t('ctpl.k5uq1js006')">
          <a-select
            v-model:value="createForm.memberIds"
            mode="multiple"
            :placeholder="$t('ctpl.kqmdkc9007')"
            :options="agentTemplates.filter(a => a.id !== createForm.leadId).map(a => ({ value: a.id, label: `${a.name}(${a.harness})` }))"
          />
        </a-form-item>
        <a-form-item :label="$t('ctpl.k1q87yho008')">
          <a-textarea
            v-model:value="createForm.scenarioPrompt"
            :rows="3"
          />
        </a-form-item>
        <a-form-item :label="$t('ctpl.kk4u5cr009')">
          <a-input
            v-model:value="createForm.workspace"
            placeholder="data/workspaces/<channelId>"
          />
        </a-form-item>
        <a-form-item :label="$t('ctpl.k3lrqn0010')">
          <a-radio-group v-model:value="createForm.visibility">
            <a-radio value="private">
              {{ $t('ctpl.k17jfge3019') }}
            </a-radio>
            <a-radio value="public">
              {{ $t('ctpl.k191u0u5020') }}
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
