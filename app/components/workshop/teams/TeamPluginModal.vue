<script setup lang="ts">
/**
 * 「团队插件开关」弹层 —— 逐插件开关(切换即 PUT 全量视图),无 footer。
 * 开关视图/来源提示/保存中标记在 useTeamPluginDialog;当前编组由页面在菜单点击时写入。
 */
import type { TeamDto } from '@/app/composables/workshop/useWorkshopApi'
import { useTeamPluginDialog } from '@/app/pages/workshop/composables/useTeamPluginDialog'

const props = defineProps<{ team: TeamDto | null }>()

const open = defineModel<boolean>('open', { default: false })

const { rows, source, loading, saving, toggle } = useTeamPluginDialog({
  open,
  teamId: () => props.team?.id,
})
</script>

<template>
  <a-modal
    v-model:open="open"
    :title="$t('teams.k1plugon040', { p0: team?.name ?? '' })"
    :footer="null"
  >
    <a-spin :spinning="loading">
      <p class="plug-source">
        <template v-if="source === 'explicit'">
          {{ $t('teams.k1plugon045') }}
        </template>
        <template v-else>
          {{ $t('teams.k1plugon044') }}
        </template>
      </p>
      <div
        v-for="row in rows"
        :key="row.name"
        class="plug-row"
      >
        <div class="plug-text">
          <div class="plug-name">
            <span class="aw-mono">{{ row.name }}</span>
            <span
              v-if="row.builtin"
              class="plug-builtin-tag"
            >{{ $t('teams.k3x23c018') }}</span>
          </div>
          <div class="plug-desc">
            {{ row.description || '—' }}
          </div>
        </div>
        <a-switch
          :checked="row.enabled"
          size="small"
          :loading="saving === row.name"
          @change="(v: unknown) => toggle(row, v === true)"
        />
      </div>
      <div
        v-if="rows.length === 0 && !loading"
        class="plug-hint"
      >
        {{ $t('teams.k1plugon046') }}
      </div>
    </a-spin>
  </a-modal>
</template>

<style scoped>
/* ===== 插件开关 · 团队弹层侧(原 teams.vue「插件开关」注释块的后半) =====
   .plug-builtin-tag / .plug-hint 在创建弹窗里另有一份同样的拷贝 —— 有意重复,
   两处标记分属两个组件,scoped 样式不能外移成公共 css。 */
.plug-builtin-tag {
  margin-left: 6px;
  padding: 0 6px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--ink-faint);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-pill, 999px);
}
.plug-hint {
  margin-top: 6px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--ink-faint);
}
.plug-source {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--ink-faint);
}
.plug-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 10px 0;
  border-bottom: 1px solid var(--line);
}
.plug-row:last-of-type {
  border-bottom: 0;
}
.plug-text {
  min-width: 0;
}
.plug-name {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 13px;
  font-weight: 500;
}
.plug-desc {
  margin-top: 2px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--ink-faint);
}
</style>
