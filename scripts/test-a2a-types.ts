/**
 * A2A 类型 + Agent 接口层测试(node + tsx 直跑,无浏览器)。
 *
 * 覆盖:
 *  1. Part 四变体(text/data/url/raw)构造与判别
 *  2. A2AMessage 往返 JSON 序列化(messageId/contextId/parts/metadata 保真)
 *  3. WorkspaceTask 默认值与 JSON 序列化
 *  4. AgentEvent 五变体(kind 判别 + 各字段类型收窄)
 *  5. SupervisionDecision 五变体判别
 *  6. AgentInterface 结构验证(mock 对象 run 返回 AsyncIterable 可迭代)
 */
import type { Part, A2AMessage, A2AArtifact } from '../server/services/workshop/types/a2a'
import type { TaskState, WorkspaceTask } from '../server/services/workshop/types/task'
import type {
  AgentEvent,
  AgentInfo,
  AgentInterface,
  AgentRunContext,
  AgentRunRequest,
  AgentWorkspace,
  SupervisionDecision,
  SupervisionSnapshot,
} from '../server/services/workshop/agents/agent-interface'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) {
    failures += 1
  }
}

/** 判别 Part 变体,返回其判别键(用于类型收窄验证) */
function partKind(part: Part): 'text' | 'data' | 'url' | 'raw' {
  if ('text' in part) return 'text'
  if ('data' in part) return 'data'
  if ('url' in part) return 'url'
  return 'raw'
}

function testPart(): void {
  console.log('\n--- 1. Part 四变体 ---')

  const text: Part = { text: 'hello', mediaType: 'text/plain', metadata: { k: 'v' } }
  const data: Part = { data: { n: 1 }, mediaType: 'application/json' }
  const url: Part = { url: 'https://example.com/a.png', mediaType: 'image/png', filename: 'a.png' }
  const raw: Part = { raw: 'base64==', mediaType: 'application/octet-stream', filename: 'b.bin' }

  check('text 变体判别', partKind(text) === 'text')
  check('text 变体字段收窄(string)', typeof text.text === 'string')
  check('text 变体 mediaType', text.mediaType === 'text/plain')
  check('text 变体 metadata', text.metadata?.k === 'v')

  check('data 变体判别', partKind(data) === 'data')
  check('data 变体字段收窄(unknown 承载任意值)', (data.data as { n: number }).n === 1)
  check('data 变体 mediaType', data.mediaType === 'application/json')

  check('url 变体判别', partKind(url) === 'url')
  check('url 变体字段收窄(string + filename)', typeof url.url === 'string' && url.filename === 'a.png')

  check('raw 变体判别', partKind(raw) === 'raw')
  check('raw 变体字段收窄(string + filename)', typeof raw.raw === 'string' && raw.filename === 'b.bin')
}

function testA2AMessage(): void {
  console.log('\n--- 2. A2AMessage 往返 JSON 序列化 ---')

  const msg: A2AMessage = {
    messageId: 'm-1',
    contextId: 'ch-1',
    taskId: 't-1',
    role: 'ROLE_AGENT',
    parts: [
      { text: 'hi' },
      { data: { x: 42 }, mediaType: 'application/json' },
      { url: 'https://x/y', filename: 'y' },
      { raw: 'AAAA', mediaType: 'application/octet-stream' },
    ],
    metadata: { 'x-aw-task-kind': 'assign', 'x-aw-task-id': 't-1' },
    extensions: ['ext-a'],
    referenceTaskIds: ['t-0'],
  }

  const roundtrip: A2AMessage = JSON.parse(JSON.stringify(msg))
  check('messageId 保真', roundtrip.messageId === 'm-1')
  check('contextId 保真', roundtrip.contextId === 'ch-1')
  check('taskId 保真', roundtrip.taskId === 't-1')
  check('role 保真', roundtrip.role === 'ROLE_AGENT')
  check('parts 长度保真', roundtrip.parts.length === 4)
  check('parts 内容保真(text)', (roundtrip.parts[0] as { text: string }).text === 'hi')
  check('parts 内容保真(data)', (roundtrip.parts[1] as { data: unknown }).data !== undefined)
  check('metadata 保真', roundtrip.metadata?.['x-aw-task-kind'] === 'assign')
  check('extensions 保真', roundtrip.extensions?.[0] === 'ext-a')
  check('referenceTaskIds 保真', roundtrip.referenceTaskIds?.[0] === 't-0')
}

