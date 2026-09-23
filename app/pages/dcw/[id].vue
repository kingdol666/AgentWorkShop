<script setup lang="ts">
/**
 * 单产线专业控制台(/dcw/[id])—— 网关总控 / 产线启停 / 控制节点清单 / 产品与配方 /
 * 配方版本历史 / 产线数据查询 / 写历史 / 参数台账(调控闭环)。
 *
 * 页面只做编排:路由作用域、写路径、台账、产线启停、产品、配方、查询、添加节点、控制模板
 * 各一个 composable(状态各归其主);视图放在 components/dcw/ 下的子组件
 * (绝不放进 pages/** —— 那会生成路由),样式随标记进各组件自己的 scoped 样式块
 * (scoped 的 data-v 不跨组件,共享工具类各自持有一份逐字相同的副本)。
 * 弹窗与面板经 v-model 就地读写 composable 持有的同一份状态,不产生第二副本。
 */
import { useDcwAddNode } from './composables/useDcwAddNode'
import { useDcwDetailScope } from './composables/useDcwDetailScope'
import { useDcwDetailTemplates } from './composables/useDcwDetailTemplates'
import { useDcwLedger } from './composables/useDcwLedger'
import { useDcwLineRun } from './composables/useDcwLineRun'
import { useDcwProducts } from './composables/useDcwProducts'
import { useDcwQuery } from './composables/useDcwQuery'
import { useDcwRecipes } from './composables/useDcwRecipes'
import { useDcwWrites } from './composables/useDcwWrites'

const scope = useDcwDetailScope()
const writes = useDcwWrites()
const ledgerCtl = useDcwLedger()
const lineRun = useDcwLineRun(scope)
const products = useDcwProducts(scope, lineRun)
const recipes = useDcwRecipes(scope, products, lineRun, writes)
const queryCtl = useDcwQuery(scope)
const addNode = useDcwAddNode(scope)
const tplCtl = useDcwDetailTemplates(addNode)

const { dcw, line, lineId, ls, lineNodes, lineProducts, lineRecipesAll, lineRuns, lineHistory, unassignedNodes, unassignedProducts, stateLabel, dcwTemplateRefCh, nodeMin, nodeMax, lineDaqNodes, daqNodeCh, adoptNode, adoptProduct, productName, paramStatus, paramNodeName, daqWindowStatus, nodeDeviceNames } = scope
const { setInputs, writingId, writeError, writeOk, readingId, togglingId, doWrite, doRead, toggleControl } = writes
const { ledgerNodeId, ledger, loadLedger, rollbackLedgerNode } = ledgerCtl
const { lineProductId, lineRecipeId, lineBusy, lineMsg, lineErr, lineRecipes, doLineStart, doLineStop } = lineRun
const { filterProductId, visibleRecipes, productOpen, productSaving, productError, productForm, doCreateProduct } = products
const { verOpen, verRecipe, verRows, verLoading, verMsg, doRevert, recipeOpen, recipeEditing, recipeSaving, recipeError, recipeStaleNote, recipeForm, applyResult, runDataView, runDataLoading, openRecipeCreate, openRecipeEdit, openRecipeHistory, saveRecipe, doApplyRecipe, doViewRun } = recipes
const { query, queryBusy, queryError, queryResult, doQuery, daqParamKeys } = queryCtl
const { addOpen, addScenario, addTemplate, addDriver, addName, addHold, addRead, addWriteLock, addCfg, addTransform, addSemantics, addTesting, addTest, addSaving, addError, addFields, driverCatalog, doTestConnection, doAddNode } = addNode
const { tplOpen, tplSaving, tplError, tplOk, tplForm, tplIcons, builtinCount, customCount, openTplModal, doCreateTemplate } = tplCtl
</script>

