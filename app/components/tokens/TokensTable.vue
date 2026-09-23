<script setup lang="ts">
/**
 * Token 列表表:标签 / Token(掩码 ↔ 明文) / 创建时间 / 最近使用 / 操作。
 *
 * 纯呈现:行数据是页面持有的服务端快照切片,组件不取数、不订阅、不持有明文 ——
 * 明文映射(revealedPlain)的唯一持有者是页面的 useTokenReveal,这里只按它决定
 * 掩码还是明文,并把眼睛切换/复制的意图上报回页面。
 * 无明文是常态(0.7.10 起 token 只存哈希),此时两个行内按钮都不出现。
 */
import type { TokenMeta } from '@/app/stores/workshop/user'
import { isRevealedIn } from '@/app/pages/tokens/composables/useTokenReveal'

const props = defineProps<{
  /** TokenMeta 行(页面持有的快照切片) */
  rows: TokenMeta[]
  /** 快照加载中 */
  loading: boolean
  /** 当前会话 token 的 id(命中则该行打「当前」标记、吊销提示语不同) */
  currentTokenId?: string
  /** 已按需拉取到明文的行(id → 明文);仅内存,刷新即隐 */
  revealedPlain: Record<string, string>
  /** 正在拉取明文的行 id(眼睛按钮 loading) */
  revealingId: string
  /** 刚复制成功的行 id(勾选图标 1.6s) */
  copyId: string
}>()

const emit = defineEmits<{
  /** 重命名该行(record 放宽为结构化类型以兼容 a-table 的 record) */
  rename: [row: { id?: string, label?: string }]
  /** 吊销该行(二次确认已在 popconfirm 内完成) */
  revoke: [row: { id?: string }]
  /** 眼睛切换:已明文 → 遮回,否则懒拉取存档明文 */
  reveal: [row: TokenMeta]
  /** 复制该行明文(优先用已展开明文,否则先静默拉取) */
  copy: [row: TokenMeta]
}>()

const { t: tt } = useI18n()

const isRevealed = (id: string): boolean => isRevealedIn(props.revealedPlain, id)

const rowDisplay = (t: TokenMeta): string => {
  if (isRevealed(t.id)) return props.revealedPlain[t.id]!
  return t.preview ?? `ut-${'•'.repeat(14)}`
}

const fmt = (s: string | null): string => (s ? s.replace('T', ' ').slice(0, 19) : '-')

const columns = [
  { title: tt('tokens.k41416002'), key: 'label', dataIndex: 'label' },
  { title: 'Token', key: 'token', width: 360 },
  { title: tt('tokens.k1bg95gk023'), key: 'createdAt', dataIndex: 'createdAt', width: 170 },
  { title: tt('tokens.k1euotul024'), key: 'lastUsedAt', dataIndex: 'lastUsedAt', width: 200 },
  { title: tt('tokens.k40aa6025'), key: 'action', width: 170 },
]
</script>

