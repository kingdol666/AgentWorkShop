// Declarative tray menu model. Electron maps these descriptors to native menu
// items; unit tests can assert the exact user-facing surface without a display.

const SETTINGS = Object.freeze([
  { key: 'closeToTray', label: '关闭时最小化到托盘' },
  { key: 'launchAtLogin', label: '开机自动启动' },
  { key: 'startHidden', label: '启动后最小化到托盘' },
  { key: 'trayNotifications', label: '托盘通知' },
  { key: 'autoCheckUpdates', label: '自动检查更新' },
])

function updateLabel(update) {
  if (update?.status === 'available') return `查看新版本 v${update.version}`
  if (update?.status === 'downloading') return `正在下载更新 ${Math.max(0, Math.min(100, Number(update.progress) || 0))}%`
  if (update?.status === 'ready') return `安装 v${update.version} 并重启`
  return '检查更新…'
}

export function buildTrayMenuModel({ settings, service, port, version, windowVisible, update }) {
  const online = service === 'online'
  const serviceLabel = online
    ? `本机服务 · 运行中${port ? ` · 127.0.0.1:${port}` : ''}`
    : service === 'offline' ? '本机服务 · 已断开' : '本机服务 · 启动中…'
  const updateBusy = ['downloading', 'ready'].includes(update?.status)
  return [
    { id: 'open', label: windowVisible ? '打开 AgentWorkShop' : '显示主窗口' },
    { id: 'reload', label: '重新加载界面', enabled: online },
    { type: 'separator' },
    { id: 'service-status', label: serviceLabel, enabled: false },
    { id: 'restart-service', label: '重启本地服务…', enabled: online },
    { type: 'separator' },
    { id: 'check-update', label: updateLabel(update), enabled: !updateBusy && update?.status !== 'ready' },
    { id: 'open-home', label: '打开数据目录' },
    { id: 'open-logs', label: '打开日志目录' },
    { id: 'diagnostics', label: '诊断信息…' },
    { type: 'separator' },
    {
      id: 'settings',
      label: '设置',
      submenu: SETTINGS.map(item => ({
        id: `setting:${item.key}`,
        label: item.label,
        type: 'checkbox',
        checked: Boolean(settings?.[item.key]),
      })),
    },
    { type: 'separator' },
    { id: 'quit', label: `退出 AgentWorkShop${version ? ` ${version}` : ''}` },
  ]
}

/** Settings entries for the tray submenu, also used for change notifications. */
export const TRAY_SETTINGS = SETTINGS

/** Settings keys exposed by the tray submenu; used to validate click payloads. */
export const TRAY_SETTING_KEYS = Object.freeze(SETTINGS.map(item => item.key))
