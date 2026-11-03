/**
 * MES 映射模板库(H8,2026-11-03)。
 *
 * 目标:把"接一条 MES 点位"从手写三段 JSON(readMap/writeMap/historyMap)降为
 * "选模板 + 填端点/标签 + 按现场 API 文档微调路径"。模板只是**起点**——每家 MES
 * 的路径与字段名不同,导出物里始终带 notes 提示逐项核对,不假装开箱即用。
 *
 * 设计边界:
 *  - 纯函数、零 IO、零网络:apply 只生成 driverConfig 并做形状校验(不试连);
 *  - 不产出任何凭据明文:只写 secretRef 引用名(解析链见 mes-rest.ts);
 *  - 模板覆盖 REST 全谱(scalar/vector/image/cursor 分页/包装响应),不做 SOAP/私有协议。
 */
import { AppError } from '../../../utils/errors'
import type { DcwHistoryFormat } from '../dcw/drivers/shared'
import { validateMesMappingConfig } from '../dcw/drivers/mes-rest'

export interface MesTemplateParam {
  key: string
  label: string
  required?: boolean
  example: string
  description?: string
}

export interface MesTemplateBuildInput {
  /** MES 服务根地址(必填;http/https) */
  baseUrl?: string
  /** 点位/标签名;会替换路径里的 {tag} 占位符 */
  tag?: string
  /** 业务路径前缀(缺省模板内置,如 /api) */
  pathPrefix?: string
  /** 凭据引用名(零明文;token 从 AW_MES_<REF>_TOKEN 或设置 mes.secret.<ref> 解析) */
  secretRef?: string
  /** 认证方式:bearer(默认)/ header(自定义头)/ none */
  authType?: 'bearer' | 'header' | 'none'
  authHeaderName?: string
  /** 私有网段 MES 需显式打开(SSRF 防护) */
  allowPrivateHost?: boolean
  /** 字段字典路径(响应内;可选) */
  dictionaryPath?: string
  /** 限速/并发覆盖(H6) */
  rateLimitPerSec?: number
  maxConcurrent?: number
}

export interface MesTemplateBuildResult {
  /** 可直接 PUT/PATCH 到 dcw 节点的 driverConfig 片段(JSON 已字符串化) */
  driverConfig: Record<string, string | number | boolean>
  notes: string[]
}

export interface MesMappingTemplate {
  id: string
  name: string
  /** 覆盖的历史形态(目录展示/筛选) */
  formats: DcwHistoryFormat[]
  description: string
  params: MesTemplateParam[]
  build(input: MesTemplateBuildInput): MesTemplateBuildResult
}

const COMMON_PARAMS: MesTemplateParam[] = [
  { key: 'baseUrl', label: 'MES 服务地址', required: true, example: 'http://10.20.30.40:8080', description: '只接受 http/https;内网地址需 allowPrivateHost=true' },
  { key: 'tag', label: '点位/标签名', required: true, example: 'LINE1.TEMP_SP', description: '替换路径中的 {tag};通常就是 MES 侧的测点编码' },
  { key: 'pathPrefix', label: '业务路径前缀', example: '/api', description: '按现场 API 文档填写;模板默认值仅作示例' },
  { key: 'secretRef', label: '凭据引用名', example: 'line1.mes', description: '零明文:运行时从 AW_MES_<REF>_TOKEN 或设置 mes.secret.<ref> 解析' },
]

function baseConfig(input: MesTemplateBuildInput): Record<string, string | number | boolean> {
  const baseUrl = String(input.baseUrl ?? '').trim()
  if (!baseUrl) throw new AppError(400, 'BAD_REQUEST', 'baseUrl 必填:MES 服务地址(如 http://10.20.30.40:8080)')
  const cfg: Record<string, string | number | boolean> = { baseUrl }
  if (input.secretRef) cfg.secretRef = input.secretRef
  if (input.authType) cfg.authType = input.authType
  if (input.authHeaderName) cfg.authHeaderName = input.authHeaderName
  if (input.allowPrivateHost) cfg.allowPrivateHost = 'true'
  if (Number.isFinite(Number(input.rateLimitPerSec)) && Number(input.rateLimitPerSec) > 0) cfg.rateLimitPerSec = Number(input.rateLimitPerSec)
  if (Number.isFinite(Number(input.maxConcurrent)) && Number(input.maxConcurrent) > 0) cfg.maxConcurrent = Number(input.maxConcurrent)
  return cfg
}

