<script setup lang="ts">
/**
 * AgentTeam 编组库:用户级隔离的编组 CRUD + 成员管理 + 一键 deploy 到 Channel。
 * v10 可见性:private 仅本人;public 全员可读可用(仅属主可改删);内置(锁)不可变更。
 * admin:全量视图(含他人私有),附创建者;可改删任意非内置编组。
 *
 * 本页只做编排:目录/派生视图态在 composables/useTeamsCatalog,卡片即时写操作在
 * composables/useTeamActions,四个弹窗的开关与 payload 在 composables/useTeamDialogState,
 * 各弹窗自己的表单与提交在 useTeam*Dialog(由弹窗组件调用,成功后再 emit 回来 reload)。
 * 展示件:components/workshop/teams/**。
 */
import TeamAddMemberModal from '@/app/components/workshop/teams/TeamAddMemberModal.vue'
import TeamCard from '@/app/components/workshop/teams/TeamCard.vue'
import TeamCreateModal from '@/app/components/workshop/teams/TeamCreateModal.vue'
import TeamDeployModal from '@/app/components/workshop/teams/TeamDeployModal.vue'
import TeamPluginModal from '@/app/components/workshop/teams/TeamPluginModal.vue'
import { useTeamActions } from './composables/useTeamActions'
import { useTeamDialogState } from './composables/useTeamDialogState'
import { useTeamsCatalog } from './composables/useTeamsCatalog'

const { t } = useI18n()

definePageMeta({ layout: 'default' })

const { teams, channels, loading, load, memberOptions, filter, shown, canWrite, visTag, isAdmin } = useTeamsCatalog()
const { toggleVisibility, removeMember, removeTeam } = useTeamActions({ reload: load })
const {
  createOpen,
  addOpen,
  addTeam,
  openAdd,
  deployOpen,
  deployTeam,
  openDeploy,
  plugOpen,
  plugTeam,
  openPlugins,
} = useTeamDialogState()

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
        v-if="isAdmin"
        class="admin-note"
      ><span class="i-tabler-shield-check" /> {{ $t('teams.k1bpgi8h010') }}</span>
    </div>

    <a-spin :spinning="loading">
      <div class="grid">
        <TeamCard
          v-for="team in shown"
          :key="team.id"
          :team="team"
          :vis="visTag(team)"
          :can-write="canWrite(team)"
          @toggle-visibility="toggleVisibility"
          @deploy="openDeploy"
          @plugins="openPlugins"
          @remove="removeTeam"
          @add-member="openAdd"
          @remove-member="removeMember"
        />
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

    <TeamCreateModal
      v-model:open="createOpen"
      @created="load"
    />

    <TeamAddMemberModal
      v-model:open="addOpen"
      :team="addTeam"
      :member-options="memberOptions"
      @added="load"
    />

    <TeamDeployModal
      v-model:open="deployOpen"
      :team="deployTeam"
      :channels="channels"
    />

    <TeamPluginModal
      v-model:open="plugOpen"
      :team="plugTeam"
    />
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
/* 卡片本体的规则现在归 TeamCard.vue;这里只为同一网格里的占位卡留一份逐字拷贝 ——
   有意重复(scoped 样式不能外移成公共 css),改卡片外观时两处要一起改。 */
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

/* ══ 窄屏(v9):页头纵向堆叠 / 筛选条换行 / 卡片单列 ══════════════════════
   卡片内部的换行规则在 TeamCard.vue(同一断点,逐字复制)。 */
@media (max-width: 900px) {
  .head {
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
  }

  .head > div { min-width: 0; }
  .head h2 { font-size: 21px; line-height: 1.25; }

  .head :deep(.ant-space) {
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: stretch;
    width: 100%;
  }

  .head :deep(.ant-space-item) { width: 100%; }
  .head :deep(.ant-btn) { width: 100%; min-height: 40px; }

  .toolbar {
    flex-wrap: wrap;
    gap: 8px;
  }

  .toolbar :deep(.ant-segmented) {
    flex: 1 1 100%;
    min-width: 0;
  }

  .admin-note {
    flex: 1 1 100%;
    min-width: 0;
    font-size: 11.5px;
    line-height: 1.5;
  }

  .grid { grid-template-columns: 1fr; }
}

@media (max-width: 640px) {
  .page { padding: 0; }
  .head h2 { font-size: 19px; }
  .sub { font-size: 11.5px; line-height: 1.5; }
}
</style>
