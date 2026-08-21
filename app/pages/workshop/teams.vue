<script setup lang="ts">
/**
 * AgentTeam 编组库:用户级隔离的编组 CRUD + 成员管理 + 一键 deploy 到 Channel。
 * v10 可见性:private 仅本人;public 全员可读可用(仅属主可改删);内置(锁)不可变更。
 * admin:全量视图(含他人私有),附创建者;可改删任意非内置编组。
 */
import { message } from 'ant-design-vue'
import { useWorkshopApi, type TeamDto, type AgentTemplateDto, type ChannelDto } from '../../composables/workshop/useWorkshopApi'
import { useUserStore } from '../../stores/workshop/user'

definePageMeta({ layout: 'default' })

const api = useWorkshopApi()
const userStore = useUserStore()
const teams = ref<TeamDto[]>([])
const templates = ref<AgentTemplateDto[]>([])
const channels = ref<ChannelDto[]>([])
const loading = ref(false)

const load = async (): Promise<void> => {
  loading.value = true
  try {
    const [t, tpl, ch] = await Promise.all([api.listTeams(), api.listTemplates(), api.listChannels()])
    teams.value = (t as unknown as { data?: TeamDto[] })?.data ?? []
    templates.value = (tpl as unknown as { data?: AgentTemplateDto[] })?.data ?? []
    channels.value = (ch as unknown as { data?: ChannelDto[] })?.data ?? []
  }
  finally {
    loading.value = false
  }
}
void load()

// ===== 过滤 =====
type Filter = 'all' | 'mine' | 'public' | 'builtin'
const filter = ref<Filter>('all')
const shown = computed(() => {
  const uid = userStore.user?.id
  switch (filter.value) {
    case 'mine': return teams.value.filter(t => t.ownerUserId === uid)
    case 'public': return teams.value.filter(t => t.visibility === 'public')
    case 'builtin': return teams.value.filter(t => t.isBuiltin)
    default: return teams.value
  }
})

const canWrite = (team: TeamDto): boolean =>
  !team.isBuiltin && (team.ownerUserId === userStore.user?.id || userStore.isAdmin)

const visTag = (team: TeamDto): { text: string, color: string, icon?: string } => {
  if (team.isBuiltin) return { text: '内置', color: 'default', icon: 'i-tabler-lock' }
  if (team.visibility === 'public') return { text: '公开', color: 'green' }
  return { text: '私有', color: 'default' }
}

const createOpen = ref(false)
const createForm = reactive({ name: '', description: '', visibility: 'private' as 'private' | 'public' })
const create = async (): Promise<void> => {
  if (!createForm.name.trim()) {
    message.warning('名称必填')
    return
  }
  await api.createTeam({ name: createForm.name.trim(), description: createForm.description || undefined, visibility: createForm.visibility })
  message.success('已创建')
  createOpen.value = false
  createForm.name = ''
  createForm.description = ''
  createForm.visibility = 'private'
  void load()
}

/** 一键切换可见性(属主/admin) */
const toggleVisibility = async (team: TeamDto, pub: boolean): Promise<void> => {
  try {
    await api.updateTeam(team.id, { visibility: pub ? 'public' : 'private' })
    message.success(pub ? '已公开:全员可部署,仅你可修改' : '已转为私有')
    void load()
  }
  catch (e) {
    message.error(e instanceof Error ? e.message : String(e))
  }
}

const addOpen = ref(false)
const addTeam = ref<TeamDto | null>(null)
const addTemplateId = ref<string>('')
const addRole = ref<'lead' | 'worker'>('worker')
const openAdd = (team: TeamDto): void => {
  addTeam.value = team
  addTemplateId.value = ''
  addRole.value = 'worker'
  addOpen.value = true
}
const addMember = async (): Promise<void> => {
  if (!addTeam.value || !addTemplateId.value) {
    message.warning('选择模板')
    return
  }
  try {
    await api.addTeamMember(addTeam.value.id, { agentId: addTemplateId.value, role: addRole.value })
    message.success('已加入')
    addOpen.value = false
    void load()
  }
  catch (e) {
    message.error(e instanceof Error ? e.message : String(e))
  }
}
const removeMember = async (team: TeamDto, templateId: string): Promise<void> => {
  await api.removeTeamMember(team.id, templateId)
  void load()
}

