<script setup lang="ts">
/**
 * 「部署到 Channel」弹窗 —— 选目标 Channel,确认后把整个编组 deploy 过去。
 * 选择态与 confirm-loading 在 useTeamDeployDialog;Channel 清单由页面下发(与目录同一份)。
 */
import type { ChannelDto, TeamDto } from '@/app/composables/workshop/useWorkshopApi'
import { useTeamDeployDialog } from '@/app/pages/workshop/composables/useTeamDeployDialog'

const props = defineProps<{
  team: TeamDto | null
  channels: ChannelDto[]
}>()

const open = defineModel<boolean>('open', { default: false })

const { deployChannelId, deploying, submit } = useTeamDeployDialog({
  open,
  teamId: () => props.team?.id,
})
</script>

<template>
  <a-modal
    v-model:open="open"
    :title="$t('teams.k1c0o6oe030', { p0: team?.name ?? '' })"
    :confirm-loading="deploying"
    :ok-text="$t('teams.deployOk')"
    :cancel-text="$t('common.cancel')"
    @ok="submit"
  >
    <a-form layout="vertical">
      <a-form-item :label="$t('teams.targetChannelLabel')">
        <a-select
          v-model:value="deployChannelId"
          :options="channels.map(c => ({ value: c.id, label: c.name }))"
        />
      </a-form-item>
    </a-form>
  </a-modal>
</template>
