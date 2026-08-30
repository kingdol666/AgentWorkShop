<script setup lang="ts">
/**
 * AgentTeam 编组库:用户级隔离的编组 CRUD + 成员管理 + 一键 deploy 到 Channel。
 * v10 可见性:private 仅本人;public 全员可读可用(仅属主可改删);内置(锁)不可变更。
 * admin:全量视图(含他人私有),附创建者;可改删任意非内置编组。
 */
import { message } from 'ant-design-vue'
import { useWorkshopApi, type TeamDto, type AgentTemplateDto, type ChannelDto } from '../../composables/workshop/useWorkshopApi'
import { useUserStore } from '../../stores/workshop/user'

const { t } = useI18n()

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
  if (team.isBuiltin) return { text: t('teams.k3x23c018'), color: 'default', icon: 'i-tabler-lock' }
  if (team.visibility === 'public') return { text: t('teams.k3wv1t019'), color: 'green' }
  return { text: t('teams.k447jj020'), color: 'default' }
}

const createOpen = ref(false)
const createForm = reactive({ name: '', description: '', visibility: 'private' as 'private' | 'public' })
const create = async (): Promise<void> => {
  if (!createForm.name.trim()) {
    message.warning(t('teams.k1bvcdo2021'))
    return
  }
  await api.createTeam({ name: createForm.name.trim(), description: createForm.description || undefined, visibility: createForm.visibility })
  message.success(t('teams.k3n5hak022'))
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
    message.success(pub ? t('teams.k1globhp023') : t('teams.k1xxabaf024'))
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
    message.warning(t('teams.k1kw4rtj025'))
    return
  }
  try {
    await api.addTeamMember(addTeam.value.id, { agentId: addTemplateId.value, role: addRole.value })
    message.success(t('teams.k3n5hzw026'))
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
    message.success(t('teams.kh90glh031', { p0: agents }))
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
  message.success(t('teams.k1oxjrxx027'))
  void load()
}

useHead({ title: () => t('titles.teams') })
</script>

<template>
  <div class="page">
    <div class="head">
      <div>
        <h2>AgentTeam {{ $t('teams.k3svl8y028') }}</h2>
        <p class="sub">
          {{ $t('teams.k12gl4wn008') }}
        </p>
      </div>
      <a-space>
        <a-button @click="navigateTo('/workshop')">
          {{ $t('teams.krpx6qa009') }}
        </a-button>
        <a-button
          type="primary"
          @click="createOpen = true"
        >
          {{ $t('teams.k1efmuyx002') }}
        </a-button>
      </a-space>
    </div>

    <div class="toolbar">
      <a-segmented
        v-model:value="filter"
        size="small"
        :options="[
          { value: 'all', label: $t('chips.chipAll', { n: teams.length }) },
          { value: 'mine', label: $t('chips.mine') },
          { value: 'public', label: $t('chips.public') },
          { value: 'builtin', label: $t('chips.builtin') },
        ]"
      />
      <span
        v-if="userStore.isAdmin"
        class="admin-note"
      ><span class="i-tabler-shield-check" /> {{ $t('teams.k1bpgi8h010') }}</span>
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
                    {{ $t('teams.k1bpojhf011') }}
                  </a-menu-item>
                </a-menu>
              </template>
            </a-dropdown>
            <a-button
              v-else
              size="small"
              type="text"
              :title="$t('teams.kxheuf1001')"
              @click="openDeploy(team)"
            >
              {{ $t('teams.k48ja7012') }}
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
              {{ $t('teams.krt2oib013') }}
            </a-button>
          </div>
        </div>
        <div
          v-if="shown.length === 0"
          class="card placeholder"
          @click="createOpen = true"
        >
          <span class="i-tabler-plus big" />
          <span>{{ $t('teams.k6cbbgf014') }}</span>
        </div>
      </div>
    </a-spin>

    <a-modal
      v-model:open="createOpen"
      :title="$t('teams.k1efmuyx002')"
      ok-text="创建"
      cancel-text="取消"
      @ok="create"
    >
      <a-form layout="vertical">
        <a-form-item :label="$t('teams.k3xhia003')">
          <a-input v-model:value="createForm.name" />
        </a-form-item>
        <a-form-item :label="$t('teams.k40gkk004')">
          <a-input v-model:value="createForm.description" />
        </a-form-item>
        <a-form-item :label="$t('teams.k3lrqn0005')">
          <a-radio-group v-model:value="createForm.visibility">
            <a-radio value="private">
              {{ $t('teams.k17jfge3015') }}
            </a-radio>
            <a-radio value="public">
              {{ $t('teams.k1h2lq0o016') }}
            </a-radio>
          </a-radio-group>
        </a-form-item>
      </a-form>
    </a-modal>

    <a-modal
      v-model:open="addOpen"
      :title="$t('teams.k6ljhyv029', { p0: addTeam?.name ?? '' })"
      ok-text="加入"
      cancel-text="取消"
      @ok="addMember"
    >
      <a-form layout="vertical">
        <a-form-item :label="$t('teams.k41ds5006')">
          <a-select
            v-model:value="addTemplateId"
            :options="templates.map(t => ({ value: t.id, label: `${t.name}(${t.harness})` }))"
          />
        </a-form-item>
        <a-form-item :label="$t('teams.k479op007')">
          <a-radio-group v-model:value="addRole">
            <a-radio value="worker">
              worker
            </a-radio>
            <a-radio value="lead">
              {{ $t('teams.keowzlv017') }}
            </a-radio>
          </a-radio-group>
        </a-form-item>
      </a-form>
    </a-modal>

    <a-modal
      v-model:open="deployOpen"
      :title="$t('teams.k1c0o6oe030', { p0: deployTeamRef?.name ?? '' })"
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
