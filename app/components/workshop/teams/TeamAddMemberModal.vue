<script setup lang="ts">
/**
 * 「加入成员」弹窗 —— 选成员模板(引擎未安装的禁用)+ 选角色(worker/lead)。
 * 选择态在 useTeamAddMemberDialog(打开即重置);模板选项由页面下发(memberOptions),
 * 当前编组由页面在点「添加成员」时写入。
 */
import type { TeamDto } from '@/app/composables/workshop/useWorkshopApi'
import type { TeamMemberOption } from '@/app/pages/workshop/composables/useTeamsCatalog'
import { useTeamAddMemberDialog } from '@/app/pages/workshop/composables/useTeamAddMemberDialog'

const props = defineProps<{
  team: TeamDto | null
  memberOptions: TeamMemberOption[]
}>()

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ added: [] }>()

const { addTemplateId, addRole, submit } = useTeamAddMemberDialog({
  open,
  teamId: () => props.team?.id,
  onAdded: () => emit('added'),
})
</script>

<template>
  <a-modal
    v-model:open="open"
    :title="$t('teams.k6ljhyv029', { p0: team?.name ?? '' })"
    :ok-text="$t('teams.joinOk')"
    :cancel-text="$t('common.cancel')"
    @ok="submit"
  >
    <a-form layout="vertical">
      <a-form-item :label="$t('teams.k41ds5006')">
        <a-select
          v-model:value="addTemplateId"
          :options="memberOptions"
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
</template>