function tagOf(input: MesTemplateBuildInput): string {
  const tag = String(input.tag ?? '').trim()
  if (!tag) throw new AppError(400, 'BAD_REQUEST', 'tag 必填:点位/标签名(替换路径中的 {tag})')
  return tag
}

function prefixOf(input: MesTemplateBuildInput, dflt: string): string {
  const p = String(input.pathPrefix ?? '').trim() || dflt
  return p.startsWith('/') ? p.replace(/\/+$/, '') : `/${p.replace(/\/+$/, '')}`
}

function withCommon(cfg: Record<string, string | number | boolean>, input: MesTemplateBuildInput, readMap: unknown, writeMap: unknown | null, historyMap: unknown | null): MesTemplateBuildResult {
  const out = { ...cfg }
  // 字段字典路径属于响应结构:read/history 两个映射共用同一个 dictionaryPath 声明
  if (input.dictionaryPath) {
    const rm = readMap as { response?: Record<string, unknown> }
    if (rm.response && rm.response.dictionaryPath === undefined) rm.response.dictionaryPath = input.dictionaryPath
    const hm = historyMap as { response?: Record<string, unknown> } | null
    if (hm?.response && hm.response.dictionaryPath === undefined) hm.response.dictionaryPath = input.dictionaryPath
  }
  out.readMap = JSON.stringify(readMap)
  if (writeMap) out.writeMap = JSON.stringify(writeMap)
  if (historyMap) out.historyMap = JSON.stringify(historyMap)
  return {
    driverConfig: out,
    notes: [
      '模板只提供路径/字段骨架;请按现场 MES API 文档核对 path、query 参数名与响应字段名(不一致时以实际响应为准改映射)。',
      '凭据零明文:secretRef 只保存引用名;token 通过 AW_MES_<REF>_TOKEN 环境变量或运行时设置 mes.secret.<ref> 提供。',
      '内网 MES 需显式 allowPrivateHost=true(SSRF 防护默认拒绝私有/环回地址)。',
    ],
  }
}

// ============================================================
// 模板定义
// ============================================================

const scalarSimple: MesMappingTemplate = {
  id: 'rest-scalar',
  name: '通用 REST 标量(读/写/历史)',
  formats: ['scalar'],
  description: 'GET /{tag} 返回 {value,timestamp};GET /{tag}/history 返回 {rows:[{ts,value}]};POST /{tag} 写 {value}.',
  params: COMMON_PARAMS,
  build(input) {
    const tag = tagOf(input)
    const p = prefixOf(input, '/api')
    const cfg = baseConfig(input)
    return withCommon(cfg, input, {
      method: 'GET',
      path: `${p}/tags/{tag}`,
      query: { tag },
      headers: {},
      response: { valuePath: 'value', tsPath: 'timestamp', tsFormat: 'iso' },
    }, {
      method: 'POST',
      path: `${p}/tags/{tag}`,
      query: { tag },
      headers: {},
      bodyTemplate: { value: '{{value}}' },
      successOn: [200, 201],
      response: { ackPath: 'ok' },
    }, {
      method: 'GET',
      path: `${p}/tags/{tag}/history`,
      query: { tag },
      response: { rowsPath: 'rows[*]', tsPath: 'ts', valuePath: 'value', format: 'scalar' },
      maxPages: 40,
    })
  },
}

const scalarWrapped: MesMappingTemplate = {
  id: 'rest-scalar-wrapped',
  name: '包装响应标量({data:{...}})',
  formats: ['scalar'],
  description: '响应统一包在 data 下:GET /{tag}/current → {data:{value,ts}},历史 → {data:{items:[...]}}.',
  params: COMMON_PARAMS,
  build(input) {
    const tag = tagOf(input)
    const p = prefixOf(input, '/api')
    const cfg = baseConfig(input)
    return withCommon(cfg, input, {
      method: 'GET',
      path: `${p}/points/{tag}/current`,
      query: { tag },
      headers: {},
      response: { valuePath: 'data.value', tsPath: 'data.ts', tsFormat: 'iso' },
    }, {
      method: 'POST',
      path: `${p}/points/{tag}/setpoint`,
      query: { tag },
      headers: {},
      bodyTemplate: { value: '{{value}}' },
      successOn: [200, 201],
      response: { ackPath: 'data.accepted' },
    }, {
      method: 'GET',
      path: `${p}/points/{tag}/history`,
      query: { tag },
      response: { rowsPath: 'data.items[*]', tsPath: 'ts', valuePath: 'value', format: 'scalar' },
      maxPages: 40,
    })
  },
}

