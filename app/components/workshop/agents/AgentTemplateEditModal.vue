<script setup lang="ts">
/**
 * 「新建 / 编辑 Agent 模板」弹窗 —— 名称 / harness(下拉带可用性探测 + 能力矩阵徽标) /
 * 可见性 / config JSON。
 * 表单与提交在 useAgentTemplateForm(由本组件调用,成功后再 emit saved 让页面 reload);
 * harness 的派生数据(下拉项·可用性·元信息·能力徽标)由页面(useAgentHarnessOptions)
 * 统一算好传入 —— 与表格共用同一份,这里不二次派生。
 */
import type { AgentTemplateDto, HarnessMetaDto } from '@/app/composables/workshop/useWorkshopApi'
import type { HarnessOption } from '@/app/pages/workshop/composables/useAgentHarnessOptions'
import { useAgentTemplateForm } from '@/app/pages/workshop/composables/useAgentTemplateForm'

const open = defineModel<boolean>('open', { default: false })
const props = defineProps<{
  editing: AgentTemplateDto | null
  harnesses: HarnessMetaDto[]
  harnessOptions: HarnessOption[]
  harnessMeta: (id: string) => HarnessMetaDto | undefined
  isUnavailable: (id: string) => boolean
  capBadges: (id: string) => string[]
}>()
const emit = defineEmits<{ saved: [] }>()

const { t: tt } = useI18n()

const { form, save } = useAgentTemplateForm({
  open,
  editing: () => props.editing,
  isUnavailable: props.isUnavailable,
  harnessMeta: props.harnessMeta,
  onSaved: () => emit('saved'),
})
</script>

<template>
  <a-modal
    v-model:open="open"
    :title="editing ? $t('agents.editTpl') : $t('agents.newTpl')"
    :ok-text="$t('common.save')"
    :cancel-text="$t('common.cancel')"
    @ok="save"
  >
    <a-form layout="vertical">
      <a-form-item :label="$t('agents.k3xhia001')">
        <a-input v-model:value="form.name" />
      </a-form-item>
      <a-form-item label="harness">
        <a-select
          v-model:value="form.harness"
          :options="harnessOptions"
        >
          <template #option="{ value, label }">
            <span
              class="h-opt"
              :class="{ off: isUnavailable(String(value)) }"
            >
              <span class="h-opt-dot" /> {{ label }}
            </span>
          </template>
        </a-select>
        <div
          v-if="harnesses.length > 0"
          class="harness-status"
          :class="{ off: isUnavailable(form.harness) }"
        >
          <template v-if="isUnavailable(form.harness)">
            <span class="i-tabler-plug-off" /> {{ harnessMeta(form.harness)?.error }}
            <a
              v-if="harnessMeta(form.harness)?.homepage"
              class="h-install"
              :href="harnessMeta(form.harness)?.homepage"
              target="_blank"
              rel="noopener"
            >{{ tt('agents.installLink') }}</a>
          </template>
          <template v-else-if="harnessMeta(form.harness)?.inprocess">
            <span class="i-tabler-plug-connected" /> {{ tt('agents.harnessInprocess') }}
          </template>
          <template v-else-if="harnessMeta(form.harness)?.resolvedPath">
            <span class="i-tabler-plug-connected" /> <span class="mono">{{ harnessMeta(form.harness)?.resolvedPath }}</span>
          </template>
        </div>
        <div
          v-if="capBadges(form.harness).length"
          class="harness-caps"
        >
          <span
            v-for="b in capBadges(form.harness)"
            :key="b"
            class="harness-cap"
          >{{ b }}</span>
        </div>
      </a-form-item>
      <a-form-item :label="$t('agents.k3lrqn0002')">
        <a-radio-group v-model:value="form.visibility">
          <a-radio value="private">
            {{ $t('agents.k17jfge3015') }}
          </a-radio>
          <a-radio value="public">
            {{ $t('agents.k1tt5zyo016') }}
          </a-radio>
        </a-radio-group>
      </a-form-item>
      <a-form-item :label="$t('agents.configLabel')">
        <a-textarea
          v-model:value="form.configJson"
          :rows="6"
        />
      </a-form-item>
    </a-form>
  </a-modal>
</template>

<style scoped>
.harness-caps { margin-top: 6px; display: flex; gap: 4px; flex-wrap: wrap; }
.harness-cap {
  font-size: 11px;
  line-height: 18px;
  padding: 0 6px;
  border: 1px solid var(--border, #2a3a4a);
  border-radius: 3px;
  opacity: 0.75;
}
.h-opt { display: inline-flex; align-items: center; gap: 7px; }
.h-opt-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--tone-success-dot, #4a6b57); }
.h-opt.off .h-opt-dot { background: var(--tone-danger-dot, #c25a4e); }
.h-opt.off { opacity: 0.6; }
.h-install { margin-left: 8px; color: var(--accent); text-decoration: none; }
.h-install:hover { text-decoration: underline; }
.harness-status {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-top: 6px;
  font-size: 11px;
  color: var(--ink-faint);
}
.harness-status.off { color: var(--danger, #c25a4e); }
</style>
