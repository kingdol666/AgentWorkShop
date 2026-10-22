/**
 * 路线航迹(route trail)——header 导航留痕:
 *  - 每次路由变化把路径追加为航点(同路径去重后移到末尾,视作"重新盖章")
 *  - 上限 4 个航点(顶栏是一级导航的"最近路径",不是完整浏览历史;
 *    5 个以上会挤占右侧功能簇,实测 1440 视口下与语言/主题/用户区重叠)
 *  - localStorage 持久化,刷新后航迹保留
 *  - 只存 path + 时间戳:标题/图标在渲染层按当前 locale 与 workspace 名派生,
 *    避免语言切换或异步数据到达后标题过期
 */
export interface TrailWaypoint {
  path: string
  at: number
}

const MAX_WAYPOINTS = 4

export const useRouteTrailStore = defineStore('app.routeTrail', () => {
  const waypoints = ref<TrailWaypoint[]>([])

  /** 记录一次访问;同路径重复访问 → 移到末尾(刷新时间戳) */
  function visit(path: string): void {
    if (!path || path.startsWith('/api')) return
    const rest = waypoints.value.filter(w => w.path !== path)
    waypoints.value = [...rest, { path, at: Date.now() }].slice(-MAX_WAYPOINTS)
  }

  /** 关闭单个航点(标签页);返回被移除航点在原数组中的下标(供关闭当前页时挑选跳转目标) */
  function remove(path: string): number {
    const idx = waypoints.value.findIndex(w => w.path === path)
    if (idx >= 0) {
      waypoints.value = waypoints.value.filter(w => w.path !== path)
    }
    return idx
  }

  /** 清空航迹 */
  function clear(): void {
    waypoints.value = []
  }

  return { waypoints, visit, remove, clear }
}, {
  persist: {
    pick: ['waypoints'],
    storage: piniaPluginPersistedstate.localStorage(),
  },
})
