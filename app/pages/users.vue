<script setup lang="ts">
const { t } = useI18n()

interface UserRecord {
  key: string
  name: string
  email: string
  role: 'admin' | 'editor' | 'user'
  status: 'active' | 'disabled'
  createdAt: string
}

const roleColor: Record<UserRecord['role'], string> = {
  admin: 'red',
  editor: 'blue',
  user: 'default',
}

const columns = computed(() => [
  { title: t('users.name'), dataIndex: 'name', key: 'name' },
  { title: t('users.email'), dataIndex: 'email', key: 'email' },
  { title: t('users.role'), dataIndex: 'role', key: 'role' },
  { title: t('common.status'), dataIndex: 'status', key: 'status' },
  { title: t('users.created'), dataIndex: 'createdAt', key: 'createdAt' },
  { title: t('common.actions'), key: 'action', width: 140 },
])

const data: UserRecord[] = [
  { key: '1', name: '张伟', email: 'zhangwei@awshop.io', role: 'admin', status: 'active', createdAt: '2026-07-01 09:24' },
  { key: '2', name: '王芳', email: 'wangfang@awshop.io', role: 'editor', status: 'active', createdAt: '2026-07-03 14:10' },
  { key: '3', name: '李娜', email: 'lina@awshop.io', role: 'user', status: 'disabled', createdAt: '2026-07-05 16:42' },
  { key: '4', name: '刘洋', email: 'liuyang@awshop.io', role: 'editor', status: 'active', createdAt: '2026-07-08 11:05' },
  { key: '5', name: '陈静', email: 'chenjing@awshop.io', role: 'user', status: 'active', createdAt: '2026-07-10 08:33' },
  { key: '6', name: 'Michael Chen', email: 'michael@awshop.io', role: 'user', status: 'active', createdAt: '2026-07-12 19:50' },
]

const keyword = ref('')

const filtered = computed(() =>
  data.filter(u =>
    u.name.toLowerCase().includes(keyword.value.toLowerCase())
    || u.email.toLowerCase().includes(keyword.value.toLowerCase()),
  ),
)

function roleLabel(role: UserRecord['role']) {
  return t(`users.role${role.charAt(0).toUpperCase()}${role.slice(1)}`)
}
</script>

<template>
  <div class="page-wrap">
    <div class="page-head">
      <div>
        <h2 class="page-title">
          {{ t('users.title') }}
        </h2>
        <p class="page-sub">
          {{ t('users.subtitle') }}
        </p>
      </div>
      <a-button
        type="primary"
        size="large"
      >
        <template #icon>
          <span class="i-tabler-plus" />
        </template>
        {{ t('users.add') }}
      </a-button>
    </div>

    <a-card
      :bordered="false"
      class="table-card"
    >
      <div class="table-toolbar">
        <a-input
          v-model:value="keyword"
          allow-clear
          :placeholder="t('users.search')"
          class="search-input"
        >
          <template #prefix>
            <span class="i-tabler-search opacity-40" />
          </template>
        </a-input>
        <a-space>
          <a-button>
            <template #icon>
              <span class="i-tabler-filter" />
            </template>
            {{ t('common.all') }}
          </a-button>
          <a-button>
            <template #icon>
              <span class="i-tabler-download" />
            </template>
          </a-button>
        </a-space>
      </div>

      <a-table
        :columns="columns"
        :data-source="filtered"
        :pagination="{ pageSize: 8, showSizeChanger: true }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'">
            <div class="user-cell">
              <a-avatar
                :size="34"
                style="background: var(--color-primary)"
              >
                {{ record.name.charAt(0) }}
              </a-avatar>
              <span class="font-medium">{{ record.name }}</span>
            </div>
          </template>
          <template v-else-if="column.key === 'role'">
            <a-tag :color="roleColor[record.role as UserRecord['role']]">
              {{ roleLabel(record.role as UserRecord['role']) }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'status'">
            <a-badge
              :status="record.status === 'active' ? 'success' : 'default'"
              :text="record.status === 'active' ? t('users.active') : t('users.disabled')"
            />
          </template>
          <template v-else-if="column.key === 'action'">
            <a-space>
              <a-button
                type="link"
                size="small"
              >
                <span class="i-tabler-edit" />
              </a-button>
              <a-popconfirm
                :title="t('users.deleteConfirm')"
                :ok-text="t('common.confirm')"
                :cancel-text="t('common.cancel')"
              >
                <a-button
                  type="link"
                  size="small"
                  danger
                >
                  <span class="i-tabler-trash" />
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
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}

.page-title {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  color: var(--app-text, #1f1f1f);
}

.page-sub {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--app-text-secondary, #999);
}

.table-card {
  overflow: hidden;
  border-radius: 12px;
  box-shadow: 0 1px 8px rgb(0 0 0 / 4%);
}

.table-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.search-input {
  width: 280px;
}

.user-cell {
  display: flex;
  align-items: center;
  gap: 10px;
}
</style>