function testWorkspaceTask(): void {
  console.log('\n--- 3. WorkspaceTask 默认值与 JSON 序列化 ---')

  const artifact: A2AArtifact = { artifactId: 'art-1', name: '报告', parts: [{ text: '成果' }] }
  const history: A2AMessage = { messageId: 'm-h', contextId: 'ch-1', role: 'ROLE_USER', parts: [{ text: '开始' }] }

  const task: WorkspaceTask = {
    id: 'task-1',
    channelId: 'ch-1',
    assigneeId: 'agent-a',
    creatorId: 'lead-1',
    title: '写周报',
    state: 'WORKING',
    progress: 0,
    retryCount: 0,
    artifacts: [artifact],
    history: [history],
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
  }

  // 可选字段(parentId/description)缺省为 undefined
  check('parentId 缺省为 undefined', task.parentId === undefined)
  check('description 缺省为 undefined', task.description === undefined)

  const roundtrip: WorkspaceTask = JSON.parse(JSON.stringify(task))
  check('id 保真', roundtrip.id === 'task-1')
  check('channelId 保真', roundtrip.channelId === 'ch-1')
  check('state 保真', roundtrip.state === 'WORKING')
  check('progress 保真', roundtrip.progress === 0)
  check('retryCount 保真', roundtrip.retryCount === 0)
  check('artifacts 保真', roundtrip.artifacts.length === 1 && roundtrip.artifacts[0].artifactId === 'art-1')
  check('history 保真', roundtrip.history.length === 1 && roundtrip.history[0].messageId === 'm-h')
  check('createdAt 保真', roundtrip.createdAt === '2026-08-13T00:00:00.000Z')

  // 终态枚举:TaskState 各取值均可赋值
  const states: TaskState[] = ['SUBMITTED', 'ASSIGNED', 'WORKING', 'WAITING', 'COMPLETED', 'FAILED', 'CANCELED']
  check('TaskState 七个枚举值', states.length === 7 && states.includes('COMPLETED') && states.includes('CANCELED'))
}

function testAgentEvent(): void {
  console.log('\n--- 4. AgentEvent 五变体 ---')

  const statusEvt: AgentEvent = { kind: 'status', status: { state: 'working', timestamp: '2026-08-13T00:00:00.000Z' } }
  const msgEvt: AgentEvent = { kind: 'message', message: { messageId: 'm-1', contextId: 'ch-1', role: 'ROLE_AGENT', parts: [{ text: 'hi' }] } }
  const artEvt: AgentEvent = { kind: 'artifact', artifact: { artifactId: 'art-1', parts: [{ text: 'x' }] }, append: true, lastChunk: false, totalChunks: 3 }
  const errEvt: AgentEvent = { kind: 'error', error: { code: 'X', message: 'boom' } }
  const doneEvt: AgentEvent = { kind: 'done', final: { taskId: 't-1' } }

  check('status 变体判别', statusEvt.kind === 'status')
  check('status 变体字段收窄(state/timestamp)', typeof statusEvt.status.state === 'string' && typeof statusEvt.status.timestamp === 'string')

  check('message 变体判别', msgEvt.kind === 'message')
  check('message 变体字段收窄(A2AMessage)', msgEvt.message.messageId === 'm-1')

  check('artifact 变体判别', artEvt.kind === 'artifact')
  check('artifact 变体字段收窄(artifact + 分块)', artEvt.artifact.artifactId === 'art-1' && artEvt.append === true && artEvt.lastChunk === false && artEvt.totalChunks === 3)

  check('error 变体判别', errEvt.kind === 'error')
  check('error 变体字段收窄(A2AError)', errEvt.error.code === 'X' && errEvt.error.message === 'boom')

  check('done 变体判别', doneEvt.kind === 'done')
  check('done 变体字段收窄(final.taskId)', doneEvt.final?.taskId === 't-1')

  // 泛化类型收窄:switch 后可安全访问各字段
  const events: AgentEvent[] = [statusEvt, msgEvt, artEvt, errEvt, doneEvt]
  let narrowed = true
  for (const ev of events) {
    switch (ev.kind) {
      case 'status':
        narrowed = narrowed && ev.status.state !== undefined
        break
      case 'message':
        narrowed = narrowed && ev.message.messageId !== undefined
        break
      case 'artifact':
        narrowed = narrowed && ev.artifact.artifactId !== undefined
        break
      case 'error':
        narrowed = narrowed && ev.error.code !== undefined
        break
      case 'done':
        narrowed = narrowed && ev.final !== undefined
        break
      default:
        narrowed = false
    }
  }
  check('五变体 switch 全收窄无遗漏', narrowed)
}

