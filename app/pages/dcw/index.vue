<script setup lang="ts">
/**
 * 产线运营控制台(DCW Console)—— /dcw 总览页。
 * 后端能力自描述 + 产线清单(状态/产品/Recipe 计数)、卡片上的快捷启停、
 * 产线增删改与控制模板目录;点进 /dcw/[id] 进入单产线专业控制台。
 *
 * 页面只做编排:数据/动作在 composables,栅格与弹窗在 components,
 * 样式在 dcw-page.css(与原 <style scoped> 逐字一致的全局层)。
 */
import { computed, ref } from 'vue'
import { DCW_LINE_COLORS } from '#shared/dcw-protocol'
import { useDcwStream } from '~/composables/workshop/useDcwStream'
import { useDcwCards } from './composables/useDcwCards'
import { useDcwFilter } from './composables/useDcwFilter'
import { useDcwLineMutations } from './composables/useDcwLineMutations'
import { useDcwQuickActions } from './composables/useDcwQuickActions'
import './dcw-page.css'

const { t } = useI18n()

const dcw = useDcwStream()
void dcw.load()

// ---------- 产线总览(卡片/未归属计数) ----------
const { cards, unassignedCount, recipesOf } = useDcwCards()

// ---------- 清单筛选(94 条历史线的管理页:导航先于遍历) ----------
const { filterState, searchText, runningCount, shownCards } = useDcwFilter(cards)

// ---------- 新建产线(默认色按现有产线数轮转) ----------
const nextColor = computed(() => DCW_LINE_COLORS[dcw.lines.length % DCW_LINE_COLORS.length] ?? '#3aa0ff')

// ---------- 新建/编辑/删除与卡片快捷启停 ----------
const { createOpen, createSaving, createError, openCreate, doCreateLine, editOpen, editSaving, editError, editTarget, openEdit, doEditLine, delOpen, delBusy, delErr, delPurge, delCard, openDelete, doDeleteLine } = useDcwLineMutations()
const { quickBusy, quickErr, quickPick, quickStart, quickStop } = useDcwQuickActions(t)

// ---------- 控制模板管理 ----------
const tplOpen = ref(false)
</script>

<template>
  <div class="page">
    <div class="aw-page-head">
      <div>
        <p class="aw-kicker">
          AGENTWORKSHOP / LINE OPERATIONS
        </p>
        <h1>{{ $t('dcw.k1b2tk5c009') }}</h1>
        <p class="sub">
          {{ $t('dcw.k5q0aqi010') }}
        </p>
      </div>
      <div class="badges mono">
        <span
          v-if="unassignedCount"
          class="badge warn-badge"
          :title="$t('dcw.k1i5a9vw001')"
        >{{ $t('dcw.k3ootr6049') }} {{ unassignedCount }}</span>
        <span class="badge">{{ $t('dcw.k3wj9n050') }} {{ dcw.lines.length }}</span>
        <button
          class="badge tpl-btn"
          @click="tplOpen = true"
        >
          {{ $t('dcw.k11nndsp051') }} {{ dcw.templates.length }}
        </button>
      </div>
    </div>

    <p
      v-if="quickErr"
      class="banner bad"
    >
      {{ quickErr }}
    </p>

    <!-- 清单筛选:状态分段 + 名称搜索(复用 aw-seg / 页内 inp 语言) -->
    <div class="fleet-filter">
      <div class="aw-seg">
        <button
          :class="{ on: filterState === 'all' }"
          @click="filterState = 'all'"
        >
          {{ $t('common.all') }} {{ cards.length }}
        </button>
        <button
          :class="{ on: filterState === 'running' }"
          @click="filterState = 'running'"
        >
          {{ $t('dcw.k1eox1el055') }} {{ runningCount }}
        </button>
        <button
          :class="{ on: filterState === 'idle' }"
          @click="filterState = 'idle'"
        >
          {{ $t('dcw.k149r6y7059') }} {{ cards.length - runningCount }}
        </button>
      </div>
      <input
        v-model="searchText"
        class="inp fleet-search"
        type="search"
        :placeholder="$t('dcw.filterSearchPh')"
      >
    </div>

    <!-- 产线卡片栅格 -->
    <div class="line-grid aw-stagger">
      <DcwLineCard
        v-for="c in shownCards"
        :key="c.line.id"
        v-model:pick="quickPick[c.line.id]"
        :card="c"
        :state="dcw.lineStateOf(c.line.id)"
        :recipes="recipesOf(c.line.id)"
        :quick-busy="quickBusy"
        @edit="openEdit"
        @remove="openDelete"
        @start="quickStart"
        @stop="quickStop"
      />

      <!-- 新建产线卡 -->
      <button
        class="line-card new-card"
        @click="openCreate"
      >
        <span class="i-tabler-plus" />
        {{ $t('dcw.k1efe391017') }}
        <small>{{ $t('dcw.k19dlbli053') }}</small>
      </button>
    </div>

    <p
      v-if="dcw.loaded && dcw.lines.length === 0"
      class="banner"
    >
      {{ $t('dcw.k1sk85vs018') }}
    </p>
    <p
      v-else-if="dcw.loaded && shownCards.length === 0"
      class="banner"
    >
      {{ $t('dcw.filterEmpty') }}
    </p>

    <DcwCreateLineModal
      v-model:open="createOpen"
      :saving="createSaving"
      :error="createError"
      :next-color="nextColor"
      @submit="doCreateLine"
      @close="createOpen = false"
    />

    <DcwEditLineModal
      v-model:open="editOpen"
      :card="editTarget"
      :saving="editSaving"
      :error="editError"
      :next-color="nextColor"
      @submit="doEditLine"
      @close="editOpen = false"
    />

    <DcwDeleteLineModal
      v-model:open="delOpen"
      v-model:purge="delPurge"
      :card="delCard"
      :busy="delBusy"
      :error="delErr"
      @confirm="doDeleteLine"
      @close="delOpen = false"
    />

    <DcwTemplateModal v-model:open="tplOpen" />

    <p
      v-if="dcw.error"
      class="banner bad"
    >
      {{ dcw.error }}
    </p>
  </div>
</template>
