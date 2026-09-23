/**
 * 小镇视图中转组件(左轨 / 舞台 / 右轨 / 加载遮罩)的 props 契约。
 *
 * 自 TownView.vue 抽出:这些壳组件的 props 全部由父组件注入(数据 + 动作回调),
 * 子组件不新建任何响应式副本;契约集中在此声明,供组件 defineProps<...>() 复用。
 */
import type { ComponentPublicInstance } from 'vue'
import type { useEntitiesStore } from '@/app/stores/workshop/entities'
import type { useDeviceTwins } from '@/app/composables/workshop/useDeviceTwins'
import type { useDaqStream, DaqNodeLive } from '@/app/composables/workshop/useDaqStream'
import type { useDcwStream, DcwNodeView } from '@/app/composables/workshop/useDcwStream'
import type { TownScene3D } from '@/app/components/workshop/town/TownScene3D'
import type {
  AgentNodeBindingRow, AlarmItem, CalloutRow, ChatEntry, DaqSimState, DaqTemplate,
  DcwBoundRow, DcwLiveRow, DcwTemplate, DockChannelRow, MiniState, RailBindChoice,
  RailLeafState, ToolApprovalRow, TownMemberRow, TownModelRow,
} from './town-view-types'

/** TownLoadingMask 的 props 契约 */
export interface TownLoadingMaskProps {
  ready: boolean
}

/** TownLeftRail 的 props 契约 */
export interface TownLeftRailProps {
  sheetOpen: 'left' | 'right' | null
  closeSheet: () => void
  mode: 'browse' | 'edit'
  treeOpen: Record<string, boolean>
  deviceModels: TownModelRow[]
  daqTwins: ReadonlyArray<unknown>
  deviceTwins: ReturnType<typeof useDeviceTwins>
  daq: ReturnType<typeof useDaqStream>
  daqTemplates: DaqTemplate[]
  daqNodesByTpl: Map<string, DaqNodeLive[]>
  daqLeafState: (n: DaqNodeLive) => RailLeafState
  toggleTreeGroup: (key: string) => void
  createDaqFromTemplate: (tpl: DaqTemplate) => void
  onDaqNodeDragStart: (e: DragEvent, n: DaqNodeLive) => void
  dcw: ReturnType<typeof useDcwStream>
  dcwTemplates: DcwTemplate[]
  dcwNodesByTpl: Map<string, DcwNodeView[]>
  dcwLeafState: (n: DcwNodeView) => RailLeafState
  createDcwFromTemplate: (tpl: { id: string }) => void
  onDcwNodeDragStart: (e: DragEvent, n: DcwNodeView) => void
  dockChannels: DockChannelRow[]
  dockHint: string
  onChannelDragStart: (e: DragEvent, channelId: string) => void
  onDockCardClick: (ch: { channelId: string, placed: boolean }) => void
  onFocusDevice: (t: { id: string, posX?: number, posZ?: number }) => void
}

/** TownStage 的 props 契约 */
export interface TownStageProps {
  setStageRef: (el: Element | ComponentPublicInstance | null) => void
  setHostRef: (el: Element | ComponentPublicInstance | null) => void
  mode: 'browse' | 'edit'
  ready: boolean
  errorText: string
  lastDropText: string
  activeChannelName: string
  viewPreset: 'std' | 'top' | 'front' | 'side'
  orbitOn: boolean
  locateSelected: () => void
  toggleOrbit: () => void
  fullscreenStage: () => void
  onViewPreset: (e: Event) => void
  callouts: CalloutRow[]
  selectDeviceFromCallout: (daqId: string) => void
  deviceCount: number
  runningCount: number
  activeAlarmCount: number
  daqTwins: ReadonlyArray<unknown>
  healthPct: number
  sceneEmpty: boolean
  selectedChannel: string | null
  channelPanelTab: 'boundary' | 'members'
  channelMembers: TownMemberRow[]
  agentModels: TownModelRow[]
  panelPos: Record<string, { x: number, y: number }>
  sliderPct: (v: number, min: number, max: number) => string
  hashColor: (id: string) => string
  onPanelGripDown: (e: PointerEvent, key: string) => void
  openChannelTab: (tab: 'boundary' | 'members') => void
  applyBoundaryDraft: () => void
  bindMemberModel: (agentId: string, modelRef: string) => void
  saveChannelLayout: () => void
  removeChannelFromScene: () => void
  onSelectChannel: (cid: string | null) => void
  entities: ReturnType<typeof useEntitiesStore>
  qualityMode: 'auto' | 'normal' | 'hd' | 'ultra'
  fpsCap: '60' | '120' | '0'
  qualityOptions: ReadonlyArray<{ v: 'auto' | 'normal' | 'hd' | 'ultra', label: string }>
  fpsOptions: ReadonlyArray<{ v: '60' | '120' | '0', label: string }>
  exposure: number
  tintOpacity: number
  snap: boolean
  estop: boolean
  setQualityMode: (v: 'auto' | 'normal' | 'hd' | 'ultra') => void
  setFpsCap: (v: '60' | '120' | '0') => void
  onExposureInput: (e: Event) => void
  onTintInput: (e: Event) => void
  toggleSnap: () => void
  onResetView: () => void
  saveLayout: () => void
  toggleEstop: () => void
  trendChips: Array<{ id: string, name: string }>
  trendOverflow: number
  trendOn: (id: string, idx?: number) => boolean
  trendColor: (id: string) => string
  toggleTrend: (id: string) => void
  setTrendCanvas: (el: Element | ComponentPublicInstance | null) => void
}