<template>
  <div
    v-if="dcw.loaded && !line"
    class="page"
  >
    <p class="banner bad">
      {{ $t('dcwDetail.k19337yp018') }}
    </p>
    <NuxtLink
      class="pill-btn"
      to="/dcw"
    >
      {{ $t('dcwDetail.kllwu1c019') }}
    </NuxtLink>
  </div>
  <div
    v-else
    class="page"
  >
    <DcwDetailHead
      :line="line"
      :line-id="lineId"
      :nodes-count="lineNodes.length"
      :products-count="lineProducts.length"
      :recipes-count="lineRecipesAll.length"
    />

    <!-- 网关总控条 -->
    <DcwGatewayBar
      :running="dcw.controller.running"
      :nodes-online="dcw.controller.nodesOnline"
      :nodes-total="dcw.controller.nodesTotal"
      :writes-total="dcw.controller.writesTotal"
      :writes-failed="dcw.controller.writesFailed"
      @toggle="dcw.startStop"
      @open-templates="openTplModal"
      @open-add="addOpen = true"
    />

    <!-- 写错误/成功横幅 -->
    <p
      v-if="writeError || writeOk"
      class="banner"
      :class="writeError ? 'bad' : 'good'"
    >
      {{ writeError || writeOk }}
    </p>

    <!-- 未分配资产收编(历史节点/产品迁移到本产线) -->
    <DcwAdoptCard
      :unassigned-nodes="unassignedNodes"
      :unassigned-products="unassignedProducts"
      @adopt-node="adoptNode"
      @adopt-product="adoptProduct"
    />

    <!-- 产线运行控制:开跑必设配方;窗口内数采逐样本打标 -->
    <DcwLineRunCard
      v-model:product-id="lineProductId"
      v-model:recipe-id="lineRecipeId"
      :ls="ls"
      :line-products="lineProducts"
      :line-recipes="lineRecipes"
      :line-busy="lineBusy"
      :line-msg="lineMsg"
      :line-err="lineErr"
      @start="doLineStart"
      @stop="doLineStop"
    />

    <!-- 添加控制节点模板(自定义创建) -->
    <DcwDetailTemplateModal
      v-model:open="tplOpen"
      v-model:form="tplForm"
      :templates="dcw.templates"
      :tpl-icons="tplIcons"
      :builtin-count="builtinCount"
      :custom-count="customCount"
      :tpl-saving="tplSaving"
      :tpl-error="tplError"
      :tpl-ok="tplOk"
      @submit="doCreateTemplate"
      @close="tplOpen = false"
    />

    <!-- 添加控制节点向导 -->
    <DcwAddNodeModal
      v-model:open="addOpen"
      v-model:scenario="addScenario"
      v-model:template="addTemplate"
      v-model:driver="addDriver"
      v-model:name="addName"
      v-model:hold="addHold"
      v-model:read="addRead"
      v-model:write-lock="addWriteLock"
      v-model:cfg="addCfg"
      v-model:transform="addTransform"
      v-model:semantics="addSemantics"
      :templates="dcw.templates"
      :driver-catalog="driverCatalog"
      :add-fields="addFields"
      :add-testing="addTesting"
      :add-test="addTest"
      :add-saving="addSaving"
      :add-error="addError"
      @test="doTestConnection"
      @submit="doAddNode"
    />

    <!-- 控制节点清单 -->
    <DcwNodesTable
      v-model:set-inputs="setInputs"
      :line-nodes="lineNodes"
      :state-label="stateLabel"
      :toggling-id="togglingId"
      :reading-id="readingId"
      :writing-id="writingId"
      :loaded="dcw.loaded"
      :error="dcw.error"
      :dcw-template-ref-ch="dcwTemplateRefCh"
      :node-device-names="nodeDeviceNames"
      @toggle="toggleControl"
      @read="doRead"
      @write="doWrite"
      @remove="dcw.removeNode"
    />

    <!-- 产品与配方管理 -->
    <DcwRecipePanel
      v-model:filter-product-id="filterProductId"
      :line-products="lineProducts"
      :visible-recipes="visibleRecipes"
      :line-runs="lineRuns"
      :apply-result="applyResult"
      :run-data-view="runDataView"
      :run-data-loading="runDataLoading"
      :product-name="productName"
      :param-status="paramStatus"
      :param-node-name="paramNodeName"
      :daq-window-status="daqWindowStatus"
      :daq-node-ch="daqNodeCh"
      @create="openRecipeCreate"
      @open-product="productOpen = true"
      @apply="doApplyRecipe"
      @edit="openRecipeEdit"
      @history="openRecipeHistory"
      @remove-recipe="dcw.removeRecipe"
      @remove-product="dcw.removeProduct"
      @view-run="doViewRun"
      @close-run="dcw.closeRun"
      @close-run-data="runDataView = null"
    />

    <!-- 配方编辑弹窗 -->
    <DcwRecipeEditModal
      v-model:open="recipeOpen"
      v-model:form="recipeForm"
      :line-products="lineProducts"
      :line-nodes="lineNodes"
      :line-daq-nodes="lineDaqNodes"
      :line-id="lineId"
      :recipe-editing="recipeEditing"
      :recipe-saving="recipeSaving"
      :recipe-error="recipeError"
      :recipe-stale-note="recipeStaleNote"
      :dcw-template-ref-ch="dcwTemplateRefCh"
      :node-min="nodeMin"
      :node-max="nodeMax"
      :param-status="paramStatus"
      @submit="saveRecipe"
      @close="recipeOpen = false"
    />

    <!-- 配方版本历史(整体修改变更记录:来源/操作者/原因/参数 diff + 回退) -->
    <DcwRecipeHistoryModal
      v-model:open="verOpen"
      :ver-recipe="verRecipe"
      :ver-rows="verRows"
      :ver-loading="verLoading"
      :ver-msg="verMsg"
      :param-node-name="paramNodeName"
      @revert="doRevert"
      @close="verOpen = false"
    />

    <!-- 产线数据查询(产品/配方/参数/时间/间隔) -->
    <DcwQueryCard
      v-model:query="query"
      :line-products="lineProducts"
      :visible-recipes="visibleRecipes"
      :line-daq-nodes="lineDaqNodes"
      :daq-param-keys="daqParamKeys"
      :query-busy="queryBusy"
      :query-error="queryError"
      :query-result="queryResult"
      @run="doQuery"
    />

    <!-- 写历史 -->
    <DcwWriteHistoryCard
      v-if="lineHistory.length"
      :line-history="lineHistory"
    />

    <!-- 新建产品弹窗 -->
    <DcwProductCreateModal
      v-model:open="productOpen"
      v-model:form="productForm"
      :product-saving="productSaving"
      :product-error="productError"
      @submit="doCreateProduct"
      @close="productOpen = false"
    />

    <p
      v-if="dcw.error"
      class="err"
    >
      {{ dcw.error }}(<NuxtLink to="/workshop">{{ $t('dcwDetail.k1bhhheq120') }}</NuxtLink>)
    </p>

    <!-- 参数台账(调控闭环:当前值/配方目标/lastGood 三值对照 + 设定历史 + 优化记录) -->
    <DcwLedgerCard
      v-model:node-id="ledgerNodeId"
      :line-nodes="lineNodes"
      :ledger="ledger"
      @load="loadLedger"
      @rollback="rollbackLedgerNode"
    />
  </div>