const deployOpen = ref(false)
const deployTeamRef = ref<TeamDto | null>(null)
const deployChannelId = ref<string>('')
const deploying = ref(false)
const openDeploy = (team: TeamDto): void => {
  deployTeamRef.value = team
  deployChannelId.value = ''
  deployOpen.value = true
}
const deploy = async (): Promise<void> => {
  if (!deployTeamRef.value || !deployChannelId.value) {
    message.warning('选择目标 Channel')
    return
  }
  deploying.value = true
  try {
    const res = await api.deployTeam(deployTeamRef.value.id, deployChannelId.value)
    const agents = (res as unknown as { data?: { agents?: unknown[] } })?.data?.agents?.length ?? 0
    message.success(`已部署 ${agents} 个实例到 Channel`)
    deployOpen.value = false
  }
  catch (e) {
    message.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    deploying.value = false
  }
}

const removeTeam = async (team: TeamDto): Promise<void> => {
  await api.deleteTeam(team.id)
  message.success('已删除编组')
  void load()
}

useHead({ title: 'AgentTeam 编组库 · Workshop' })
</script>

<template>
  <div class="page">
    <div class="head">
      <div>
        <h2>AgentTeam 编组库</h2>
        <p class="sub">
          编组按用户隔离;公开编组全员可部署(仅属主可修改);一键整体部署到 Channel(每个成员克隆为独立实例)。
        </p>
      </div>
      <a-space>
        <a-button @click="navigateTo('/workshop')">
          返回工作区
        </a-button>
        <a-button
          type="primary"
          @click="createOpen = true"
        >
          新建编组
        </a-button>
      </a-space>
    </div>

    <div class="toolbar">
      <a-segmented
        v-model:value="filter"
        size="small"
        :options="[
          { value: 'all', label: `全部 ${teams.length}` },
          { value: 'mine', label: '我的' },
          { value: 'public', label: '公开' },
          { value: 'builtin', label: '内置' },
        ]"
      />
      <span
        v-if="userStore.isAdmin"
        class="admin-note"
      ><span class="i-tabler-shield-check" /> admin 视图:可见全部用户的编组与创建者</span>
    </div>

    <a-spin :spinning="loading">
      <div class="grid">
        <div
          v-for="team in shown"
          :key="team.id"
          class="card"
        >
          <div class="card-head">
            <span class="name">{{ team.name }}</span>
            <a-tag
              :color="visTag(team).color"
              class="vis-tag"
            >
              <span
                v-if="visTag(team).icon"
                :class="visTag(team).icon"
              />{{ visTag(team).text }}
            </a-tag>
            <a-switch
              v-if="!team.isBuiltin && canWrite(team)"
              :checked="team.visibility === 'public'"
              size="small"
              checked-children="公开"
              un-checked-children="私有"
              @change="(v: unknown) => toggleVisibility(team, v === true)"
            />
            <span class="owner">{{ team.ownerName ?? '-' }}</span>
            <a-dropdown v-if="canWrite(team)">
              <span class="i-tabler-dots op" />
              <template #overlay>
                <a-menu>
                  <a-menu-item @click="openDeploy(team)">
                    部署到 Channel…
                  </a-menu-item>
                  <a-menu-item
                    danger
                    @click="removeTeam(team)"
                  >
                    删除编组
                  </a-menu-item>
                </a-menu>
              </template>
            </a-dropdown>
            <a-button
              v-else
              size="small"
              type="text"
              title="公开编组:全员可部署;仅属主可修改"
              @click="openDeploy(team)"
            >
              部署
            </a-button>
          </div>
          <div class="members">
            <div
              v-for="m in team.members"
              :key="m.templateId"
              class="member"
            >
              <a-tag
                :color="m.role === 'lead' ? 'gold' : 'blue'"
                class="role"
              >
                {{ m.role }}
              </a-tag>
              <span class="member-name">{{ m.name }}</span>
              <span class="member-harness">{{ m.harness }}</span>
              <span
                v-if="canWrite(team)"
                class="i-tabler-x rm"
                @click="removeMember(team, m.templateId)"
              />
            </div>
            <a-button
              v-if="canWrite(team)"
              size="small"
              type="dashed"
              block
              @click="openAdd(team)"
            >
              + 添加成员模板
            </a-button>
          </div>
        </div>
        <div
          v-if="shown.length === 0"
          class="card placeholder"
          @click="createOpen = true"
        >
          <span class="i-tabler-plus big" />
          <span>新建第一个编组</span>
        </div>
      </div>
    </a-spin>

    <a-modal
      v-model:open="createOpen"
      title="新建编组"
      ok-text="创建"
      cancel-text="取消"
      @ok="create"
    >
      <a-form layout="vertical">
        <a-form-item label="名称">
          <a-input v-model:value="createForm.name" />
        </a-form-item>
        <a-form-item label="描述">
          <a-input v-model:value="createForm.description" />
        </a-form-item>
        <a-form-item label="可见性">
          <a-radio-group v-model:value="createForm.visibility">
            <a-radio value="private">
              私有(仅本人可见)
            </a-radio>
            <a-radio value="public">
              公开(全员可部署,仅本人可修改)
            </a-radio>
          </a-radio-group>
        </a-form-item>
      </a-form>
    </a-modal>

    <a-modal
      v-model:open="addOpen"
      :title="`添加成员 · ${addTeam?.name ?? ''}`"
      ok-text="加入"
      cancel-text="取消"
      @ok="addMember"
    >
      <a-form layout="vertical">
        <a-form-item label="模板">
          <a-select
            v-model:value="addTemplateId"
            :options="templates.map(t => ({ value: t.id, label: `${t.name}(${t.harness})` }))"
          />
        </a-form-item>
        <a-form-item label="角色">
          <a-radio-group v-model:value="addRole">
            <a-radio value="worker">
              worker
            </a-radio>
            <a-radio value="lead">
              lead(至多一个)
            </a-radio>
          </a-radio-group>
        </a-form-item>
      </a-form>
    </a-modal>

    <a-modal
      v-model:open="deployOpen"
      :title="`部署 · ${deployTeamRef?.name ?? ''}`"
      :confirm-loading="deploying"
      ok-text="部署"
      cancel-text="取消"
      @ok="deploy"
    >
      <a-form layout="vertical">
        <a-form-item label="目标 Channel(须无 lead 冲突)">
          <a-select
            v-model:value="deployChannelId"
            :options="channels.map(c => ({ value: c.id, label: c.name }))"
          />
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
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
}
.card {
  display: flex;
  flex-direction: column;
  gap: 10px;
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
  font-size: 15px;
  font-weight: 600;
}
.vis-tag { margin-right: 2px; }
.owner {
  font-size: 11px;
  color: var(--ink-faint);
}
.op { cursor: pointer; opacity: 0.4; }
.op:hover { opacity: 1; }
.members {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.member {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 12px;
}
.member-name { font-weight: 500; }
.member-harness {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 10.5px;
  opacity: 0.5;
}
.rm { cursor: pointer; opacity: 0.35; }
.rm:hover { opacity: 1; }
.card.placeholder {
  align-items: center;
  justify-content: center;
  min-height: 140px;
  font-size: 13px;
  opacity: 0.55;
  cursor: pointer;
  border-style: dashed;
}
.big { font-size: 28px; }
</style>
