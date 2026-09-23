<script setup lang="ts">
/**
 * 「新建 AgentTeam」弹窗 —— 名称 / 描述 / 可见性 + 创建时勾选的平台插件开关。
 * 表单与插件清单在 useTeamCreateDialog;创建成功 → created 事件,由页面 reload 编组目录。
 */
import { useTeamCreateDialog } from '@/app/pages/workshop/composables/useTeamCreateDialog'

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ created: [] }>()

const { createForm, platformPlugins, pluginChecked, submit } = useTeamCreateDialog({
  open,
  onCreated: () => emit('created'),
})
</script>

<template>
  <a-modal
    v-model:open="open"
    :title="$t('teams.k1efmuyx002')"
    :ok-text="$t('common.create')"
    :cancel-text="$t('common.cancel')"
    @ok="submit"
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
      <a-form-item
        v-if="platformPlugins.length"
        :label="$t('teams.k1plugon041')"
      >
        <a-checkbox-group
          v-model:value="pluginChecked"
          class="plug-create-group"
        >
          <a-checkbox
            v-for="p in platformPlugins"
            :key="p.name"
            :value="p.name"
          >
            <span class="aw-mono">{{ p.name }}</span>
            <span
              v-if="p.builtin"
              class="plug-builtin-tag"
            >{{ $t('teams.k3x23c018') }}</span>
          </a-checkbox>
        </a-checkbox-group>
        <div class="plug-hint">
          {{ $t('teams.k1plugon042') }}
        </div>
      </a-form-item>
    </a-form>
  </a-modal>
</template>

<style scoped>
/* ===== 插件开关 · 创建勾选侧(原 teams.vue「插件开关」注释块的前半) =====
   .plug-builtin-tag / .plug-hint 在团队插件弹层里另有一份同样的拷贝 —— 有意重复,
   两处标记分属两个组件,scoped 样式不能外移成公共 css。 */
.plug-create-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
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
</style>