</template>

<style scoped>
/* 共享工具类随标记搬入本组件:scoped 的 data-v 归属不跨组件,
   凡在多组件出现的规则(.mono/.dim/.inp/.mini-btn/.modal-mask/.banner/.nodes-table/.sec-label/.st-pill 等)
   在此各持一份逐字相同的副本,以保证每个元素命中的声明集与拆分前一致,同时不引入任何全局选择器。 */

.page { padding: 4px; }

.banner { padding: 9px 14px; margin: 0 0 12px; font-size: 12.5px; border-radius: var(--radius-chip); }
.banner.bad { color: var(--tone-danger-dot); background: var(--tone-danger-bg); border: 1px solid color-mix(in srgb, var(--tone-danger-dot) 40%, transparent); }
.banner.good { color: var(--tone-success-dot); background: var(--tone-success-bg); border: 1px solid color-mix(in srgb, var(--tone-success-dot) 40%, transparent); }

.err { margin-top: 14px; font-size: 13px; color: var(--tone-danger-dot); }

@media (max-width: 900px) {
/* ══ 窄屏自适应层(≤900 手持/平板竖,≤640 单列)════════════════════════════
   375px 下本页的三类实测缺陷:网关总控条右侧三件套不换行(整块顶出画布)、
   运行控制行的两个 150px 选择器 + 按钮并排超宽、微标签 9~10.5px。 */
  /* 触摸目标:手持命中区 ≥40px(main.css 只在 pointer:coarse 下兜底) */
  .pill-btn {
    min-height: 40px;
  }
}
</style>
