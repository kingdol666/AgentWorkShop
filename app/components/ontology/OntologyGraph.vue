<script setup lang="ts">
/**
 * 本体节点-边可视化(自绘 SVG,零第三方图库)。
 *
 * 布局纪律:不做物理模拟 —— 按编译器口径分三道(与 compiler.ts 的 roleBucket 同源):
 *   MV = control / disturbance / feature
 *   CV = target / observation
 *   结构/状态 = state / guard / 无 role
 * 同道具内按文档顺序均布,因此布局确定性、可被 e2e 用 bounding box 断言。
 */
import { computed, useId } from 'vue'
import type { OntologyEntityDto, OntologyRelationDto } from '@/app/pages/ontology/types'

const props = defineProps<{
  entities: OntologyEntityDto[]
  relations: OntologyRelationDto[]
  selectedKey?: string
}>()

const emit = defineEmits<{ select: [key: string] }>()

const { t } = useI18n()
const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')

const WIDTH = 980
const NODE_R = 7
const LANE_X = [150, 490, 830]

type Lane = 0 | 1 | 2
const LANE_OF_ROLE: Record<string, Lane> = {
  control: 0,
  disturbance: 0,
  feature: 0,
  target: 1,
  observation: 1,
  state: 2,
  guard: 2,
}

function laneOf(entity: OntologyEntityDto): Lane {
  return LANE_OF_ROLE[entity.role ?? ''] ?? 2
}

function shortKey(key: string): string {
  const tail = key.includes('.') ? key.slice(key.indexOf('.') + 1) : key
  return tail.length > 18 ? `${tail.slice(0, 17)}…` : tail
}

const laneLabels = computed(() => [
  t('ontology.graph.lane.mv'),
  t('ontology.graph.lane.cv'),
  t('ontology.graph.lane.structural'),
])

const laneMembers = computed<OntologyEntityDto[][]>(() => {
  const lanes: OntologyEntityDto[][] = [[], [], []]
  for (const entity of props.entities) lanes[laneOf(entity)]!.push(entity)
  return lanes
})

const height = computed(() => {
  const maxCount = Math.max(1, ...laneMembers.value.map(list => list.length))
  return Math.max(360, Math.min(760, maxCount * 46 + 96))
})

const positions = computed(() => {
  const map = new Map<string, { x: number, y: number, lane: Lane }>()
  laneMembers.value.forEach((members, lane) => {
    const count = members.length
    members.forEach((entity, index) => {
      const span = height.value - 96
      const y = count === 1 ? 48 + span / 2 : 48 + (span * index) / (count - 1)
      map.set(entity.key, { x: LANE_X[lane]!, y, lane: lane as Lane })
    })
  })
  return map
})

const entityKeys = computed(() => new Set(props.entities.map(e => e.key)))

const visibleRelations = computed(() => props.relations.filter(
  relation => entityKeys.value.has(relation.srcKey) && entityKeys.value.has(relation.dstKey),
))

const edgePaths = computed(() => visibleRelations.value.flatMap((relation, index) => {
  const from = positions.value.get(relation.srcKey)
  const to = positions.value.get(relation.dstKey)
  if (!from || !to) return []
  const tier = relation.properties?.evidenceTier ?? 'candidate_influence'
  const sameLane = from.lane === to.lane
  const curve = sameLane ? 46 + index * 6 : 0
  const x1 = from.x + (to.x >= from.x ? NODE_R : -NODE_R)
  const x2 = to.x + (to.x >= from.x ? -NODE_R : NODE_R)
  const cx1 = sameLane ? from.x + curve : (x1 + x2) / 2
  const cx2 = sameLane ? to.x + curve : (x1 + x2) / 2
  return [{
    id: relation.id,
    kind: relation.kind,
    tier,
    d: `M ${x1} ${from.y} C ${cx1} ${from.y}, ${cx2} ${to.y}, ${x2} ${to.y}`,
    labelX: (x1 + x2) / 2,
    labelY: (from.y + to.y) / 2,
    src: relation.srcKey,
    dst: relation.dstKey,
  }]
}))

const tierClass = (tier: string): string => `tier-${tier.replace(/_/g, '-')}`

function onSelect(key: string): void {
  emit('select', key)
}
</script>