const cursorPaged: MesMappingTemplate = {
  id: 'rest-cursor-paged',
  name: '游标分页历史(scalar/vector)',
  formats: ['scalar', 'vector'],
  description: '历史返回 {items:[...], nextCursor};按 pageSize 翻页直到 nextCursor 为空。',
  params: [...COMMON_PARAMS, { key: 'format', label: '历史形态', example: 'scalar 或 vector' }],
  build(input) {
    const tag = tagOf(input)
    const p = prefixOf(input, '/api')
    const cfg = baseConfig(input)
    const format = String((input as MesTemplateBuildInput & { format?: string }).format ?? 'scalar') === 'vector' ? 'vector' : 'scalar'
    return withCommon(cfg, input, {
      method: 'GET',
      path: `${p}/tags/{tag}`,
      query: { tag },
      headers: {},
      response: { valuePath: 'value', tsPath: 'ts', tsFormat: 'iso' },
    }, null, {
      method: 'GET',
      path: `${p}/tags/{tag}/history`,
      query: { tag, pageSize: '1000' },
      headers: {},
      response: format === 'vector'
        ? { rowsPath: 'items[*]', tsPath: 'ts', valuesPath: 'profile', format: 'vector', nextCursorPath: 'nextCursor' }
        : { rowsPath: 'items[*]', tsPath: 'ts', valuePath: 'value', format: 'scalar', nextCursorPath: 'nextCursor' },
      pageSize: 1000,
      maxPages: 40,
    })
  },
}

const vectorProfile: MesMappingTemplate = {
  id: 'rest-vector-profile',
  name: '检测向量断面(膜厚/光谱轮廓)',
  formats: ['vector'],
  description: '历史每行 = {ts, profile:[...], mean, ...};valuesPath=profile,行内伴随字段自动进 record.语义。',
  params: [...COMMON_PARAMS, { key: 'valuesPath', label: '向量数组路径', example: 'profile' }],
  build(input) {
    const tag = tagOf(input)
    const p = prefixOf(input, '/api')
    const cfg = baseConfig(input)
    const valuesPath = String((input as MesTemplateBuildInput & { valuesPath?: string }).valuesPath ?? 'profile').trim() || 'profile'
    return withCommon(cfg, input, {
      method: 'GET',
      path: `${p}/inspections/{tag}/latest`,
      query: { tag },
      headers: {},
      response: { valuePath: 'mean', tsPath: 'ts', tsFormat: 'iso' },
    }, null, {
      method: 'GET',
      path: `${p}/inspections/{tag}/history`,
      query: { tag },
      response: { rowsPath: 'rows[*]', tsPath: 'ts', valuesPath, format: 'vector' },
      maxPages: 40,
    })
  },
}

const imageFrame: MesMappingTemplate = {
  id: 'rest-image-frame',
  name: '图像帧(base64,CCD/表检)',
  formats: ['image'],
  description: '历史每行 = {ts, data(base64), mime, ...检测字段};像素按需落对象存储,行内检测字段进 record.',
  params: [...COMMON_PARAMS, { key: 'dataPath', label: 'base64 路径', example: 'data' }],
  build(input) {
    const tag = tagOf(input)
    const p = prefixOf(input, '/api')
    const cfg = baseConfig(input)
    const dataPath = String((input as MesTemplateBuildInput & { dataPath?: string }).dataPath ?? 'data').trim() || 'data'
    return withCommon(cfg, input, {
      method: 'GET',
      path: `${p}/cameras/{tag}/latest`,
      query: { tag },
      headers: {},
      response: { valuePath: 'defectCount', tsPath: 'ts', tsFormat: 'iso' },
    }, null, {
      method: 'GET',
      path: `${p}/cameras/{tag}/frames`,
      query: { tag },
      response: { rowsPath: 'frames[*]', tsPath: 'ts', dataPath, mimePath: 'mime', format: 'image' },
      maxPages: 20,
    })
  },
}

