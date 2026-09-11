/**
 * 配置分组注册表 —— 设置页分组的单一事实来源。
 *
 * 描述符(schema.json / 插件声明)只负责声明 `group`(分组 id);分组的标题、说明、
 * 排序、默认折叠状态由本注册表给出。这样「后端 API 控制前端渲染」才成立:
 * 前端不再自己扫描描述符猜分组,而是完全按服务端返回的 groups 顺序与元数据渲染。
 *
 * 三类来源(source):
 *   builtin —— 由 schema.json 的声明顺序自动推导(不可删除,可改标题/排序)
 *   user    —— 管理员经 /api/system/config-groups 创建
 *   plugin  —— 插件装载期声明(ctx.config.defineGroup 或 manifest.configGroups);
 *              插件卸载/热重载时自动摘除,不残留空分组
 *
 * 健壮性:任何描述符引用了未注册的 group id → 自动兜底注册(source=builtin,
 * 标题取 id)。字段永不因为「分组没登记」而在设置页消失。
 *
 * 持久化:<configRoot>/config-groups.json
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const GROUPS_FILENAME = 'config-groups.json'

/**
 * 插件分组 id 规约:plugin-<插件名>[-<后缀>](合法标识符,可直接进 URL 与 i18n key)。
 * 把插件声明的任意 id 收敛进自己的命名空间,避免两个插件用同一个 "network" 互相覆盖,
 * 也保证插件卸载时能可靠识别并摘除自己声明的分组。
 */
export function pluginGroupId(pluginName, suffix) {
  const ns = String(pluginName).replace(/[^A-Za-z0-9_-]/g, '-')
  const sub = suffix == null || suffix === '' ? '' : `-${String(suffix).replace(/[^A-Za-z0-9_-]/g, '-')}`
  return `plugin-${ns}${sub}`.slice(0, 48)
}

/** 插件声明的分组 id → 命名空间内 id(label 保持原样展示) */
export function namespacedPluginGroupId(pluginName, declaredId) {
  const raw = String(declaredId ?? '').trim()
  if (!raw) return pluginGroupId(pluginName)
  if (raw === 'default' || raw === String(pluginName)) return pluginGroupId(pluginName)
  return pluginGroupId(pluginName, raw)
}

/** 插件默认配置分组 id(未显式声明 group 的字段落这里 → 每个插件天然一个独立分区) */
export function defaultPluginGroupId(pluginName) {
  return pluginGroupId(pluginName)
}

const ID_RE = /^[A-Za-z0-9_-]{1,48}$/

/**
 * 规范化分组定义。
 * order 只在「显式给出」或调用方提供 fallbackOrder(新建分组时)才落值 ——
 * 从磁盘读回的旧条目若没写 order,交给 mergeGroups 沿用内置声明顺序,
 * 否则会平白跳到列表末尾。
 * @returns {{ ok: true, group: object } | { ok: false, error: string }}
 */
export function normalizeGroup(def, { source = 'user', plugin = null, fallbackOrder } = {}) {
  const d = def ?? {}
  const id = String(d.id ?? '').trim()
  if (!ID_RE.test(id)) {
    return { ok: false, error: `分组 id 非法(仅字母数字_-，1~48 位): ${JSON.stringify(d.id)}` }
  }
  const label = String(d.label ?? d.labelKey ?? id).trim()
  if (!label) return { ok: false, error: `分组 ${id}: label 不能为空` }
  const order = Number.isFinite(Number(d.order)) ? Number(d.order) : fallbackOrder
  const group = {
    id,
    label,
    description: String(d.description ?? ''),
    /** 前端默认是否折叠(用户本地展开/收起偏好优先,见设置页 localStorage) */
    collapsed: d.collapsed === true,
    /** false = 不可折叠(始终展开;用于字段极少的固定分组) */
    collapsible: d.collapsible !== false,
    icon: d.icon ? String(d.icon) : '',
    source,
  }
  if (order !== undefined) group.order = order
  if (d.labelKey) group.labelKey = String(d.labelKey)
  if (plugin) group.plugin = String(plugin)
  return { ok: true, group }
}

function readFile(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.groups) ? raw.groups : [])
    return list
  }
  catch {
    return []
  }
}

