<script setup lang="ts">
/**
 * 未分配资产收编(历史节点/产品迁移到本产线)—— 无未分配资产时整块不渲染。
 */
import type { DcwNodeView, ProductView } from '#shared/dcw-protocol'

defineProps<{
  unassignedNodes: DcwNodeView[]
  unassignedProducts: ProductView[]
}>()

const emit = defineEmits<{
  'adopt-node': [id: string]
  'adopt-product': [id: string]
}>()
</script>

<template>
  <section
    v-if="unassignedNodes.length || unassignedProducts.length"
    class="aw-tile adopt-card"
  >
    <b class="adopt-title">{{ $t('dcwDetail.kaebkky022') }}</b>
    <div class="adopt-list">
      <span
        v-for="n in unassignedNodes"
        :key="n.id"
        class="adopt-chip"
      >
        {{ n.name }}
        <button
          class="mini-btn"
          @click="emit('adopt-node', n.id)"
        >
          {{ $t('dcwDetail.kyjp9fg023') }}
        </button>
      </span>
      <span
        v-for="p in unassignedProducts"
        :key="p.id"
        class="adopt-chip"
      >
        {{ p.name }}({{ $t('dcwDetail.k3km252140') }}<button
          class="mini-btn"
          @click="emit('adopt-product', p.id)"
        >
          {{ $t('dcwDetail.kyjp9fg023') }}
        </button>
      </span>
    </div>
  </section>
</template>

<style scoped>
/* 共享工具类随标记搬入本组件:scoped 的 data-v 归属不跨组件,
   凡在多组件出现的规则(.mono/.dim/.inp/.mini-btn/.modal-mask/.banner/.nodes-table/.sec-label/.st-pill 等)
   在此各持一份逐字相同的副本,以保证每个元素命中的声明集与拆分前一致,同时不引入任何全局选择器。 */

.adopt-card { display: flex; gap: 12px; align-items: flex-start; flex-wrap: wrap; }
.adopt-title { font-size: 12px; color: var(--aw-dim, #8fa0b5); flex: none; padding-top: 4px; }
.adopt-list { display: flex; gap: 8px; flex-wrap: wrap; }
.adopt-chip {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  padding: 4px 8px;
  font-size: 11.5px;
  color: #e8eef8;
  background: rgba(13, 20, 32, 0.7);
  border: 1px solid rgba(60, 80, 110, 0.5);
  border-radius: 8px;
}

.mini-btn { margin-right: 4px; }
.mini-btn.danger { color: var(--tone-danger-dot); }
.mini-btn:hover { border-color: var(--accent); color: var(--accent); }

@media (max-width: 900px) {
/* ══ 窄屏自适应层(≤900 手持/平板竖,≤640 单列)════════════════════════════
   375px 下本页的三类实测缺陷:网关总控条右侧三件套不换行(整块顶出画布)、
   运行控制行的两个 150px 选择器 + 按钮并排超宽、微标签 9~10.5px。 */
  .adopt-card { padding: 12px; }
  /* 触摸目标:手持命中区 ≥40px(main.css 只在 pointer:coarse 下兜底) */
  .mini-btn {
    min-height: 40px;
  }
}
</style>
