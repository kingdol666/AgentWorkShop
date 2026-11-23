/**
 * 产线数据查询(GET /api/workshop/dcw/line/query)的时间窗归一。
 *
 * 起止缺省时不得落到 [1970, now]:那会对时序超表做全表聚合(共享 Timescale 实测
 * 10-15s,且数据量越大越慢),而任何登录用户都能触发。缺省按 24h 向前补齐;
 * 两端都给则原样使用,不改写调用方显式指定的窗口。
 */
export const LINE_QUERY_DEFAULT_WINDOW_MS = 24 * 3600_000

export interface LineQueryWindow {
  fromMs: number
  toMs: number
}

export function resolveLineQueryWindow(fromMs: number | undefined, toMs: number | undefined, nowMs: number = Date.now()): LineQueryWindow {
  const to = toMs ?? nowMs
  const from = fromMs ?? Math.max(0, to - LINE_QUERY_DEFAULT_WINDOW_MS)
  // from > to 不做交换:与 SQL 的 `ts >= from AND ts <= to` 同语义(空结果),不悄悄返回反向窗口的数据
  return { fromMs: from, toMs: to }
}