<template>
  <div
    class="ontology-graph"
    data-testid="ontology-graph"
  >
    <svg
      class="graph-svg"
      :viewBox="`0 0 ${WIDTH} ${height}`"
      :style="{ height: `${height}px` }"
      role="img"
      :aria-label="t('ontology.graph.aria')"
    >
      <defs>
        <marker
          :id="`ont-arrow-${uid}`"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path
            d="M 0 0 L 10 5 L 0 10 z"
            class="edge-arrow"
          />
        </marker>
      </defs>

      <g
        v-for="(label, index) in laneLabels"
        :key="label"
        class="lane"
      >
        <line
          :x1="LANE_X[index]"
          y1="30"
          :x2="LANE_X[index]"
          :y2="height - 30"
          class="lane-line"
        />
        <text
          :x="LANE_X[index]"
          y="18"
          class="lane-label"
        >{{ label }}</text>
      </g>

      <g
        v-for="edge in edgePaths"
        :key="edge.id"
        :data-edge-id="edge.id"
        :data-src="edge.src"
        :data-dst="edge.dst"
        :data-kind="edge.kind"
        :data-tier="edge.tier"
        class="edge"
        :class="tierClass(edge.tier)"
      >
        <title>{{ edge.id }} · {{ edge.kind }}</title>
        <path
          :d="edge.d"
          class="edge-line"
          :marker-end="`url(#ont-arrow-${uid})`"
        />
      </g>

      <g
        v-for="entity in entities"
        :key="entity.key"
        :data-node-key="entity.key"
        :data-role="entity.role ?? ''"
        :data-kind="entity.kind"
        class="node"
        :class="{ selected: entity.key === selectedKey }"
        role="button"
        tabindex="0"
        :aria-label="`${entity.key} · ${entity.name}`"
        @click="onSelect(entity.key)"
        @keydown.enter="onSelect(entity.key)"
        @keydown.space.prevent="onSelect(entity.key)"
      >
        <title>{{ entity.key }} · {{ entity.name }}{{ entity.unit ? ` (${entity.unit})` : '' }}</title>
        <circle
          v-if="entity.key === selectedKey"
          :cx="positions.get(entity.key)?.x ?? 0"
          :cy="positions.get(entity.key)?.y ?? 0"
          :r="NODE_R + 5"
          class="node-halo"
          data-role="selection-halo"
        />
        <circle
          :cx="positions.get(entity.key)?.x ?? 0"
          :cy="positions.get(entity.key)?.y ?? 0"
          :r="NODE_R"
          class="node-dot"
        />
        <text
          :x="(positions.get(entity.key)?.x ?? 0) + NODE_R + 6"
          :y="(positions.get(entity.key)?.y ?? 0) + 4"
          class="node-label"
        >{{ shortKey(entity.key) }}</text>
      </g>
    </svg>

    <div class="legend">
      <span class="legend-item candidate_influence">{{ t('ontology.graph.tier.candidate') }}</span>
      <span class="legend-item observed_correlation">{{ t('ontology.graph.tier.observed') }}</span>
      <span class="legend-item validated_control">{{ t('ontology.graph.tier.validated') }}</span>
    </div>
  </div>
</template>

<style scoped>
.ontology-graph {
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 8px 10px 4px;
  background: var(--paper-raised);
  overflow-x: auto;
}

.graph-svg {
  width: 100%;
  min-width: 720px;
  display: block;
}

.lane-line {
  stroke: var(--line);
  stroke-width: 1;
  stroke-dasharray: 2 6;
}

.lane-label {
  fill: var(--ink-faint);
  font-size: 11px;
  text-anchor: middle;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.edge-line {
  fill: none;
  stroke-width: 1.4;
}

.edge-arrow {
  fill: var(--ink-faint);
}

.edge.tier-candidate-influence .edge-line {
  stroke: var(--ink-faint);
  stroke-dasharray: 3 4;
  opacity: 0.7;
}

.edge.tier-observed-correlation .edge-line {
  stroke: var(--tone-info-dot);
}

.edge.tier-validated-control .edge-line {
  stroke: var(--tone-success-dot);
  stroke-width: 2.2;
}

.node {
  cursor: pointer;
}

.node-dot {
  fill: var(--paper-raised);
  stroke: var(--line-strong);
  stroke-width: 1.6;
}

.node[data-role='control'] .node-dot,
.node[data-role='disturbance'] .node-dot,
.node[data-role='feature'] .node-dot {
  stroke: var(--tone-info-dot);
}

.node[data-role='target'] .node-dot {
  stroke: var(--tone-success-dot);
}

.node[data-role='guard'] .node-dot {
  stroke: var(--tone-danger-dot);
}

.node-halo {
  fill: none;
  stroke: var(--focus-ring);
  stroke-width: 1.3;
  stroke-dasharray: 3 3;
}

.node-label {
  fill: var(--ink-soft);
  font-size: 11px;
  font-family: var(--font-mono, ui-monospace, monospace);
}

.node.selected .node-label {
  fill: var(--ink);
}

.node:focus-visible .node-dot {
  stroke: var(--focus-ring);
  stroke-width: 2.4;
}

.legend {
  display: flex;
  gap: 14px;
  padding: 2px 4px 6px;
  font-size: 11px;
  color: var(--ink-faint);
}

.legend-item::before {
  content: '';
  display: inline-block;
  width: 18px;
  height: 0;
  margin-right: 5px;
  vertical-align: middle;
  border-top: 1.4px solid var(--ink-faint);
}

.legend-item.candidate_influence::before {
  border-top-style: dashed;
}

.legend-item.observed_correlation::before {
  border-top-color: var(--tone-info-dot);
}

.legend-item.validated_control::before {
  border-top: 2.2px solid var(--tone-success-dot);
}
</style>
