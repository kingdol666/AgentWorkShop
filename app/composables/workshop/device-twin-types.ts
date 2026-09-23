/**
 * 设备孪生面板(DeviceTwinPanel)数据行类型。
 *
 * 自 DeviceTwinPanel.vue 抽出(纯声明搬移):面板对外仍从 DeviceTwinPanel.vue
 * 透出 DcwLiveRow(类型 re-export,使用方 import 路径不变);此处集中声明,
 * 供面板容器、设备卡、智控通道区与 composable 共用,避免重复定义。
 */

/** 实时数采数据(twinId → 该实体相关的实时通道:
 *  数采节点 = 自身通道;设备 = 绑定到它的全部数采通道;由 TownView 从模拟上报喂入) */
export interface DaqLiveRow { ch: string, value: string, unit: string, alarm?: boolean }

/** 智控设定数据(twinId → 该设备绑定的全部智控通道;含当前 set 值与生效上下限) */
export interface DcwLiveRow {
  id: string
  ch: string
  name: string
  unit: string
  /** 当前设定值(工程量;null = 从未下发) */
  value: number | null
  /** PLC 当前读数(读写集成;null = 从未读到或驱动不支持) */
  readValue: number | null
  lastReadAt: string | null
  decimals: number
  /** 生效下/上限(活动配方工艺窗口优先,否则节点全局量程;-∞/+∞ 表示不限定) */
  lo: number
  hi: number
  src: 'recipe' | 'global'
}