const opcenterStyle: MesMappingTemplate = {
  id: 'opcenter-style',
  name: 'Opcenter 风格执行 API(示例)',
  formats: ['scalar'],
  description: 'Siemens Opcenter Execution 风格路径骨架(/api/execution/v1/...);不同版本端点差异大,须按现场文档核对。',
  params: COMMON_PARAMS,
  build(input) {
    const tag = tagOf(input)
    const p = prefixOf(input, '/api/execution/v1')
    const cfg = baseConfig(input)
    const result = withCommon(cfg, input, {
      method: 'GET',
      path: `${p}/tags/{tag}/current`,
      query: { tag },
      headers: {},
      response: { valuePath: 'data.value', tsPath: 'data.timestamp', tsFormat: 'iso' },
    }, {
      method: 'POST',
      path: `${p}/tags/{tag}/commands`,
      query: { tag },
      headers: {},
      bodyTemplate: { command: 'SET', value: '{{value}}' },
      successOn: [200, 201, 202],
      response: { ackPath: 'data.accepted' },
    }, {
      method: 'GET',
      path: `${p}/tags/{tag}/history`,
      query: { tag },
      response: { rowsPath: 'data.items[*]', tsPath: 'timestamp', valuePath: 'value', format: 'scalar' },
      maxPages: 40,
    })
    result.notes.unshift('Opcenter 各版本/站点端点不同:此模板仅给路径骨架,接入前请用 mes-test-read / 驱动 test 逐项核对。')
    return result
  },
}

const TEMPLATES: MesMappingTemplate[] = [scalarSimple, scalarWrapped, cursorPaged, vectorProfile, imageFrame, opcenterStyle]

const BY_ID = new Map(TEMPLATES.map(t => [t.id, t]))

export interface MesTemplateBrief {
  id: string
  name: string
  formats: DcwHistoryFormat[]
  description: string
  params: MesTemplateParam[]
  /** 生成物包含的映射(能力位) */
  capabilities: { read: boolean, write: boolean, history: boolean }
}

/** 模板目录(不执行 build;API/文档/Agent 可见面) */
export function listMesTemplates(): MesTemplateBrief[] {
  return TEMPLATES.map((t) => {
    const sample = safeBuild(t)
    return {
      id: t.id,
      name: t.name,
      formats: t.formats,
      description: t.description,
      params: t.params,
      capabilities: {
        read: typeof sample?.driverConfig.readMap === 'string',
        write: typeof sample?.driverConfig.writeMap === 'string',
        history: typeof sample?.driverConfig.historyMap === 'string',
      },
    }
  })
}

/** 目录展示用:用占位参数试构建(失败不影响目录) */
function safeBuild(t: MesMappingTemplate): MesTemplateBuildResult | null {
  try {
    return t.build({ baseUrl: 'http://example.invalid', tag: 'TAG', secretRef: 'ref' })
  }
  catch {
    return null
  }
}

export interface MesTemplateApplyResult {
  templateId: string
  templateName: string
  /** 建议写入节点 driverConfig 的字段(映射已 JSON 字符串化) */
  driverConfig: Record<string, string | number | boolean>
  /** 校验结论(形状层;不联网) */
  validation: { ok: boolean, message: string }
  notes: string[]
  /** 冒烟步骤(人类/Agent 照做即可验证真实连通) */
  nextSteps: string[]
}

/**
 * 应用模板:生成 driverConfig 片段并做**形状校验**(不联网、不落盘)。
 * 端点连通性由 dcw 驱动的 test/试读完成。
 */
export function applyMesTemplate(id: string, input: MesTemplateBuildInput & Record<string, unknown> = {}): MesTemplateApplyResult {
  const tpl = BY_ID.get(String(id ?? '').trim())
  if (!tpl) {
    throw new AppError(404, 'NOT_FOUND', `未知 MES 映射模板:${String(id)}(可用:${TEMPLATES.map(t => t.id).join(' / ')})`)
  }
  const built = tpl.build(input)
  try {
    validateMesMappingConfig(built.driverConfig as Record<string, unknown>)
  }
  catch (err) {
    return {
      templateId: tpl.id,
      templateName: tpl.name,
      driverConfig: built.driverConfig,
      validation: { ok: false, message: err instanceof Error ? err.message : String(err) },
      notes: built.notes,
      nextSteps: ['修正模板参数后重新生成(映射形状非法,未通过配置期校验)。'],
    }
  }
  return {
    templateId: tpl.id,
    templateName: tpl.name,
    driverConfig: built.driverConfig,
    validation: { ok: true, message: '映射形状校验通过(未联网;连通性请用驱动 test/试读验证)' },
    notes: built.notes,
    nextSteps: [
      '把 driverConfig 写入目标 mes-rest 节点(PATCH /api/workshop/dcw/nodes/:id,或 ddw 节点编辑页)。',
      '调用驱动测试(POST /api/workshop/dcw/mes-test-read 或节点「试读」)确认 200 + valuePath 提取成功。',
      '用 mes_fetch 取一小窗历史,核对行数/字段字典/时间戳单位(epoch_s/epoch_ms/iso 选错会整体偏移)。',
      '确认无误后再开桥接(mes_bridge)把历史写入平台 TSDB 供训练/分析。',
    ],
  }
}