function testSupervisionDecision(): void {
  console.log('\n--- 5. SupervisionDecision 五变体判别 ---')

  const decisions: SupervisionDecision[] = [
    { kind: 'dispatch', parentTaskId: 'p-1', assigneeId: 'w-1', title: '子任务', description: 'd', parts: [{ text: 'x' }] },
    { kind: 'reassign', taskId: 't-1', toAgentId: 'w-2' },
    { kind: 'cancel', taskId: 't-2' },
    { kind: 'complete', taskId: 't-3', artifacts: [{ artifactId: 'a-1', parts: [{ text: 'r' }] }] },
    { kind: 'notify', toAgentId: 'w-3', parts: [{ text: '通知' }] },
  ]

  check('dispatch 判别', decisions[0].kind === 'dispatch')
  check('dispatch 字段(assigneeId/title/parts)', decisions[0].kind === 'dispatch' && decisions[0].assigneeId === 'w-1' && decisions[0].title === '子任务' && decisions[0].parts?.length === 1)

  check('reassign 判别', decisions[1].kind === 'reassign')
  check('reassign 字段(taskId/toAgentId)', decisions[1].kind === 'reassign' && decisions[1].taskId === 't-1' && decisions[1].toAgentId === 'w-2')

  check('cancel 判别', decisions[2].kind === 'cancel')
  check('cancel 字段(taskId)', decisions[2].kind === 'cancel' && decisions[2].taskId === 't-2')

  check('complete 判别', decisions[3].kind === 'complete')
  check('complete 字段(taskId/artifacts)', decisions[3].kind === 'complete' && decisions[3].taskId === 't-3' && decisions[3].artifacts?.length === 1)

  check('notify 判别', decisions[4].kind === 'notify')
  check('notify 字段(toAgentId/parts)', decisions[4].kind === 'notify' && decisions[4].toAgentId === 'w-3' && decisions[4].parts.length === 1)
}

async function testAgentInterface(): Promise<void> {
  console.log('\n--- 6. AgentInterface 结构验证 ---')

  const mockImpl: AgentInterface = {
    async* run(request: AgentRunRequest, _ctx: AgentRunContext): AsyncIterable<AgentEvent> {
      yield { kind: 'status', status: { state: 'running', timestamp: new Date().toISOString() } }
      yield { kind: 'message', message: request.message }
      yield { kind: 'done', final: { taskId: request.taskId } }
    },
    async supervise(snapshot: SupervisionSnapshot, _ctx: AgentRunContext): Promise<SupervisionDecision[]> {
      return snapshot.tasks.length === 0 ? [] : [{ kind: 'cancel', taskId: snapshot.tasks[0].id }]
    },
  }

  const agent: AgentInfo = { id: 'agent-a', channelId: 'ch-1', name: 'A', harness: 'mock', role: 'worker', config: {} }
  const workspace: AgentWorkspace = {
    listAgents: async () => [agent],
    dispatchTask: async () => { throw new Error('not implemented') },
    listTasks: async () => [],
    getTask: async () => { throw new Error('not implemented') },
    reportTask: async () => { throw new Error('not implemented') },
    completeTask: async () => { throw new Error('not implemented') },
    cancelTask: async () => { throw new Error('not implemented') },
    myQueue: async () => ({ agentId: 'agent-a', channelId: 'ch-1', queued: [], completed: [] }),
    queueOverview: async () => [],
    updateTask: async () => { throw new Error('not implemented') },
    reassignTask: async () => { throw new Error('not implemented') },
    sendMessage: async () => { throw new Error('not implemented') },
    pollMailbox: async () => [],
    listMail: async () => [],
    subscribe: async () => {},
    recallMemory: async () => [],
    saveMemory: async () => { throw new Error('not implemented') },
  }
  const ctx: AgentRunContext = { agentId: 'agent-a', channelId: 'ch-1', role: 'worker', workspace, signal: new AbortController().signal }

  const req: AgentRunRequest = {
    message: { messageId: 'm-1', contextId: 'ch-1', role: 'ROLE_USER', parts: [{ text: 'hi' }] },
    contextId: 'ch-1',
    fromAgentId: null,
    toAgentId: 'agent-a',
  }

  check('run 返回 AsyncIterable 且可迭代', typeof mockImpl.run(req, ctx)[Symbol.asyncIterator] === 'function')

  // 实际迭代收集事件
  const collected: AgentEvent[] = []
  for await (const ev of mockImpl.run(req, ctx)) {
    collected.push(ev)
  }
  check('迭代产出 3 个事件', collected.length === 3)
  check('事件顺序(status→message→done)', collected[0].kind === 'status' && collected[1].kind === 'message' && collected[2].kind === 'done')

  // supervise 可选实现
  check('supervise 可调用返回决策', mockImpl.supervise !== undefined)
  const decisions = await mockImpl.supervise!(
    { tick: 1, now: Date.now(), tasks: [], members: [], pendingChildren: {} },
    ctx,
  )
  check('supervise 空快照返回空数组', Array.isArray(decisions) && decisions.length === 0)

  // init/dispose 为可选方法
  check('init 可选(未实现为 undefined)', mockImpl.init === undefined)
  check('dispose 可选(未实现为 undefined)', mockImpl.dispose === undefined)
}

async function main(): Promise<void> {
  testPart()
  testA2AMessage()
  testWorkspaceTask()
  testAgentEvent()
  testSupervisionDecision()
  await testAgentInterface()

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
