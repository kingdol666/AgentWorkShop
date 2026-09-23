/**
 * 监控页的原生终端面板状态(omp rpc-ui 镜像 + HITL)。
 *
 * 面板的开关与寻址只有一份副本,由页面持有并下发给所有会开终端的行(agent 表 / 进程表):
 * 子组件用 emit 上报"要开哪个 pid",不各自持有开关,避免出现两个抽屉或状态漂移。
 */
export function useMonitorTerminal() {
  const terminalOpen = ref(false)
  const terminalPid = ref<number | null>(null)
  const terminalSubtitle = ref('')
  const openTerminal = (pid: number, name: string | null, role: string | null): void => {
    terminalPid.value = pid
    terminalSubtitle.value = [name, role].filter(Boolean).join(' · ') || 'omp harness'
    terminalOpen.value = true
  }

  return { terminalOpen, terminalPid, terminalSubtitle, openTerminal }
}
