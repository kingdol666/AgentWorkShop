/**
 * 内置目录/种子的展示层翻译映射。
 *
 * 背景:模板目录(shared/daq-protocol、dcw-protocol)与内置种子(模板/编组/Channel 模板/
 * 插件 manifest)的 name/description 是服务端写入的中文数据,DB 记录不做翻译;
 * 但展示层可以按**稳定 key/id** 命中 i18n 词条 —— 未命中(用户自建/改名)回退原始名。
 * 词条在 locale 的 `tplCatalog` / `builtinSeeds` / `plugins` 命名空间。
 */

/** 数采/智控模板目录的稳定 key(shared 协议目录) */
export const TPL_CATALOG_IDS = new Set([
  'temp-tc',
  'pressure-tx',
  'tension-cell',
  'line-encoder',
  'vision-cam',
  'power-meter',
  'thickness-scan',
  'ccd-image',
  'temp-sp',
  'speed-sp',
  'tension-sp',
  'pressure-sp',
])

/** 内置 Agent 模板 id → 名称词条(server/db DEFAULT_AGENT_TEMPLATES + aml-team-seeds) */
export const SEED_NAME_KEYS: Record<string, string> = {
  'tpl-default-lead': 'builtinSeeds.tplDefaultLead',
  'tpl-default-backend': 'builtinSeeds.tplDefaultBackend',
  'tpl-default-frontend': 'builtinSeeds.tplDefaultFrontend',
  'tpl-default-qa': 'builtinSeeds.tplDefaultQa',
  'tpl-default-docs': 'builtinSeeds.tplDefaultDocs',
  'tpl-scenario-payment-lead': 'builtinSeeds.tplScenarioPaymentLead',
  'tpl-aml-lead': 'builtinSeeds.tplAmlLead',
  'tpl-aml-data': 'builtinSeeds.tplAmlData',
  'tpl-aml-trainer': 'builtinSeeds.tplAmlTrainer',
  'tpl-aml-eval': 'builtinSeeds.tplAmlEval',
  'team-default-fullstack': 'builtinSeeds.teamDefaultFullstack',
  'team-default-docs': 'builtinSeeds.teamDefaultDocs',
  'team-aml-shadow': 'builtinSeeds.teamAmlShadow',
  'chtpl-default-fullstack': 'builtinSeeds.chtplDefaultFullstack',
  'chtpl-default-review': 'builtinSeeds.chtplDefaultReview',
  'chtpl-preset-optical-film': 'builtinSeeds.chtplPresetOpticalFilm',
  'chtpl-preset-extrusion': 'builtinSeeds.chtplPresetExtrusion',
}

/** 内置 Channel 模板 id → 描述/场景预览词条 */
export const SEED_EXTRA_KEYS: Record<string, { desc?: string, scenario?: string }> = {
  'chtpl-default-fullstack': { desc: 'builtinSeeds.chtplDefaultFullstackDesc', scenario: 'builtinSeeds.chtplDefaultFullstackScenario' },
  'chtpl-default-review': { desc: 'builtinSeeds.chtplDefaultReviewDesc', scenario: 'builtinSeeds.chtplDefaultReviewScenario' },
  'chtpl-preset-optical-film': { desc: 'builtinSeeds.chtplPresetOpticalFilmDesc', scenario: 'builtinSeeds.chtplPresetOpticalFilmScenario' },
  'chtpl-preset-extrusion': { desc: 'builtinSeeds.chtplPresetExtrusionDesc', scenario: 'builtinSeeds.chtplPresetExtrusionScenario' },
}

/** 插件名 → 描述词条(manifest description 是服务端文件数据) */
export const PLUGIN_DESC_KEYS: Record<string, string> = {
  'line-sentinel': 'plugins.descLineSentinel',
  'ops-notifier': 'plugins.descOpsNotifier',
  'sample-insight': 'plugins.descSampleInsight',
  'diag-bridge': 'plugins.descDiagBridge',
  'rag-bridge': 'plugins.descRagBridge',
  'serial-bridge': 'plugins.descSerialBridge',
}

type NameLike = { key?: string, id?: string, name: string }

/** 内置角色/设备模型 id → 名称/提示词条(useCharacterAssets 内置目录;扫描项回退文件名) */
export const TOWN_MODEL_KEYS: Record<string, { name: string, hint?: string }> = {
  'knight': { name: 'builtinSeeds.mKnight' },
  'mage': { name: 'builtinSeeds.mMage' },
  'bot': { name: 'builtinSeeds.mBot' },
  'hero-3d': { name: 'builtinSeeds.mHero3d', hint: 'builtinSeeds.mHero3dHint' },
  'yangyang-walk': { name: 'builtinSeeds.mYangyang', hint: 'builtinSeeds.mYangyangHint' },
  'device-3d': { name: 'builtinSeeds.mDevice3d', hint: 'builtinSeeds.mDevice3dHint' },
}

/** 模型 hint 的兜底字面量(composable 里的固定中文提示)→ 词条 */
export const MODEL_HINT_FALLBACKS: Record<string, string> = {
  '设备实体(拖入场景生成数字孪生)': 'builtinSeeds.mDeviceFallbackHint',
  '角色 3D 模型(在频道成员管理中设置)': 'builtinSeeds.mScannedCharacterHint',
}

export function townModelName(tr: (k: string) => string, m: { id: string, name: string }): string {
  return TOWN_MODEL_KEYS[m.id]?.name ? tr(TOWN_MODEL_KEYS[m.id]!.name) : m.name
}

export function townModelHint(tr: (k: string) => string, m: { id: string, hint?: string }): string | undefined {
  const mapped = TOWN_MODEL_KEYS[m.id]?.hint
  if (mapped) return tr(mapped)
  const fallback = m.hint ? MODEL_HINT_FALLBACKS[m.hint] : undefined
  return fallback ? tr(fallback) : m.hint
}

/** 模板目录显示名:命中稳定 key 走 i18n,否则回退服务端名 */
export function catalogTplName(tr: (k: string) => string, t: NameLike): string {
  const k = t.key ?? t.id
  return (k && TPL_CATALOG_IDS.has(k)) ? tr(`tplCatalog.${k}`) : t.name
}

/** 内置种子记录显示名:命中稳定 id 走 i18n,否则回退原始名(用户自建/改名不翻译) */
export function seedName(tr: (k: string) => string, t: { id?: string, templateId?: string, name: string }): string {
  const k = SEED_NAME_KEYS[t.id ?? t.templateId ?? '']
  return k ? tr(k) : t.name
}
