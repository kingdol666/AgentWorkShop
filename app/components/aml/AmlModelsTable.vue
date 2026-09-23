<script setup lang="ts">
/**
 * 模型注册表:阶段徽标 + 指标 + 两段确认晋升。
 * 备注编辑框与数据集表共用页面上的同一个编辑槽(noteDraft 经 v-model 回流)。
 */
import { promoteActionOf } from '../../pages/aml/constants'
import { useAmlFormat } from '../../pages/aml/composables/useAmlFormat'
import type { AmlModelRow, AmlModelStage } from '../../pages/aml/types'

defineProps<{
  models: AmlModelRow[]
  noteEditing: string
  confirmPromote: string
  promoting: string
}>()

defineEmits<{
  reload: []
  editNote: [id: string, note: string]
  saveNote: [id: string]
  cancelNote: []
  promote: [model: AmlModelRow, to: Exclude<AmlModelStage, 'candidate'>]
  remove: [id: string, confirmText: string]
}>()

/** 行内备注草稿:与数据集表共享同一个编辑槽,值经 v-model 回流页面 */
const noteDraft = defineModel<string>('noteDraft', { required: true })

const { fmtTime, fmtNum, shortId } = useAmlFormat()
</script>

<template>
  <section class="aw-tile zone">
    <div class="zone-head">
      <h2>
        <span class="i-tabler-cube-3d-sphere" />
        {{ $t('aml.k1amlx123') }}
        <b class="mono cnt">{{ models.length }}</b>
      </h2>
      <button
        class="mini-btn"
        @click="$emit('reload')"
      >
        {{ $t('aml.k1amlx017') }}
      </button>
    </div>
    <div
      v-if="models.length"
      class="tbl-scroll"
    >
      <table class="tbl tbl-models">
        <thead>
          <tr>
            <th>{{ $t('aml.k1amlx125') }}</th>
            <th>{{ $t('aml.k1amlx021') }}</th>
            <th>{{ $t('aml.k1amlx022') }}</th>
            <th>{{ $t('aml.k1amlx078') }}</th>
            <th :title="$t('aml.k1amlx126')">
              {{ $t('aml.k1amlx099') }}
            </th>
            <th>{{ $t('aml.k1amlx020') }}</th>
            <th>{{ $t('aml.k1amlx026') }}</th>
            <th class="right">
              {{ $t('aml.k1amlx127') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="m in models"
            :key="m.id"
          >
            <td class="mono">
              {{ shortId(m.id) }}
            </td>
            <td class="mono dim">
              {{ shortId(m.productId) }}
            </td>
            <td class="mono dim">
              {{ shortId(m.recipeId) }}
            </td>
            <td>
              <span
                class="stage-pill"
                :class="m.stage"
              >{{ m.stage }}</span>
            </td>
            <td class="mono dim">
              {{ $t('aml.k1amlx116') }} {{ fmtNum(m.metrics?.oneStepTest?.nrmse) }} · {{ $t('aml.k1amlx117') }} {{ fmtNum(m.metrics?.rolloutTest?.nrmse) }}
            </td>
            <td class="mono dim">
              {{ fmtTime(m.createdAt) }}
            </td>
            <td
              class="note-cell"
              @click.stop
            >
              <div
                v-if="noteEditing === m.id"
                class="note-edit"
              >
                <input
                  v-model="noteDraft"
                  :placeholder="$t('aml.k1amlx189')"
                  @keyup.enter="$emit('saveNote', m.id)"
                  @keyup.esc="$emit('cancelNote')"
                >
                <button
                  class="mini-btn"
                  @click="$emit('saveNote', m.id)"
                >
                  {{ $t('aml.k1amlx191') }}
                </button>
                <button
                  class="mini-btn"
                  @click="$emit('cancelNote')"
                >
                  {{ $t('aml.k1amlx202') }}
                </button>
              </div>
              <span
                v-else
                class="note-text"
              >
                <span
                  class="note"
                  :title="m.note"
                >{{ m.note || '--' }}</span>
                <span
                  class="i-tabler-pencil edit-i"
                  :title="$t('aml.k1amlx189')"
                  @click="$emit('editNote', m.id, m.note)"
                />
              </span>
            </td>
            <td class="right acts">
              <template
                v-for="a in promoteActionOf(m)"
                :key="a.to"
              >
                <button
                  class="mini-btn"
                  :class="{ danger: a.to === 'retired' }"
                  :disabled="promoting === `${m.id}:${a.to}`"
                  @click="$emit('promote', m, a.to)"
                >
                  {{ confirmPromote === `${m.id}:${a.to}` ? $t('aml.k1amlx131') : $t(a.key) }}
                </button>
              </template>
              <span
                v-if="promoteActionOf(m).length === 0"
                class="dim"
              >--</span>
              <span
                class="i-tabler-trash edit-i"
                :title="$t('aml.k1amlx190')"
                @click="$emit('remove', m.id, $t('aml.k1amlx199'))"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p
      v-else
      class="empty"
    >
      {{ $t('aml.k1amlx124') }}
    </p>
  </section>
</template>

<style scoped src="../../pages/aml/styles.css"></style>
