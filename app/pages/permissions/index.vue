<script setup lang="ts">
/**
 * 权限管理(admin 专属)—— 用户 × 产线授权矩阵。
 * 三态:无权(none,后端不返回该产线数据)/ 仅查看(readonly,数采只读)/ 可操控(operate,数采+数控全量)。
 * 用户详情抽屉含:基本信息、该用户创建的 Channel、产线授权矩阵(逐线三态选择,批量保存)。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useUserStore } from '~/stores/workshop/user'

const { t } = useI18n()
const userStore = useUserStore()

interface LineView { id: string, name: string }
interface GrantRow { lineId: string, mode: string, grantedBy: string | null, grantedAt: string }
interface UserRow {
  id: string
  name: string
  email: string
  role: string
  status: string
  createdAt: string
  channels: Array<{ id: string, name: string, createdAt: string }>
  grants: GrantRow[]
}

const lines = ref<LineView[]>([])
const users = ref<UserRow[]>([])
const loading = ref(false)
const keyword = ref('')
const drawerOpen = ref(false)
const current = ref<UserRow | null>(null)
// lineId → 'none' | 'readonly' | 'operate'
const draft = reactive<Record<string, string>>({})
const saving = ref(false)

function authHeaders(): Record<string, string> {
  const token = (userStore as { token?: string }).token
  return token ? { authorization: `Bearer ${token}` } : {}
}

async function load() {
  loading.value = true
  try {
    const d = await $fetch<{ code: number, data?: { lines: LineView[], users: UserRow[] } }>('/api/workshop/permissions', { headers: authHeaders() })
    if (d.code !== 0 || !d.data) throw new Error('load fail')
    lines.value = d.data.lines ?? []
    users.value = d.data.users ?? []
  }
  catch (err) {
    message.error(apiErrorMessage(err, t('permissions.loadFail')))
  }
  finally {
    loading.value = false
  }
}

const filteredUsers = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return users.value
  return users.value.filter(u => `${u.name} ${u.email}`.toLowerCase().includes(kw))
})

function openDetail(u: UserRow) {
  current.value = u
  draftClear(u)
  drawerOpen.value = true
}

function draftClear(u: UserRow) {
  for (const k of Object.keys(draft)) Reflect.deleteProperty(draft, k)
  for (const l of lines.value) {
    const g = u.grants.find(x => x.lineId === l.id)
    draft[l.id] = (g?.mode === 'readonly' || g?.mode === 'operate') ? g.mode : 'none'
  }
}

const dirtyCount = computed(() => {
  if (!current.value) return 0
  let n = 0
  for (const l of lines.value) {
    const g = current.value.grants.find(x => x.lineId === l.id)
    const cur = (g?.mode === 'readonly' || g?.mode === 'operate') ? g.mode : 'none'
    if ((draft[l.id] ?? 'none') !== cur) n++
  }
  return n
})

async function save() {
  if (!current.value) return
  saving.value = true
  try {
    const grants = lines.value
      .filter(l => (draft[l.id] ?? 'none') !== 'none')
      .map(l => ({ lineId: l.id, mode: draft[l.id] }))
    const revoked = lines.value
      .filter(l => (draft[l.id] ?? 'none') === 'none' && current.value!.grants.some(g => g.lineId === l.id))
      .map(l => ({ lineId: l.id, mode: null }))
    const d = await $fetch<{ code: number, data?: { grants: GrantRow[] } }>('/api/workshop/permissions', {
      method: 'PUT',
      headers: authHeaders(),
      body: { userId: current.value.id, grants: [...grants, ...revoked] },
    })
    if (d.code !== 0 || !d.data) throw new Error('save fail')
    current.value.grants = d.data.grants
    const u = users.value.find(x => x.id === current.value?.id)
    if (u) u.grants = d.data.grants
    message.success(t('permissions.saved', { n: grants.length + revoked.length }))
  }
  catch (err) {
    message.error(apiErrorMessage(err, t('permissions.saveFail')))
  }
  finally {
    saving.value = false
  }
}

function modeTag(mode: string): string {
  return mode === 'operate' ? t('permissions.operate') : mode === 'readonly' ? t('permissions.readonly') : t('permissions.none')
}

// admin 专属页:非 admin 直接回仪表盘(后端 API 亦有 admin 拦截)
watch(() => userStore.isLoggedIn, (ok) => {
  if (ok && !userStore.isAdmin) navigateTo('/')
}, { immediate: true })

onMounted(load)
</script>

<template>
  <div class="perm-page">
    <header class="pg-head">
      <div>
        <p class="aw-kicker">
          agentworkshop / permissions
        </p>
        <h1 class="pg-title">
          {{ $t('permissions.title') }}
        </h1>
        <p class="pg-sub">
          {{ $t('permissions.subtitle') }}
        </p>
      </div>
      <a-input-search
        v-model:value="keyword"
        :placeholder="$t('permissions.search')"
        style="max-width: 260px"
        allow-clear
      />
    </header>

    <a-table
      :data-source="filteredUsers"
      :loading="loading"
      row-key="id"
      size="middle"
      :pagination="{ pageSize: 12, showSizeChanger: false }"
    >
      <a-table-column
        :title="$t('permissions.colUser')"
        data-index="name"
      >
        <template #default="{ record }">
          <a @click.prevent="openDetail(record)">{{ record.name }}</a>
        </template>
      </a-table-column>
      <a-table-column
        :title="$t('permissions.colEmail')"
        data-index="email"
      />
      <a-table-column
        :title="$t('permissions.colRole')"
        data-index="role"
      >
        <template #default="{ record }">
          <a-tag :color="record.role === 'admin' ? 'green' : record.role === 'editor' ? 'blue' : 'default'">
            {{ record.role }}
          </a-tag>
        </template>
      </a-table-column>
      <a-table-column
        :title="$t('permissions.colStatus')"
        data-index="status"
      >
        <template #default="{ record }">
          <a-tag :color="record.status === 'active' ? 'cyan' : 'red'">
            {{ record.status === 'active' ? $t('permissions.active') : record.status }}
          </a-tag>
        </template>
      </a-table-column>
      <a-table-column
        :title="$t('permissions.colChannels')"
        data-index="channels"
      >
        <template #default="{ record }">
          {{ record.channels.length }}
        </template>
      </a-table-column>
      <a-table-column
        :title="$t('permissions.colGrants')"
        data-index="grants"
      >
        <template #default="{ record }">
          <a-tag
            v-for="g in record.grants"
            :key="g.lineId"
            style="margin-bottom: 2px"
          >
            {{ (lines.find(l => l.id === g.lineId)?.name ?? g.lineId).slice(0, 14) }} · {{ modeTag(g.mode) }}
          </a-tag>
          <span
            v-if="!record.grants.length"
            class="dim"
          >—</span>
        </template>
      </a-table-column>
      <a-table-column
        :title="$t('permissions.colOps')"
        :width="90"
      >
        <template #default="{ record }">
          <a-button
            size="small"
            @click="openDetail(record)"
          >
            {{ $t('permissions.manage') }}
          </a-button>
        </template>
      </a-table-column>
    </a-table>

    <a-drawer
      v-model:open="drawerOpen"
      :title="current ? `${current.name} · ${$t('permissions.detail')}` : ''"
      width="560"
    >
      <template v-if="current">
        <h4 class="sec">
          {{ $t('permissions.secProfile') }}
        </h4>
        <dl class="detail">
          <dt>email</dt><dd>{{ current.email }}</dd>
          <dt>role</dt><dd>{{ current.role }}</dd>
          <dt>status</dt><dd>{{ current.status }}</dd>
          <dt>created</dt><dd>{{ current.createdAt }}</dd>
        </dl>

        <h4 class="sec">
          {{ $t('permissions.secChannels') }}({{ current.channels.length }})
        </h4>
        <div
          v-if="current.channels.length"
          class="ch-list"
        >
          <code
            v-for="c in current.channels"
            :key="c.id"
          >{{ c.name || c.id.slice(0, 8) }}</code>
        </div>
        <p
          v-else
          class="dim"
        >
          {{ $t('permissions.noChannels') }}
        </p>

        <h4 class="sec">
          {{ $t('permissions.secMatrix') }}
          <a-button
            type="primary"
            size="small"
            :loading="saving"
            :disabled="dirtyCount === 0"
            style="margin-left: 12px"
            @click="save"
          >
            {{ $t('permissions.save', { n: dirtyCount }) }}
          </a-button>
        </h4>
        <p class="hint">
          {{ $t('permissions.matrixHint') }}
        </p>
        <div class="matrix">
          <div
            v-for="l in lines"
            :key="l.id"
            class="row"
          >
            <span
              class="line-name"
              :title="l.id"
            >{{ l.name }}</span>
            <a-radio-group
              v-model:value="draft[l.id]"
              size="small"
            >
              <a-radio-button value="none">
                {{ $t('permissions.none') }}
              </a-radio-button>
              <a-radio-button value="readonly">
                {{ $t('permissions.readonly') }}
              </a-radio-button>
              <a-radio-button value="operate">
                {{ $t('permissions.operate') }}
              </a-radio-button>
            </a-radio-group>
          </div>
        </div>
      </template>
    </a-drawer>
  </div>
</template>

<style scoped lang="css">
.perm-page { max-width: 1180px; margin: 0 auto; padding: 24px 20px 48px; }
.pg-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.pg-title { margin: 0; font-size: 22px; font-weight: 700; letter-spacing: .5px; }
.pg-sub { margin: 4px 0 0; opacity: .6; font-size: 12px; }
.dim { opacity: .45; }
.sec { margin: 20px 0 8px; font-size: 13px; font-weight: 700; }
.detail dt { margin-top: 8px; font-size: 11px; opacity: .5; }
.detail dd { margin: 2px 0 0; font-family: ui-monospace, monospace; font-size: 12px; }
.ch-list { display: flex; flex-wrap: wrap; gap: 6px; }
.ch-list code { padding: 2px 8px; border: 1px solid rgba(128, 152, 199, .3); border-radius: 6px; font-size: 11px; }
.hint { font-size: 11px; opacity: .55; margin: 4px 0 10px; }
.matrix { display: flex; flex-direction: column; gap: 8px; }
.matrix .row { display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 8px 12px; border: 1px solid var(--aw-border, rgba(128, 152, 199, .25)); border-radius: 10px; }
.line-name { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
