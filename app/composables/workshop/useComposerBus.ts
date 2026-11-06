/**
 * Composer 指令总线:块工具条「引用到输入框」→ Composer 消费。
 * 模块级单例 ref(跨组件树;时间线块与 Composer 无父子关系)。
 */
import { ref } from 'vue'

const quoteText = ref<string | null>(null)
const draftText = ref<string | null>(null)

export function useComposerBus() {
  /** 请求把文本以引用形式带入 Composer */
  const quote = (text: string): void => {
    quoteText.value = text
  }

  /** 空态建议卡:把整段 prompt 带入输入框(不自动发送,仍由人确认) */
  const draft = (text: string): void => {
    draftText.value = text
  }

  return { quoteText, quote, draftText, draft }
}
