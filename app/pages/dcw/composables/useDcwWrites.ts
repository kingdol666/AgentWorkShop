import { reactive, ref } from 'vue'
import { useDcwStream } from '~/composables/workshop/useDcwStream'

/**
 * 写路径(直写 / 手动读 / 逐节点控制开关)—— 在飞节点 id 与错误/成功回显的唯一副本。
 * 读写都经 server 门控(暂停/锁定由后端拒绝),本地只做即时收敛与提示。
 */
export function useDcwWrites() {
  const { t } = useI18n()
  const dcw = useDcwStream()

  // ---------- 直写 ----------
  const setInputs = reactive<Record<string, number | ''>>({})
  const writingId = ref('')
  const writeError = ref('')
  const writeOk = ref('')

  async function doWrite(nodeId: string, value: number): Promise<void> {
    writingId.value = nodeId
    writeError.value = ''
    writeOk.value = ''
    try {
      const outcome = await dcw.write(nodeId, value)
      if (outcome.ok) {
        writeOk.value = t('dcwDetail.k1alcbyu182', { p0: dcw.nodeById(nodeId)?.name ?? nodeId, p1: outcome.message })
        setInputs[nodeId] = ''
      }
      else {
        writeError.value = t('dcwDetail.kl1e9x9183', { p0: dcw.nodeById(nodeId)?.name ?? nodeId, p1: outcome.message })
      }
    }
    catch (err) {
      writeError.value = apiErrorMessage(err)
    }
    finally {
      writingId.value = ''
    }
  }

  // ---------- 读取(读写集成的读半边:手动读 PLC 当前值,周期读由服务端调度) ----------
  const readingId = ref('')

  async function doRead(nodeId: string): Promise<void> {
    readingId.value = nodeId
    writeError.value = ''
    try {
      await dcw.readNode(nodeId)
    }
    catch (err) {
      writeError.value = apiErrorMessage(err)
    }
    finally {
      readingId.value = ''
    }
  }

  // ---------- 逐节点 控制开启/暂停 ----------
  const togglingId = ref('')
  /** 开启/暂停单个节点的控制:暂停后服务端拒绝一切下发(409 当前节点暂停),本地即时收敛状态 */
  async function toggleControl(nodeId: string, enabled: boolean): Promise<void> {
    togglingId.value = nodeId
    writeError.value = ''
    try {
      await dcw.patchNode(nodeId, { enabled })
      const n = dcw.nodeById(nodeId)
      if (n) {
        n.enabled = enabled
        if (!enabled) n.state = 'offline'
        else if (n.state === 'offline') n.state = 'idle'
      }
    }
    catch (err) {
      writeError.value = apiErrorMessage(err)
    }
    finally {
      togglingId.value = ''
    }
  }

  return { setInputs, writingId, writeError, writeOk, doWrite, readingId, doRead, togglingId, toggleControl }
}