/** 原子写入(tmp + rename);Windows 上 rename 覆盖是原子的 */
export function saveGroups(groups, groupsPath) {
  mkdirSync(dirname(groupsPath), { recursive: true })
  const payload = { version: 1, updatedAt: new Date().toISOString(), groups }
  const tmp = `${groupsPath}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  renameSync(tmp, groupsPath)
  return payload
}

export function readGroups(groupsPath) {
  if (!existsSync(groupsPath)) return []
  const out = []
  for (const raw of readFile(groupsPath)) {
    const n = normalizeGroup(raw, { source: raw?.source === 'user' ? 'user' : (raw?.source ?? 'user') })
    if (n.ok) out.push(n.group)
  }
  return out
}

/**
 * 由描述符推导内置分组的出现顺序(按 schema 声明顺序,首次出现的位置定序)。
 * @returns {string[]} 去重后的 group id 列表
 */
export function builtinGroupOrder(descriptors = []) {
  const seen = new Set()
  const out = []
  for (const d of descriptors) {
    const g = String(d?.group ?? '').trim()
    if (!g || seen.has(g)) continue
    seen.add(g)
    out.push(g)
  }
  return out
}

/**
 * 合并三路来源 → 有序分组列表(唯一分组权威)。
 *
 * 覆盖优先级:plugin > persisted(user/用户定制) > builtin 默认。
 *  · plugin 组每次装载以插件声明为准(插件改标题/排序即刻生效)
 *  · builtin 组的标题/排序/折叠允许被 persisted 覆盖(管理员定制),但 source 恒为 builtin
 *  · persisted 里 source=plugin 且本轮插件未声明的 → 摘除(插件卸载不残留)
 *  · 描述符引用了未登记分组 → 兜底注册,字段不丢
 *
 * @param {object} o
 * @param {Array} o.descriptors      全部描述符(全局 + 插件)
 * @param {Array} o.persisted        持久化分组(含管理员定制)
 * @param {Array} o.pluginGroups     本轮插件声明的分组
 * @param {Map<string,string>} [o.pluginLabelById] 插件名 → 展示名(用于自动生成组标题)
 */
export function mergeGroups({ descriptors = [], persisted = [], pluginGroups = [], pluginLabelById = new Map() } = {}) {
  const out = new Map()

  // 1) 内置:声明顺序定序
  const builtin = builtinGroupOrder(descriptors)
  builtin.forEach((id, i) => {
    out.set(id, {
      id,
      label: id,
      description: '',
      order: (i + 1) * 10,
      collapsed: false,
      collapsible: true,
      icon: '',
      source: 'builtin',
    })
  })

  // 2) 持久化(管理员定制 + user 组);plugin 来源需等第 3 步确认存活
  const persistedById = new Map()
  for (const g of persisted) persistedById.set(g.id, g)

  // 3) 插件声明(权威覆盖)
  for (const g of pluginGroups) {
    const merged = { ...(persistedById.get(g.id) ?? {}), ...g, source: 'plugin' }
    const label = g.label && g.label !== g.id ? g.label : (pluginLabelById.get(g.plugin) ?? g.label)
    out.set(g.id, { ...merged, label: label || g.id })
  }

  // 4) 持久化里非插件组的定制覆盖内置默认(order 缺省时保留内置声明顺序)
  for (const [id, g] of persistedById) {
    if (g.source === 'plugin') continue // 交给第 3 步/第 5 步裁决
    const base = out.get(id)
    const order = g.order !== undefined ? g.order : base?.order
    if (base) {
      out.set(id, { ...base, ...g, order, source: base.source })
    }
    else {
      out.set(id, { ...g, order, source: g.source === 'user' ? 'user' : 'builtin' })
    }
  }

  // 5) 摘除本轮未声明的 plugin 组(插件卸载/停用)
  for (const [id, g] of out) {
    if (g.source !== 'plugin') continue
    const declared = pluginGroups.some(p => p.id === id) || builtin.includes(id)
    if (!declared) out.delete(id)
  }

  // 6) 兜底:描述符引用了未登记分组 → 就地注册,保证字段有归属
  builtin.forEach((id, i) => {
    if (!out.has(id)) {
      out.set(id, { id, label: id, description: '', order: (i + 1) * 10, collapsed: false, collapsible: true, icon: '', source: 'builtin' })
    }
  })

  return [...out.values()].sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id))
}

/** 分组 id 的默认落盘路径(与 runtime-settings.json 同目录) */
export function groupsPathFor(configRoot) {
  return join(configRoot, GROUPS_FILENAME)
}

export default {
  GROUPS_FILENAME,
  pluginGroupId,
  namespacedPluginGroupId,
  defaultPluginGroupId,
  normalizeGroup,
  readGroups,
  saveGroups,
  builtinGroupOrder,
  mergeGroups,
  groupsPathFor,
}
