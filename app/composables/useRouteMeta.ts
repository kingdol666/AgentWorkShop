/**
 * 路径 → 航迹元数据(标题/图标):
 *  - 静态路由按菜单表;i18n 响应式派生,语言切换即时生效
 *  - 动态路由 /workshop/w/:id 用 workspace 名称(异步加载后 reactive 刷新)
 */
import { useWorkspacesStore } from '@/app/stores/workshop/workspaces'

export interface RouteMeta {
  title: string
  icon: string
}

export function useRouteMeta() {
  const { t } = useI18n()
  const workspaces = useWorkspacesStore()

  /** 静态路由表:标题存 i18n key(metaFor 求值时才 t(),语言切换即时生效) */
  const staticMap: Record<string, { key: string, icon: string }> = {
    '/': { key: 'menu.dashboard', icon: 'i-tabler-layout-dashboard' },
    '/workshop': { key: 'menu.workshop', icon: 'i-tabler-box' },

    '/workshop/agents': { key: 'meta.agents', icon: 'i-tabler-users' },

    '/workshop/teams': { key: 'meta.teams', icon: 'i-tabler-users-group' },

    '/workshop/channel-templates': { key: 'meta.ctpl', icon: 'i-tabler-layout-grid-add' },
    '/town': { key: 'menu.town', icon: 'i-tabler-map-2' },
    '/tokens': { key: 'menu.tokens', icon: 'i-tabler-key' },
    '/daq': { key: 'menu.daq', icon: 'i-tabler-activity' },
    '/dcw': { key: 'menu.dcw', icon: 'i-tabler-settings-automation' },
    '/logs': { key: 'menu.logs', icon: 'i-tabler-list-details' },
    '/permissions': { key: 'menu.permissions', icon: 'i-tabler-shield-lock' },
    '/plugins': { key: 'menu.plugins', icon: 'i-tabler-puzzle' },
    '/users': { key: 'menu.users', icon: 'i-tabler-users-group' },
    '/monitor': { key: 'menu.monitor', icon: 'i-tabler-cpu' },
    '/settings': { key: 'menu.settings', icon: 'i-tabler-settings' },
  }

  const metaFor = (path: string): RouteMeta => {
    const direct = staticMap[path]
    if (direct) return { title: t(direct.key), icon: direct.icon }

    // 动态:/workshop/w/<id> → workspace 名称(未加载时用短 id 占位)
    const wsMatch = path.match(/^\/workshop\/w\/([^/]+)$/)
    if (wsMatch) {
      const id = wsMatch[1]!
      const name = workspaces.workspaces.find(w => w.id === id)?.name
      return { title: name ?? `${t('header.workspace')} ${id.slice(0, 6)}`, icon: 'i-tabler-console' }
    }

    // 单段动态路径(daqs/dcws 等)取末段;纯 slug 至少首字母大写,不再裸显示
    const last = path.split('/').filter(Boolean).pop() ?? '·'
    return { title: last.charAt(0).toUpperCase() + last.slice(1), icon: 'i-tabler-point' }
  }

  return { metaFor }
}
