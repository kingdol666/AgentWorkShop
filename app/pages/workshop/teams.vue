<script setup lang="ts">
/**
 * AgentTeam 编组库(P1):模板编组 CRUD + 成员管理 + 一键 deploy 到 Channel。
 */
import { message } from 'ant-design-vue'
import { useWorkshopApi, type TeamDto, type AgentTemplateDto, type ChannelDto } from '../../composables/workshop/useWorkshopApi'

definePageMeta({ layout: 'default' })

const api = useWorkshopApi()
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

const createOpen = ref(false)
const createForm = reactive({ name: '', description: '' })
const create = async (): Promise<void> => {
  if (!createForm.name.trim()) {
    message.warning('名称必填')
    return
  }
  await api.createTeam({ name: createForm.name.trim(), description: createForm.description || undefined })
  message.success('已创建')
  createOpen.value = false
  createForm.name = ''
  createForm.description = ''
  void load()
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
          模板编组;一键整体部署到 Channel(每个成员克隆为独立实例)。
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

    <a-spin :spinning="loading">
      <div class="grid">
        <div
          v-for="team in teams"
          :key="team.id"
          class="card"
        >
          <div class="card-head">
            <span class="name">{{ team.name }}</span>
            <a-dropdown>
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
          </div>
          <div class="members">
            <div
              v-for="m in team.members"
              :key="m.templateId"
              class="member"
            >
              <a-tag
                :color="m.role === 'lead' ? 'purple' : 'blue'"
                class="role"
              >
                {{ m.role }}
              </a-tag>
              <span class="member-name">{{ m.name }}</span>
              <span class="member-harness">{{ m.harness }}</span>
              <span
                class="i-tabler-x rm"
                @click="removeMember(team, m.templateId)"
              />
            </div>
            <a-button
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
          v-if="teams.length === 0"
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
  margin-bottom: 16px;
}
h2 { margin: 0 0 4px; }
.sub { margin: 0; font-size: 12px; opacity: 0.55; }
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
}
.card {
  padding: 14px;
  border: 1px solid color-mix(in srgb, currentColor 10%, transparent);
  border-radius: 12px;
}
.card.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 160px;
  font-size: 13px;
  opacity: 0.55;
  cursor: pointer;
  border-style: dashed;
}
.big { font-size: 28px; }
.card-head {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 10px;
}
.name { flex: 1 1 auto; font-size: 15px; font-weight: 700; }
.op { cursor: pointer; opacity: 0.4; }
.op:hover { opacity: 1; }
.members { display: flex; flex-direction: column; gap: 4px; }
.member {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 4px 6px;
  font-size: 13px;
  border-radius: 6px;
}
.member:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
.role { margin-inline-end: 0; font-size: 10px; }
.member-name { font-weight: 600; }
.member-harness {
  flex: 1 1 auto;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
  opacity: 0.45;
}
.rm { font-size: 12px; cursor: pointer; opacity: 0.35; }
.rm:hover { opacity: 1; }
</style>
