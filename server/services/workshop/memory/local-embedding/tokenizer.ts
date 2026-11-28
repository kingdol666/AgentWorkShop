/**
 * BERT WordPiece 分词器（零依赖，2026-11-28）。
 *
 * 只为本地向量模型服务：读 vocab.txt（每行一个词条，首行 [PAD]），实现 BERT 官方
 * BasicTokenizer + WordpieceTokenizer 的核心行为：
 *  - 控制字符清洗、空白归一；
 *  - 可选小写化（bge-zh 是有大小写的，不能无脑 lower）；
 *  - CJK 单字切分（中文没有空格，BERT 中文词表就是按单字建的）；
 *  - 标点独立成 token；
 *  - 贪心最长匹配 + `##` 续词，单 token 上限 100 字符，未登录 → [UNK]。
 *
 * 不做的事（与 HuggingFace 逐位一致的边缘项）：NFD 去重音、全角空格/零宽字符的
 * Unicode 归一。对本系统的用法（短查询 + 中文记忆正文）差异可忽略，且不做可以
 * 避免引入正则体积与不可控的归一陷阱。
 */
export interface EncodedText {
  ids: number[]
  attention: number[]
}

const MAX_CHARS_PER_WORD = 100

function isCjk(cp: number): boolean {
  return (cp >= 0x4E00 && cp <= 0x9FFF)
    || (cp >= 0x3400 && cp <= 0x4DBF)
    || (cp >= 0xF900 && cp <= 0xFAFF)
    || (cp >= 0x3040 && cp <= 0x30FF) // 假名（日文记忆场景）
    || (cp >= 0xAC00 && cp <= 0xD7AF) // 谚文
}

/** BERT `_is_punctuation`：ASCII 标点段 + Unicode P* 类别 */
function isPunctuation(cp: number): boolean {
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true
  return /\p{P}/u.test(String.fromCodePoint(cp))
}

function isWhitespace(cp: number): boolean {
  return cp === 0x20 || cp === 0x09 || cp === 0x0A || cp === 0x0D || /\s/u.test(String.fromCodePoint(cp))
}

export class WordPieceTokenizer {
  private readonly vocab = new Map<string, number>()
  private readonly padId: number
  private readonly unkId: number
  private readonly clsId: number
  private readonly sepId: number

  constructor(
    vocabText: string,
    private readonly opts: { lowercase: boolean, maxLength: number },
  ) {
    const lines = vocabText.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const token = lines[i]!
      if (token === '' && i > 0) continue
      if (!this.vocab.has(token)) this.vocab.set(token, i)
    }
    const need = (name: string, fallback: number): number => this.vocab.get(name) ?? fallback
    this.padId = need('[PAD]', 0)
    this.unkId = need('[UNK]', 100)
    this.clsId = need('[CLS]', 101)
    this.sepId = need('[SEP]', 102)
    if (this.vocab.size < 10) throw new Error('词表为空或格式异常（vocab.txt）')
  }

  get vocabSize(): number {
    return this.vocab.size
  }

  /** 基础切分：清洗 → 小写 → CJK 单字 → 标点独立 */
  private basicTokenize(text: string): string[] {
    // 控制字符与零宽字符直接剔除（不引入 Unicode 归一，理由见文件头）
    let cleaned = ''
    for (const ch of text) {
      const cp = ch.codePointAt(0)!
      if (cp <= 0x08 || cp === 0x0B || cp === 0x0C || (cp >= 0x0E && cp <= 0x1F) || cp === 0x7F) continue
      if (cp >= 0x200B && cp <= 0x200D) continue
      if (cp === 0xFEFF) continue
      cleaned += ch
    }
    const cased = this.opts.lowercase ? cleaned.toLowerCase() : cleaned
    const spaced: string[] = []
    for (const ch of cased) {
      const cp = ch.codePointAt(0)!
      if (isCjk(cp)) spaced.push(' ', ch, ' ')
      // 标点两侧插空：与 BERT 一致（中文标点也走这一步）
      else if (isPunctuation(cp)) spaced.push(' ', ch, ' ')
      else if (isWhitespace(cp)) spaced.push(' ')
      else spaced.push(ch)
    }
    return spaced.join('').split(/\s+/).filter(Boolean)
  }

  private wordPiece(token: string): string[] {
    if (token.length > MAX_CHARS_PER_WORD) return ['[UNK]']
    const out: string[] = []
    let start = 0
    while (start < token.length) {
      let end = token.length
      let matched: string | null = null
      while (start < end) {
        const piece = (start > 0 ? '##' : '') + token.slice(start, end)
        if (this.vocab.has(piece)) {
          matched = piece
          break
        }
        end--
      }
      if (matched === null) return ['[UNK]']
      out.push(matched)
      start = end
    }
    return out
  }

  /** 编码单条文本（含 [CLS]/[SEP]，按 batch 需求另行 padding） */
  encode(text: string): EncodedText {
    const pieces = ['[CLS]']
    for (const token of this.basicTokenize(text)) {
      for (const piece of this.wordPiece(token)) pieces.push(piece)
    }
    pieces.push('[SEP]')
    const capped = pieces.length > this.opts.maxLength ? pieces.slice(0, this.opts.maxLength - 1).concat(['[SEP]']) : pieces
    const ids = capped.map(p => this.vocab.get(p) ?? this.unkId)
    return { ids, attention: ids.map(() => 1) }
  }

  /** 批量编码并 padding 到批内最长（上限 maxLength） */
  encodeBatch(texts: string[]): { ids: bigint[][], attention: bigint[][], length: number } {
    const encoded = texts.map(t => this.encode(t))
    const length = Math.max(1, ...encoded.map(e => e.ids.length))
    const ids: bigint[][] = []
    const attention: bigint[][] = []
    for (const e of encoded) {
      const padCount = length - e.ids.length
      ids.push([...e.ids, ...Array.from({ length: padCount }, () => this.padId)].map(v => BigInt(v)))
      attention.push([...e.attention, ...Array.from({ length: padCount }, () => 0)].map(v => BigInt(v)))
    }
    return { ids, attention, length }
  }
}