<template>
  <a-card
    :bordered="false"
    class="table-card"
  >
    <a-spin :spinning="loading">
      <a-table
        :columns="columns"
        :data-source="rows"
        :pagination="false"
        row-key="id"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'label'">
            <a-space>
              <span class="i-tabler-key text-primary" />
              <span class="font-medium">{{ record.label || $t('tokens.kj3mklm028') }}</span>
              <a-tag
                v-if="record.id === currentTokenId"
                color="green"
              >
                {{ $t('tokens.k1defr98007') }}
              </a-tag>
            </a-space>
          </template>
          <template v-else-if="column.key === 'token'">
            <div class="tok-cell">
              <code
                class="tok-val"
                :class="{ revealed: isRevealed(record.id) }"
                :title="isRevealed(record.id) ? $t('tokens.maskBackTip') : $t('tokens.maskPreview')"
              >{{ rowDisplay(record as TokenMeta) }}</code>
              <a-button
                v-if="record.hasPlain"
                type="text"
                size="small"
                class="tok-op"
                :loading="revealingId === record.id"
                :title="isRevealed(record.id) ? $t('tokens.maskBack') : $t('tokens.revealPlain')"
                @click="emit('reveal', record as TokenMeta)"
              >
                <span :class="isRevealed(record.id) ? 'i-tabler-eye-off' : 'i-tabler-eye'" />
              </a-button>
              <a-button
                v-if="record.hasPlain"
                type="text"
                size="small"
                class="tok-op"
                :class="{ ok: copyId === record.id }"
                :title="copyId === record.id ? $t('tokens.copied') : $t('tokens.copyPlain')"
                @click="emit('copy', record as TokenMeta)"
              >
                <span :class="copyId === record.id ? 'i-tabler-check' : 'i-tabler-copy'" />
              </a-button>
            <!-- 0.7.10 起 token 只存哈希:无明文是常态,不再打「旧版不可见」标签 -->
            </div>
          </template>
          <template v-else-if="column.key === 'createdAt'">
            {{ fmt(record.createdAt) }}
          </template>
          <template v-else-if="column.key === 'lastUsedAt'">
            {{ fmt(record.lastUsedAt) }}
          </template>
          <template v-else-if="column.key === 'action'">
            <a-space>
              <a-button
                type="link"
                size="small"
                @click="emit('rename', record)"
              >
                <span class="i-tabler-edit" />
                {{ $t('tokens.k3vrpcs009') }}
              </a-button>
              <a-popconfirm
                :title="record.id === currentTokenId ? $t('tokens.revokeCurrentWarn') : $t('tokens.revokeWarn')"
                :ok-text="$t('common.revoke')"
                :cancel-text="$t('common.cancel')"
                @confirm="emit('revoke', record)"
              >
                <!-- 安静文本按钮:常态墨灰,悬停转红 —— 红色只留给真实确认瞬间,不再整行批发 -->
                <a-button
                  type="text"
                  size="small"
                  class="tok-revoke"
                >
                  <span class="i-tabler-trash" />
                  {{ $t('tokens.k3xmrz010') }}
                </a-button>
              </a-popconfirm>
            </a-space>
          </template>
        </template>
      </a-table>
    </a-spin>
  </a-card>
</template>

<style scoped>
.table-card { margin-bottom: 16px; }

/* ===== 列表行 token 单元格 ===== */
.tok-cell {
  display: flex;
  gap: 2px;
  align-items: center;
  min-width: 0;
}

.tok-val {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  padding: 3px 8px;
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 0.02em;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-soft);
  background: var(--paper-deep);
  border: 1px solid var(--line);
  border-radius: var(--radius-chip);
}

.tok-val.revealed {
  color: var(--accent);
  user-select: all;
}

.tok-op {
  flex: 0 0 auto;
  color: var(--ink-faint);
}

.tok-op:hover {
  color: var(--accent);
}

.tok-op.ok {
  color: var(--tone-success-dot);
}

/* 标签列遗留样式:模板里已无 .legacy-tag 标记(0.7.10 起不打「旧版不可见」标签),
   按「scoped 规则逐条仍在场」原样保留,不顺手删除。 */
.legacy-tag {
  flex: 0 0 auto;
  margin-left: 4px;
  font-size: 10px;
  line-height: 16px;
}

.text-primary { color: var(--accent); }

/* ══ 窄屏(v9):token 表格横向卷轴 + 首列可读 ═════════════════════════════
   原页面把这三条锚在页面根的 `.page` 上;表格标记(卡片/表格/单元格)现在归本组件,
   锚点随之落到本组件根元素的 `.table-card`(`:deep` 从这里往表格内部匹配),
   选择器与声明逐字保留 —— 表格始终在卡片内,匹配范围不变。 */
@media (max-width: 900px) {
  .table-card :deep(.ant-table-content) table { min-width: 880px; }

  .table-card :deep(.ant-table-thead > tr > th:first-child),
  .table-card :deep(.ant-table-tbody > tr > td:first-child) { min-width: 132px; }
}

@media (max-width: 640px) {
  .table-card :deep(.ant-table) .ant-btn-sm { min-height: 32px; }
  .tok-op { min-width: 32px; }
}
</style>
