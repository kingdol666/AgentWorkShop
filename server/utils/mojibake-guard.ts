/**
 * 乱码输入护栏:U+FFFD(REPLACEMENT CHARACTER)是 UTF-8 解码失败的产物,
 * 正常用户输入几乎不会出现。含大量 FFFD 的文本一旦进入 Agent 上下文,模型会
 * 陷入"字节考古"式思考(实测单会话空转 25 分钟+烧掉海量 token),必须在
 * 入口处拒绝并给出可读原因,而不是静默喂给 LLM。
 */
import { AppError } from './errors'

const FFFD = /\uFFFD/g

/** 返回文本中 U+FFFD 的出现次数 */
export function countReplacementChars(text: string): number {
  return (text.match(FFFD) ?? []).length
}

/**
 * 断言文本不是乱码:超过阈值即拒绝(400 INVALID_TEXT)。
 * 阈值默认 3:容忍极个别解码噪声,拦截成片损坏。
 */
export function assertNotMojibake(text: string, { threshold = 3, source = 'text' }: { threshold?: number, source?: string } = {}): void {
  const n = countReplacementChars(text)
  if (n >= threshold) {
    throw new AppError(
      400,
      'INVALID_TEXT',
      `${source} 含 ${n} 个损坏字符(U+FFFD),疑似客户端编码错误(如 GBK/UTF-8 混用),已拒绝投递:此类内容会诱导模型空转。请以 UTF-8 编码重新发送`,
    )
  }
}
