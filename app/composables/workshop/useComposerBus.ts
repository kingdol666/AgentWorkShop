/**
 * Composer 指令总线:块工具条「引用到输入框」→ Composer 消费。
 * 模块级单例 ref(跨组件树;时间线块与 Composer 无父子关系)。
 */
import { ref } from 'vue'

const quoteText = ref<string | null>(null)

export function useComposerBus() {
  /** 请求把文本以引用形式带入 Composer */
  const quote = (text: string): void => {
    quoteText.value = text
  }

  return { quoteText, quote }
}