/** TownRightRail 的 props 契约 */
export interface TownRightRailProps {
  sheetOpen: 'left' | 'right' | null
  closeSheet: () => void
  mode: 'browse' | 'edit'
  selected: { kind: 'agent' | 'device', id: string, scale: number, rotation: number } | null
  selectedIsDaq: boolean
  selectedIsDcw: boolean
  selectedAgentRoleLabel: string
  selectedAgentMeta: { role?: string | null, state?: string | null, harness?: string | null } | null
  closeScale: () => void
  deviceTwins: ReturnType<typeof useDeviceTwins>
  deviceModels: TownModelRow[]
  daq: ReturnType<typeof useDaqStream>
  dcw: ReturnType<typeof useDcwStream>
  selectedDcwNode: DcwNodeView | null
  selectedDcwWindow: { lo: number, hi: number, src: 'recipe' | 'global' } | null
  selectedDcwDeviceName: string
  dcwWriteErrs: Record<string, string>
  dcwWinLabel: (n: DcwNodeView | null) => string
  dcwWinInputPh: (n: DcwNodeView | null) => string
  isLegacyDaqTwin: (t: ReturnType<typeof useDeviceTwins>['twins'][number]) => boolean
  doWriteSelectedDcw: () => void
  bindSelectedDcw: () => void
  unbindSelectedDcw: () => void
  daqBoundDeviceName: string
  selectedDaqNode: DaqNodeLive | null
  selectedDaqSim: DaqSimState | null | undefined
  fmtDaq: (st: DaqSimState) => string
  onDaqIntervalCommit: () => void
  onDaqThresholdCommit: (key: 'min' | 'max' | 'warnLow' | 'warnHigh', raw: string) => void
  removeSelectedDevice: () => void
  unbindDaq: (daqId: string) => void
  bindDaq: (daqId: string, deviceId: string) => void
  daqTemplates: DaqTemplate[]
  daqBindChoices: Record<string, RailBindChoice[]>
  daqBindChoiceCount: number
  bindPopOpen: boolean
  bindPopMaxH: number
  toggleBindPop: (key: 'daq' | 'dcw', e: MouseEvent) => void
  bindDaqChoice: (nodeId: string) => void
  setSparkRef: (id: string, el: unknown) => void
  onObjNameCommit: () => void
  bindDeviceModel: (modelRef: string) => void
  boundDaqRows: Array<{ daqId: string, name: string, ch: string, icon: string, value: string, unit: string, color: string }>
  boundDcwRows: DcwBoundRow[]
  dcwTemplates: DcwTemplate[]
  dcwBindChoices: Record<string, RailBindChoice[]>
  dcwBindChoiceCount: number
  dcwBindPopOpen: boolean
  dcwMarkPct: (r: { value: number | null, rMin: number | null, rMax: number | null, gMin: number, gMax: number }) => number
  doDcwWrite: (node: DcwNodeView) => void
  unbindDcw: (dcwId: string) => void
  bindDcwChoice: (nodeId: string) => void
  tMode: 'translate' | 'rotate' | 'scale'
  deviceDeleteArmed: string
  setTMode: (m: 'translate' | 'rotate' | 'scale') => void
  onScaleInput: (v: number) => void
  onScaleCommit: (v: number) => void
  agentModels: TownModelRow[]
  agentChatTitle: string
  agentChatColor: string
  agentChatStateLabel: string
  selectedAgentRoleTag: string
  agentDrawingRange: boolean
  agentRangeStatusText: string
  agentHistory: ChatEntry[]
  agentChatRows: ChatEntry[]
  historyLoading: boolean
  fmtTime: (at?: number) => string
  chatKindLabel: (kind: string) => string
  onRefreshHistory: () => void
  onToggleRangeDraw: () => void
  applyAgentRangeDraft: () => void
  onAgentRangeCommit: () => void
  onClearAgentRange: () => void
  bindAgentModel: (modelRef: string) => void
  setChatScroll: (el: Element | ComponentPublicInstance | null) => void
  agentBindings: AgentNodeBindingRow[]
  pendingApprovals: ToolApprovalRow[]
  approvalRemainingSec: (ap: ToolApprovalRow) => number
  bindingNodeName: (b: AgentNodeBindingRow) => string
  setBindingMode: (id: string, mode: 'auto' | 'manual') => void
  unbindAgentNode: (id: string) => void
  bindAgentNode: () => void
  decideApproval: (id: string, approved: boolean) => void
  healthPct: number
  healthTone: string
  idleCount: number
  alarmCount: number
  offlineCount: number
  runningCount: number
  setDonutCanvas: (el: Element | ComponentPublicInstance | null) => void
  daqLive: Record<string, Array<{ ch: string, value: string, unit: string, alarm?: boolean }>>
  dcwLive: Record<string, DcwLiveRow[]>
  onFocusDevice: (t: { id: string, posX?: number, posZ?: number }) => void
  alarms: AlarmItem[]
  alarmStates: ReadonlyArray<string>
  advanceAlarm: (id: number) => void
  activeAlarmCount: number
  clearAlarms: () => void
  ticker: Array<{ channelId: string, agentName: string, text: string, at?: number }>
  minimap: MiniState | null
  navScale: number
  scene3dRef: TownScene3D | null
  setNavCanvas: (el: Element | ComponentPublicInstance | null) => void
  onNavDown: (e: PointerEvent) => void
  onNavMove: (e: PointerEvent) => void
  onNavUp: (e: PointerEvent) => void
  onNavWheel: (e: WheelEvent) => void
  onResetView: () => void
}
