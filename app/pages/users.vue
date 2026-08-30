<script setup lang="ts">
/**
 * 用户管理页(仅 admin):真实数据源 GET /api/users(其余角色 → 403 门禁视图)。
 * 角色 admin/editor/user;状态 active/disabled;支持角色调整、启停、删除。
 */
import { message } from 'ant-design-vue'
import { useUserStore } from '../stores/workshop/user'

const { t } = useI18n()
const userStore = useUserStore()

interface UserRecord {
  id: string
  name: string
  email: string
  role: 'admin' | 'editor' | 'user'
  status: 'active' | 'disabled'
  createdAt: string
}
interface ApiEnvelope<T> { code: number | string, message: string, data: T | null }

const loading = ref(false)
const users = ref<UserRecord[]>([])
const keyword = ref('')
const authHeaders = computed(() => userStore.authHeaders())

const load = async (): Promise<void> => {
  if (!userStore.isAdmin) return
  loading.value = true
  try {
    const res = await $fetch<ApiEnvelope<{ items: UserRecord[] }>>('/api/users', {
      headers: authHeaders.value,
      query: { pageSize: 100, keyword: keyword.value || undefined },
    })
    users.value = res.data?.items ?? []
  }
  catch (e) {
    message.error(e instanceof Error ? e.message : t('users.k1br33vc006'))
  }
  finally {
    loading.value = false
  }
}
watch(() => userStore.isLoggedIn, (v) => {
  if (v) void load()
}, { immediate: true })

const roleColor: Record<UserRecord['role'], string> = {
  admin: 'volcano',
  editor: 'blue',
  user: 'default',
}

const columns = computed(() => [
  { title: t('users.name'), dataIndex: 'name', key: 'name' },
  { title: t('users.email'), dataIndex: 'email', key: 'email' },
  { title: t('users.role'), dataIndex: 'role', key: 'role', width: 110 },
  { title: t('common.status'), dataIndex: 'status', key: 'status', width: 90 },
  { title: t('users.created'), dataIndex: 'createdAt', key: 'createdAt', width: 150 },
  { title: t('common.actions'), key: 'action', width: 220 },
])

function roleLabel(role: UserRecord['role']) {
  return t(`users.role${role.charAt(0).toUpperCase()}${role.slice(1)}`)
}

const changeRole = async (u: UserRecord, role: UserRecord['role']): Promise<void> => {
  try {
    await $fetch<ApiEnvelope<unknown>>(`/api/users/${u.id}`, {
      method: 'PUT',
      headers: authHeaders.value,
      body: { role },
    })
    message.success(t('users.krkb23h011', { p0: u.name, p1: role }))
    void load()
  }
  catch (e) {
    message.error(e instanceof Error ? e.message : t('users.k1enhqn3007'))
  }
}

const toggleStatus = async (u: UserRecord): Promise<void> => {
  const status = u.status === 'active' ? 'disabled' : 'active'
  try {
    await $fetch<ApiEnvelope<unknown>>(`/api/users/${u.id}`, {
      method: 'PUT',
      headers: authHeaders.value,
      body: { status },
    })
    message.success(t('users.k1u7u12g012', { p0: u.name, p1: status === 'active' ? t('users.k3xhfg009') : t('users.k3wsi1010') }))
    void load()
  }
  catch (e) {
    message.error(e instanceof Error ? e.message : t('users.k1enhqn3007'))
  }
}

const removeUser = async (u: UserRecord): Promise<void> => {
  try {
    await $fetch<ApiEnvelope<unknown>>(`/api/users/${u.id}`, {
      method: 'DELETE',
      headers: authHeaders.value,
    })
    message.success(t('users.knh5f2r013', { p0: u.name }))
    void load()
  }
  catch (e) {
    message.error(e instanceof Error ? e.message : t('users.k1bphrb3008'))
  }
}

const isSelf = (u: UserRecord): boolean => u.id === userStore.user?.id

useHead({ title: () => t('titles.users') })
</script>

<template>
  <div class="page-wrap">
    <div class="page-head">
      <div>
        <h2 class="page-title">
          {{ t('users.title') }}
          <a-tag
            color="volcano"
            class="admin-tag"
          >
            <span class="i-tabler-shield-check" />
            admin
          </a-tag>
        </h2>
        <p class="page-sub">
          {{ $t('users.k1flpho5002') }}
        </p>
      </div>
      <a-input-search
        v-model:value="keyword"
        :placeholder="t('users.search')"
        style="width: 240px"
        @search="load"
      />
    </div>

    <!-- 非 admin 门禁视图 -->
    <a-card
      v-if="!userStore.isAdmin"
      :bordered="false"
      class="gate-card"
    >
      <span class="i-tabler-lock gate-icon" />
      <p class="gate-title">
        {{ $t('users.kpdo6rc003') }}
      </p>
      <p class="gate-hint">
        {{ $t('users.k1mue9bl004') }}
      </p>
    </a-card>

    <a-card
      v-else
      :bordered="false"
      class="table-card"
    >
      <a-table
        :data-source="users"
        :columns="columns"
        :loading="loading"
        row-key="id"
        size="small"
        :pagination="false"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'role'">
            <a-tag :color="roleColor[record.role as UserRecord['role']]">
              {{ roleLabel(record.role as UserRecord['role']) }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'status'">
            <a-tag :color="record.status === 'active' ? 'green' : 'default'">
              {{ record.status === 'active' ? $t('users.k3xhfg009') : $t('users.k3wsi1010') }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'action'">
            <a-space size="small">
              <a-select
                :value="record.role"
                size="small"
                style="width: 92px"
                :disabled="isSelf(record as UserRecord)"
                :options="[
                  { value: 'user', label: 'user' },
                  { value: 'editor', label: 'editor' },
                  { value: 'admin', label: 'admin' },
                ]"
                @change="(v: unknown) => changeRole(record as UserRecord, v as UserRecord['role'])"
              />
              <a-button
                size="small"
                type="text"
                :disabled="isSelf(record as UserRecord)"
                @click="toggleStatus(record as UserRecord)"
              >
                {{ record.status === 'active' ? $t('users.k3wsi1010') : $t('users.k3xhfg009') }}
              </a-button>
              <a-popconfirm
                :title="$t('users.k1jk2os9001')"
                :disabled="isSelf(record as UserRecord)"
                @confirm="removeUser(record as UserRecord)"
              >
                <a-button
                  size="small"
                  type="text"
                  danger
                  :disabled="isSelf(record as UserRecord)"
                >
                  {{ $t('users.k3xakp005') }}
                </a-button>
              </a-popconfirm>
            </a-space>
          </template>
        </template>
      </a-table>
    </a-card>
  </div>
</template>

<style scoped>
.page-wrap {
  max-width: 1080px;
  margin: 0 auto;
}
.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  margin-bottom: 16px;
}
.page-title {
  display: flex;
  gap: 8px;
  align-items: center;
  margin: 0 0 4px;
  font-size: 24px;
}
.admin-tag { transform: translateY(-2px); }
.page-sub { margin: 0; font-size: 12.5px; opacity: 0.55; }
.gate-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  padding: 56px 24px;
  text-align: center;
}
.gate-icon { font-size: 32px; color: var(--ink-fainter); }
.gate-title { margin: 0; font-size: 15px; font-weight: 600; }
.gate-hint { margin: 0; font-family: var(--font-mono); font-size: 11.5px; color: var(--ink-faint); }
</style>
