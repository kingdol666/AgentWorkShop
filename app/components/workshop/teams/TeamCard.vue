<script setup lang="ts">
/**
 * 编组卡片 —— 名称 / 可见性徽标 / 可见性开关 / 属主 + 成员列表 + 卡片级操作(部署·插件·删除)。
 * 无状态展示件:可写判定(canWrite)与徽标(visTag)由页面算好传入(与拆分前同一份实现),
 * 卡片只发事件,由页面统一落到 useTeamActions / 各 useTeam*Dialog。
 */
import type { TeamDto } from '@/app/composables/workshop/useWorkshopApi'
import type { TeamVisTag } from '@/app/pages/workshop/composables/useTeamsCatalog'
import { seedName } from '@/app/utils/builtin-catalog'

defineProps<{
  team: TeamDto
  vis: TeamVisTag
  canWrite: boolean
}>()

const emit = defineEmits<{
  toggleVisibility: [team: TeamDto, pub: boolean]
  deploy: [team: TeamDto]
  plugins: [team: TeamDto]
  remove: [team: TeamDto]
  addMember: [team: TeamDto]
  removeMember: [team: TeamDto, templateId: string]
}>()

const { t } = useI18n()

/** 内置种子(编组/成员模板)按稳定 id 翻译;自建回退原名(seedName 是共享实现) */
const seedLabel = (x: { id?: string, templateId?: string, name: string }): string => seedName(t, x)
</script>

<template>
  <div class="card">
    <div class="card-head">
      <span class="name">{{ seedLabel(team) }}</span>
      <a-tag
        :color="vis.color"
        class="vis-tag"
      >
        <span
          v-if="vis.icon"
          :class="vis.icon"
        />{{ vis.text }}
      </a-tag>
      <!-- 开关不带文字:左边那枚 tag 已经在说"公开/私有"了(与模板库同一条规则) -->
      <a-switch
        v-if="!team.isBuiltin && canWrite"
        :checked="team.visibility === 'public'"
        size="small"
        :title="team.visibility === 'public' ? $t('teams.toPrivate') : $t('teams.toPublic')"
        @change="(v: unknown) => emit('toggleVisibility', team, v === true)"
      />
      <span class="owner">{{ team.ownerName ?? '-' }}</span>
      <a-dropdown v-if="canWrite">
        <span class="i-tabler-dots op" />
        <template #overlay>
          <a-menu>
            <a-menu-item @click="emit('deploy', team)">
              {{ $t('teams.deployToChannel') }}
            </a-menu-item>
            <a-menu-item @click="emit('plugins', team)">
              {{ $t('teams.k1plugon047') }}
            </a-menu-item>
            <a-menu-item
              danger
              @click="emit('remove', team)"
            >
              {{ $t('teams.k1bpojhf011') }}
            </a-menu-item>
          </a-menu>
        </template>
      </a-dropdown>
      <!-- 用 outlined 而不是 text:text 按钮在卡片头上与旁边的 owner 文本
           长得一模一样,用户看不出这里是**唯一的主操作**(实测三张卡片都如此)。 -->
      <a-button
        v-else
        class="deploy-btn"
        size="small"
        type="default"
        :title="$t('teams.kxheuf1001')"
        @click="emit('deploy', team)"
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
        <span class="member-name">{{ seedLabel(m) }}</span>
        <span class="member-harness">{{ m.harness }}</span>
        <span
          v-if="canWrite"
          class="i-tabler-x rm"
          @click="emit('removeMember', team, m.templateId)"
        />
      </div>
      <a-button
        v-if="canWrite"
        size="small"
        type="dashed"
        block
        @click="emit('addMember', team)"
      >
        {{ $t('teams.krt2oib013') }}
      </a-button>
    </div>
  </div>
</template>

<style scoped>
/* 卡片一族的规则从原 teams.vue 逐字搬来(卡片标记现在归本组件所有,scoped 必须同址);
   .card / .grid 在本页 .vue 里另有一份同样的拷贝给占位卡用 —— 有意重复,不要合并成公共 css。 */
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
.deploy-btn {
  flex: none;
  font-size: 11.5px;
  border-color: var(--line-strong);
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

/* ══ 窄屏(v9):卡片头 / 成员行换行(原 teams.vue 900px 块里属于卡片的规则,逐字复制) ══ */
@media (max-width: 900px) {
  .card-head { flex-wrap: wrap; }
  .member { flex-wrap: wrap; }
  .member-harness { font-size: 11.5px; }
}
</style>
