/**
 * scripts/experiments/gemma4-pipeline.mjs —— 本地 Gemma4 + omp harness 全系统实验 PIPELINE(一键复现)。
 *
 * 复现 2026-11-18 验收实验(gemma-4-12b-qat @ LM Studio,omp rpc,单实例串行):
 *   phase env     环境检查(models.yml 注册模型 id 可自愈;LM Studio 加载问题只报告不自动修复)、直连探针
 *   phase cleanup 清理本 PIPELINE 自有测试实例(pidfile+命令行+端口监听三重归属核验;并对旧 home 轮换)
 *   phase start   全新隔离实例(AW_MODE=home + fresh AW_HOME + 独立端口,带新鲜度 marker)并注册首个 admin
 *   phase accept  真实场景验收:Channel 通信/Project 模式/RSI 持续学习/产线治理(mock 模拟线)全链
 *   phase report  汇总 summary.json(evidence 目录内;失败路径同样落盘)
 *
 * 用法:
 *   node scripts/experiments/gemma4-pipeline.mjs                    # 全流程
 *   node scripts/experiments/gemma4-pipeline.mjs --phase cleanup    # 只做清理
 *   node scripts/experiments/gemma4-pipeline.mjs --port 3075 --model-id google/gemma-4-12b-qat
 *
 * 纪律:
 *  - 生命周期管理(cleanup/start)只作用于本脚本自己拉起并登记的实例(pidfile+命令行+端口监听三重核验);
 *    共享实例(3001/3003/4050/...)的端口绝不纳入生命周期管理(对 1234 的只读 chat 探针不算管理动作)。
 *  - 所有中文请求体经 Node fetch(JSON UTF-8);不要用 Git Bash curl -d 发中文(本地代码页乱码)。
 *  - 模型回合串行:每个真实回合等待终态/落定后再进入下一步,LM Studio parallel=1。
 */
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.NO_PROXY_LIST = '127.0.0.1,localhost'

// ---------- 参数 ----------
const argOf = (k, d) => {
  const i = process.argv.indexOf(k)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d
}

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PHASE = argOf('--phase', 'all')
const PORT = Number(argOf('--port', '3073'))
const MODEL_ID = argOf('--model-id', 'google/gemma-4-12b-qat')
const MODEL_PROVIDER = argOf('--provider', 'local')
const RUN_ROOT = resolve(argOf('--root', join(tmpdir(), 'aw-gemma4-pipeline')))
const HOME = resolve(argOf('--home', join(RUN_ROOT, 'home')))
const EVIDENCE = resolve(argOf('--evidence', join(REPO, 'docs', 'audit', 'evidence', '2026-11-18-gemma4-omp-rerun')))
const BASE = `http://127.0.0.1:${PORT}`
const PASSWORD = `Gemma4Pipeline-${Date.now().toString(36)}-session-key-64chars-abcdefghijklmnopqrstuvwxyz`
const AGENT_CFG = { provider: MODEL_PROVIDER, model: MODEL_ID, rpcMode: 'rpc' }

/** 受保护端口(共享实例/基础设施;PIPELINE 永不触碰) */
const PROTECTED_PORTS = new Set([3001, 3003, 3300, 4001, 4010, 4011, 4034, 4050, 1234, 1883, 5432, 9000])
const PIDFILE = join(RUN_ROOT, 'instance.pid')
const LOGFILE = join(RUN_ROOT, 'instance.log')

// ---------- 基础设施 ----------
mkdirSync(RUN_ROOT, { recursive: true })
mkdirSync(EVIDENCE, { recursive: true })

const log = (line) => {
  console.log(line)
  appendFileSync(join(EVIDENCE, 'run.log'), `${new Date().toISOString()} ${line}\n`)
}
const save = (name, obj) => {
  writeFileSync(join(EVIDENCE, name), JSON.stringify(obj, null, 1))
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function api(method, path, body, token, timeoutMs = 120_000) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await r.text()
  let json
  try {
    json = JSON.parse(text)
  }
  catch {
    json = { raw: text.slice(0, 2000) }
  }
  if (json && typeof json === 'object') json.httpStatus = r.status
  return json
}

async function pollUntil(fn, { timeoutMs = 120_000, everyMs = 3000, label = 'poll' } = {}) {
  const t0 = Date.now()
  let last = null
  for (;;) {
    try {
      last = await fn()
      if (last && last.done) return last
    }
    catch { /* 瞬态错误重试 */ }
    if (Date.now() - t0 > timeoutMs) {
      log(`[${label}] TIMEOUT ${Math.round((Date.now() - t0) / 1000)}s`)
      return { ...(last ?? {}), done: false, timeout: true }
    }
    await sleep(everyMs)
  }
}

function lmsPs() {
  const r = spawnSync('lms', ['ps'], { encoding: 'utf8', timeout: 30_000, shell: process.platform === 'win32' })
  return r.stdout ?? r.stderr ?? ''
}

// ---------- Phase: env ----------
async function phaseEnv() {
  log('── Phase env:环境检查 ──')
  const problems = []
  const ps = lmsPs()
  writeFileSync(join(EVIDENCE, 'env-lms-ps.txt'), ps)
  const modelLine = ps.split(/\r?\n/).find(l => l.includes(MODEL_ID))
  if (!modelLine || !modelLine.includes('65536')) {
    problems.push(`LM Studio 未以 65536 context 加载 ${MODEL_ID}。修复:lms unload ${MODEL_ID} && lms load ${MODEL_ID} -c 65536 --parallel 1 --gpu max -y`)
  }
  else {
    log(`model loaded: ${modelLine.trim()}`)
  }

  const ompVer = spawnSync('omp', ['--version'], { encoding: 'utf8', timeout: 30_000, shell: process.platform === 'win32' })
  writeFileSync(join(EVIDENCE, 'env-omp-version.txt'), ompVer.stdout ?? '')
  if (!/omp\//.test(ompVer.stdout ?? '')) problems.push(`omp 不可用:${(ompVer.stderr ?? ompVer.stdout ?? '').slice(0, 120)}`)
  else log(`omp: ${(ompVer.stdout ?? '').trim()}`)

  // models.yml 注册模型 id(缺失则追加 local provider 条目;先备份)
  const modelsYml = join(homedir(), '.omp', 'agent', 'models.yml')
  if (!existsSync(modelsYml)) {
    problems.push(`缺少 ${modelsYml}(omp provider 配置)`)
  }
  else {
    const yml = readFileSync(modelsYml, 'utf8')
    if (!yml.includes(`id: ${MODEL_ID}`)) {
      copyFileSync(modelsYml, `${modelsYml}.bak-pipeline`)
      const entry = [
        '      - id: ' + MODEL_ID,
        '        name: gemma-4-pipeline-64k',
        '        reasoning: false',
        '        input: [text]',
        '        contextWindow: 65536',
        '        maxTokens: 8192',
        '        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }',
        '',
      ].join('\n')
      writeFileSync(modelsYml, `${yml.replace(/\s*$/, '\n')}${entry}`)
      log(`models.yml 已注册 ${MODEL_ID}(备份 .bak-pipeline)`)
    }
    else {
      log(`models.yml 已含 ${MODEL_ID}`)
    }
    save('env-models-yml-redacted.yml', yml.split('\n').filter(l => !/apiKey/i.test(l)).join('\n'))
  }

  // 直连探针(reasoning 侧会消耗 token,max_tokens 需 >64)
  const probe = await fetch('http://127.0.0.1:1234/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL_ID, messages: [{ role: 'user', content: 'Reply with exactly: GEMMA4_OK' }], max_tokens: 160, temperature: 0 }),
    signal: AbortSignal.timeout(180_000),
  }).then(r => r.json())
  save('env-direct-probe.json', probe)
  const content = String(probe?.choices?.[0]?.message?.content ?? '')
  if (!content.trim()) problems.push(`直连探针空 content(finish=${probe?.choices?.[0]?.finish_reason})`)
  else log(`direct probe content=${JSON.stringify(content)} finish=${probe?.choices?.[0]?.finish_reason}`)

  if (problems.length) {
    for (const p of problems) log(`ENV PROBLEM: ${p}`)
    throw new Error('环境检查未通过(见 ENV PROBLEM)')
  }
  log('Phase env PASS')
}

// ---------- Phase: cleanup ----------
/** home 轮换(等待 + 重试;Windows 句柄延迟释放)。失败抛错,绝不静默用脏 home。 */
async function rotateHome() {
  if (!existsSync(HOME)) return
  const bak = `${HOME}.bak-${Date.now().toString(36)}`
  for (let i = 0; i < 4; i++) {
    await sleep(4000)
    try {
      renameSync(HOME, bak)
      log(`home rotated → ${bak}`)
      return
    }
    catch (e) {
      log(`home rotate retry#${i + 1} failed: ${e instanceof Error ? e.message.slice(0, 80) : e}`)
    }
  }
  throw new Error('home 轮换失败(句柄占用);请手动关闭占用进程后重跑 cleanup')
}

/** 查询 PORT 的监听进程 PID(无监听返回 null) */
function listenerPidOf() {
  const q = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`], { encoding: 'utf8', timeout: 30_000 })
  const n = Number((q.stdout ?? '').trim())
  return Number.isInteger(n) && n > 0 ? n : null
}

async function phaseCleanup() {
  log('── Phase cleanup:清理本 PIPELINE 测试实例 ──')
  if (PROTECTED_PORTS.has(PORT)) throw new Error(`端口 ${PORT} 受保护,拒绝操作`)
  const hasPidfile = existsSync(PIDFILE)
  const pid = hasPidfile ? Number(readFileSync(PIDFILE, 'utf8').trim()) : NaN
  if (!hasPidfile || !Number.isInteger(pid) || pid <= 0) {
    // pidfile 缺失/无效:仍需确认端口没有本 PIPELINE 的遗留监听,否则拒绝继续(防脏 home)
    const listener = listenerPidOf()
    if (listener) throw new Error(`端口 ${PORT} 有监听进程 pid=${listener} 但无有效 pidfile,拒绝盲目清理;请人工核对后处理`)
    log('无 pidfile 且端口无监听,跳过清理')
    await rotateHome()
    return
  }
  // 归属三重核验:pidfile pid == 端口监听者,且命令行是 index.mjs(PID 复用/漂移防御)
  const listener = listenerPidOf()
  const q = spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -ExpandProperty CommandLine`], { encoding: 'utf8', timeout: 30_000 })
  const cmdLine = (q.stdout ?? '').trim()
  if (!cmdLine.includes('.output/server/index.mjs') || (listener !== null && listener !== pid)) {
    log(`归属核验失败(cmdline=${cmdLine.slice(0, 80) || '进程不存在'} listener=${listener ?? '无'}),拒绝终止 pid=${pid};保留 pidfile 供人工排查`)
    return
  }
  const kill = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', timeout: 30_000 })
  log(`taskkill pid=${pid} exit=${kill.status}`)
  if (kill.status !== 0) {
    log('taskkill 未确认成功,保留 pidfile;不轮换 home(防脏数据)')
    return
  }
  writeFileSync(PIDFILE, '')
  await rotateHome()
}

// ---------- Phase: start ----------
async function phaseStart() {
  log('── Phase start:全新隔离实例 ──')
  if (PROTECTED_PORTS.has(PORT)) throw new Error(`端口 ${PORT} 受保护`)
  // 新鲜度保证:home 必须是本 PIPELINE 上一次成功启动后留下的(带 marker),
  // 否则视为脏 home,先轮换再启动——绝不静默复用陌生 home(会撞「注册闸已关闭」,实测踩过)。
  const marker = join(HOME, '.gemma4-pipeline-marker')
  if (existsSync(HOME) && !existsSync(marker)) await rotateHome()
  mkdirSync(HOME, { recursive: true })
  const health0 = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) }).then(r => r.json()).catch(() => null)
  if (health0?.data?.status === 'ok') {
    if (!existsSync(marker)) throw new Error(`端口 ${PORT} 已有健康实例但非本 PIPELINE 拉起(无 marker),拒绝复用;请先 --phase cleanup 或人工处理`)
    log(`端口 ${PORT} 已有健康实例(pipeline 复用)`)
    return
  }
  const out = openSync(LOGFILE, 'a')
  const child = spawn(process.execPath, ['.output/server/index.mjs'], {
    cwd: REPO,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
    env: {
      ...process.env,
      AW_MODE: 'home',
      AW_HOME: HOME,
      PORT: String(PORT),
      NUXT_SESSION_PASSWORD: PASSWORD,
      AW_ALLOW_PRIVATE_OUTBOUND: '1',
      BACKUP_DISABLED: '1',
    },
  })
  child.unref()
  closeSync(out)
  writeFileSync(PIDFILE, String(child.pid))
  log(`spawned pid=${child.pid} port=${PORT} home=${HOME}`)

  const health = await pollUntil(async () => {
    const j = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(4000) }).then(r => r.json()).catch(() => null)
    return { done: j?.data?.status === 'ok', health: j?.data }
  }, { timeoutMs: 120_000, everyMs: 3000, label: 'health' })
  if (!health.done) throw new Error('实例健康检查超时')
  save('env-health.json', health.health)
  log(`health ok version=${health.health?.version}`)

  // 凭据运行时生成:脚本只在本机隔离 home 上注册一次性账号,源码不留可用口令字面量。
  const adminPassword = `Gemma-${crypto.randomUUID()}!aA1`
  const reg = await api('POST', '/api/users/register', { name: 'Gemma Admin', email: `gemma-${Date.now().toString(36)}@aw.local`, password: adminPassword })
  save('env-register.json', { code: reg.code, role: reg.data?.user?.role, email: reg.data?.user?.email })
  const token = reg.data?.token
  if (reg.code !== 0 || !token) throw new Error(`admin 注册失败:${reg.message ?? ''}(home 非全新?先 --phase cleanup)`)
  writeFileSync(join(RUN_ROOT, 'token.txt'), token)
  writeFileSync(marker, new Date().toISOString())
  log(`admin 注册成功 role=${reg.data?.user?.role}`)
}

// ---------- 验收通用 ----------
const results = []
let acceptDb = null
const step = (id, name, pass, detail) => {
  results.push({ id, name, pass: Boolean(pass), detail: String(detail ?? '').slice(0, 900) })
  log(`${pass ? 'PASS' : 'FAIL'} ${id} ${name} :: ${String(detail ?? '').slice(0, 280).replace(/\n/g, ' ')}`)
  return Boolean(pass)
}

function ompModelProvenance(sinceMs) {
  // 扫描 omp sessions 目录,mtime>sinceMs 且属于**本实例工作区**(repo data/workspaces)的 JSONL,
  // 提取 assistant provider/model 集合。不过滤会把机器上其他 demo 的旧会话误计进来(实测踩过)。
  const root = join(homedir(), '.omp', 'agent', 'sessions')
  if (!existsSync(root)) return []
  const out = []
  for (const dir of readdirSync(root)) {
    if (!dir.includes('AgentWorkShop-data-workspaces')) continue
    const d = join(root, dir)
    let files
    try {
      files = readdirSync(d).filter(f => f.endsWith('.jsonl'))
    }
    catch { continue }
    for (const f of files) {
      try {
        const p = join(d, f)
        if (statSync(p).mtimeMs < sinceMs) continue
        const models = new Set()
        for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
          try {
            const j = JSON.parse(line)
            if (j?.type === 'message' && j.message?.role === 'assistant' && j.message?.model) models.add(`${j.message.provider}/${j.message.model}`)
          }
          catch { /* 忽略坏行 */ }
        }
        if (models.size) out.push({ file: f, dir: dir.slice(0, 60), models: [...models] })
      }
      catch { /* 单文件读取失败不阻断取证 */ }
    }
  }
  return out
}

async function invokeTool(agentId, tool, args, token, timeoutMs = 600_000) {
  const t0 = Date.now()
  const r = await api('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args }, token, timeoutMs)
  const text = String(r.data?.result?.text ?? r.data?.text ?? JSON.stringify(r))
  const isError = r.data?.result?.isError === true || r.data?.isError === true || r.code !== 0
  return { text, isError, ms: Date.now() - t0, raw: r }
}

async function waitLease(channelId, taskId, token, timeoutMs = 90_000) {
  return pollUntil(async () => {
    const list = await api('GET', `/api/workshop/channels/${channelId}/tasks`, undefined, token)
    const t = (list.data ?? []).find(x => x.id === taskId)
    return { done: Boolean(t?.executionLeaseAgentId) || t?.state === 'WORKING', state: t?.state }
  }, { timeoutMs, everyMs: 2000, label: `lease-${taskId.slice(0, 8)}` })
}

/** assignee(lead)agent token 经 REST 收口任务;完成后停运行时释放模型 */
async function completeTaskRest(channelId, leadAgentId, taskId, text, token) {
  const tok = await api('POST', `/api/workshop/channels/${channelId}/agents/${leadAgentId}/rotate-token`, {}, token)
  const at = tok.data?.token
  if (!at) return { ok: false, detail: 'rotate-token 失败' }
  const r = await fetch(`${BASE}/api/workshop/tasks/${taskId}/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${at}` },
    body: JSON.stringify({ artifacts: [{ artifactId: crypto.randomUUID(), name: 'deliverable', parts: [{ text }] }] }),
    signal: AbortSignal.timeout(60_000),
  }).then(x => x.json())
  await api('POST', `/api/workshop/channels/${channelId}/agents/${leadAgentId}/stop`, {}, token).catch(() => {})
  return { ok: r.code === 0, detail: `${r.code} ${r.data?.state ?? ''} ${r.message ?? ''}` }
}

// ---------- Phase: accept ----------
async function phaseAccept() {
  log('── Phase accept:真实场景验收 ──')
  const token = readFileSync(join(RUN_ROOT, 'token.txt'), 'utf8').trim()
  const t0 = Date.now()

  // ===== Channel(非产线) =====
  const ch = await api('POST', '/api/workshop/channels', {
    name: 'Gemma4 复现验收频道',
    channelMode: 'generic',
    scenarioPrompt: '你是 AgentWorkShop 的协作成员。回答简洁、直接,不需要调用工具。',
    leadAgent: { name: 'Gemma Lead', harness: 'omp', config: AGENT_CFG },
  }, token)
  const channelId = ch.data?.channelId ?? ch.data?.id
  step('C1', '创建非产线 Channel(omp+gemma lead)', Boolean(channelId), `channel=${channelId}`)
  if (!channelId) throw new Error('accept abort: channel 创建失败')
  await api('POST', `/api/workshop/channels/${channelId}/agents`, { name: 'Gemma Worker', harness: 'omp', role: 'worker', config: AGENT_CFG }, token)
  const agents = (await api('GET', `/api/workshop/channels/${channelId}/agents`, undefined, token)).data ?? []
  const lead = agents.find(a => a.role === 'lead')
  const workerAgent = agents.find(a => a.role === 'worker')
  save('channel-agents.json', agents)
  step('C2', 'lead+worker 绑定 local/gemma(rpc)', Boolean(lead?.id && workerAgent?.id) && agents.every(a => a.config?.model === MODEL_ID && a.config?.provider === MODEL_PROVIDER), JSON.stringify(agents.map(a => ({ n: a.name, m: a.config?.model }))))
  if (!lead?.id || !workerAgent?.id) throw new Error('accept abort: 频道成员缺失')

  // baseline 真实回合(lead)
  const sub1 = await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
    title: '常识问答:水沸点', description: '请用一句话回答:标准大气压下水的沸点是多少摄氏度?只回答数字和单位。不要调用工具。',
    mode: 'goal', modeConfig: { completionPolicy: 'no-deliverable' }, fromLabel: '验收员',
  }, token)
  const t1 = sub1.data?.id
  const done1 = await pollUntil(async () => {
    const list = await api('GET', `/api/workshop/channels/${channelId}/tasks`, undefined, token)
    const t = (list.data ?? []).find(x => x.id === t1)
    return { done: ['COMPLETED', 'FAILED', 'CANCELED', 'BLOCKED', 'EXPIRED'].includes(t?.state), task: t, state: t?.state }
  }, { timeoutMs: 30 * 60_000, everyMs: 15_000, label: 'lead-turn' })
  save('channel-lead-task.json', done1.task ?? {})
  const art1 = JSON.stringify(done1.task?.artifacts ?? [])
  step('C3', 'lead 真实回合完成(水沸点=100°C)', done1.state === 'COMPLETED' && /100/.test(art1), `state=${done1.state} artifacts=${art1.slice(0, 180)}`)

  // worker 群聊回合
  await api('PATCH', `/api/workshop/channels/${channelId}`, { chatEnabled: 1 }, token)
  const post = await api('POST', `/api/workshop/channels/${channelId}/chat/messages`, {
    text: '请回答一个简单问题:4 乘以 6 等于多少?只输出最终数字。不要调用工具。',
    mentions: [{ type: 'agent', id: workerAgent.id, label: workerAgent.name }],
    clientMessageId: crypto.randomUUID(),
  }, token)
  const chatReply = await pollUntil(async () => {
    const h = await api('GET', `/api/workshop/channels/${channelId}/chat/messages?limit=40`, undefined, token)
    const list = h.data?.messages ?? []
    const mine = list.find(x => x.id === post.data?.message?.id)
    const rep = list.find(x => x.senderType === 'agent' && x.senderId === workerAgent.id && mine && new Date(x.createdAt) >= new Date(mine.createdAt))
    return { done: Boolean(rep), rep }
  }, { timeoutMs: 20 * 60_000, everyMs: 10_000, label: 'worker-chat' })
  save('channel-worker-chat.json', chatReply.rep ?? {})
  step('C4', 'worker 群聊真实回合(4×6=24)', /24/.test(String(chatReply.rep?.text ?? '')), `reply=${String(chatReply.rep?.text ?? '').slice(0, 100)}`)

  // A2A 即时消息(禁工具,保证回执干净)
  const before = (await api('GET', `/api/workshop/channels/${channelId}/messages?limit=50`, undefined, token)).data ?? []
  await api('POST', `/api/workshop/channels/${channelId}/messages`, {
    fromAgentId: lead.id, toAgentId: workerAgent.id,
    text: 'A2A 回执测试。请不要调用任何工具,只输出一行纯文本:OK-A2A-9。',
    priority: 'immediate', requireReply: true,
  }, token)
  const a2a = await pollUntil(async () => {
    const list = (await api('GET', `/api/workshop/channels/${channelId}/messages?limit=50`, undefined, token)).data ?? []
    const fresh = list.filter(m => !before.some(b => b.id === m.id))
    const rep = fresh.find(m => m.fromAgentId === workerAgent.id && (m.parts ?? []).some(p => String(p.text ?? '').includes('OK-A2A-9')))
    return { done: Boolean(rep), rep }
  }, { timeoutMs: 15 * 60_000, everyMs: 10_000, label: 'a2a' })
  save('channel-a2a-reply.json', a2a.rep ?? {})
  step('C5', 'A2A requireReply 回执(OK-A2A-9)', Boolean(a2a.rep), String((a2a.rep?.parts ?? [{}])[0]?.text ?? '').slice(0, 100))

  // 双 Session 隔离
  const sA = (await api('POST', `/api/workshop/channels/${channelId}/sessions`, { title: '会话A-暗号' }, token)).data
  const sB = (await api('POST', `/api/workshop/channels/${channelId}/sessions`, { title: '会话B-追问' }, token)).data
  if (!sA?.sessionId || !sB?.sessionId) throw new Error('accept abort: 会话创建失败')
  // 注意:注入的提示语会立即出现在 history 里,不能把「新条目」当回复;
  // 必须找**文本不同于提示语**的条目(即模型真实回复)。
  const waitSessionReply = async (sid, promptText) => pollUntil(async () => {
    const h = await api('GET', `/api/workshop/channels/${channelId}/sessions/${sid}/history?limit=50`, undefined, token)
    const list = h.data ?? []
    const rep = list.find(x => String(x.text ?? '').trim() && String(x.text) !== promptText)
    return { done: Boolean(rep), list, rep }
  }, { timeoutMs: 20 * 60_000, everyMs: 10_000, label: `session-${sid.slice(0, 8)}` })
  const promptA = '请记住这个暗号:ALPHA-7。只回复"收到 ALPHA-7"。不要调用工具。'
  await api('POST', `/api/workshop/channels/${channelId}/sessions/${sA.sessionId}/messages`, { text: promptA, clientMessageId: crypto.randomUUID() }, token)
  const rA = await waitSessionReply(sA.sessionId, promptA)
  save('channel-sessionA.json', { prompt: promptA, reply: rA.rep ?? null, history: rA.list ?? [] })
  step('C6', 'SessionA 真实回合(收到 ALPHA-7)', rA.rep && /收到\s*ALPHA-7/.test(String(rA.rep.text)), `reply=${String(rA.rep?.text ?? '(未等到回复)').slice(0, 80)}`)
  const promptB = '我们之前约定的暗号是什么?如果不知道请只回答"不知道"。不要调用工具。'
  await api('POST', `/api/workshop/channels/${channelId}/sessions/${sB.sessionId}/messages`, { text: promptB, clientMessageId: crypto.randomUUID() }, token)
  const rB = await waitSessionReply(sB.sessionId, promptB)
  save('channel-sessionB.json', { prompt: promptB, reply: rB.rep ?? null, history: rB.list ?? [] })
  const blockA = ((await api('GET', `/api/workshop/channels/${channelId}/sessions/${sA.sessionId}/brief?format=block`, undefined, token)).data ?? {}).block ?? ''
  const blockB = ((await api('GET', `/api/workshop/channels/${channelId}/sessions/${sB.sessionId}/brief?format=block`, undefined, token)).data ?? {}).block ?? ''
  save('channel-session-blocks.json', { A: blockA, B: blockB })
  step('C7', 'Session 隔离(B 不知道暗号,brief 无泄漏)', rB.rep && /不知道/.test(String(rB.rep.text)) && blockA.includes('ALPHA-7') && !blockB.includes('ALPHA-7'), `reply=${String(rB.rep?.text ?? '(未等到回复)').slice(0, 60)} A块含=${blockA.includes('ALPHA-7')} B块含=${blockB.includes('ALPHA-7')}`)

  // ===== Project(非产线) =====
  const proj = await api('POST', '/api/workshop/projects', {
    name: 'Gemma4 复现验收项目',
    objective: '在非产线协作频道内完成一次简单的交付:计算 7×8 并给出可复核的成果说明',
    successCriteria: ['deliverable.submitted', 'project.completed'],
    mode: 'supervised', leaderHarness: 'omp', leaderConfig: AGENT_CFG, routingPolicy: 'technical',
  }, token)
  const projectId = proj.data?.id
  step('P1', 'Project 创建(omp leader+gemma)', Boolean(projectId), `project=${projectId}`)
  await api('POST', `/api/workshop/projects/${projectId}/channels`, { channelId, charter: '非产线协作:简单交付' }, token)
  const del = await api('POST', `/api/workshop/projects/${projectId}/deliverables`, { name: '7×8 计算成果', ownerChannelId: channelId, acceptanceCriteria: ['artifact.present'] }, token)
  step('P2', '交付物创建+频道绑定', Boolean(del.data?.id), `deliverable=${del.data?.id}`)
  await api('POST', `/api/workshop/projects/${projectId}/activate`, {}, token)

  // 真实 leader 规划(office continue → plan_approval)
  await api('POST', `/api/workshop/projects/${projectId}/continue`, {
    message: '请调用 project_propose_plan 提交 V1 计划:交付物「7×8 计算成果」;工作项由你规划(直接完成即可,不需要拆分)。除 project_propose_plan 外不要调用其他工具。提交后等待 owner 批准,不要自行修改项目状态。',
    clientMessageId: 'plan-1',
  }, token)
  let planApproval = null
  for (let i = 0; i < 3 && !planApproval; i++) {
    // tick 超时后重发 continue(更强硬的指令):12B 模型偶发退化(如 <unused49> 重复),
    // 不重发的话 leader 没有新消息、永远不会重试规划(实测踩过)。
    if (i > 0) {
      await api('POST', `/api/workshop/projects/${projectId}/continue`, {
        message: `你上一回合没有产出计划审批(输出异常,第 ${i} 次重试)。请立即调用 project_propose_plan 工具提交 V1 计划:交付物「7×8 计算成果」;工作项 1 个:计算 7×8 并提交成果(直接完成)。除 project_propose_plan 外不要调用其他工具。`,
        clientMessageId: `plan-retry-${i}`,
      }, token)
      log(`[pacing] plan tick#${i} 超时,已重发规划指令`)
    }
    const got = await pollUntil(async () => {
      const list = await api('GET', `/api/workshop/projects/${projectId}/approvals`, undefined, token)
      const item = (list.data ?? []).find(x => x.kind === 'plan_approval' && x.status === 'pending')
      return { done: Boolean(item), item }
    }, { timeoutMs: 12 * 60_000, everyMs: 10_000, label: `plan-tick-${i + 1}` })
    planApproval = got.item ?? null
    if (!planApproval) await api('POST', `/api/workshop/projects/${projectId}/kernel/tick`, {}, token)
  }
  save('project-plan-approval.json', planApproval ?? {})
  step('P3', '真实 leader 提出 V1 计划', Boolean(planApproval), `approval=${planApproval?.id}`)
  if (!planApproval) throw new Error('leader 未产出计划(超时)')
  await api('POST', `/api/workshop/projects/${projectId}/approvals/${planApproval.id}/decide`, { approve: true, reason: '验收:计划批准' }, token)
  await api('POST', `/api/workshop/projects/${projectId}/kernel/tick`, {}, token)
  const wiPoll = await pollUntil(async () => {
    const list = await api('GET', `/api/workshop/projects/${projectId}/work-items`, undefined, token)
    const item = (list.data ?? []).find(x => x.planVersion === 1)
    return { done: Boolean(item), item }
  }, { timeoutMs: 60_000, everyMs: 3000, label: 'materialize' })
  const workItem = wiPoll.item
  step('P4', '计划批准并物化工作项', Boolean(workItem?.id), `workItem=${workItem?.id} state=${workItem?.state}`)
  if (!workItem?.id) throw new Error('accept abort: 工作项未物化')

  const disp = await api('POST', `/api/workshop/projects/${projectId}/work-items/${workItem.id}/dispatch`, {}, token)
  step('P5', '工作项派发', disp.code === 0, `state=${disp.data?.state}`)
  acceptDb = new DatabaseSync(join(HOME, 'data', 'workshop.sqlite'))
  acceptDb.exec('PRAGMA busy_timeout = 5000')
  const attempt = await pollUntil(() => {
    const row = acceptDb.prepare('SELECT channel_id AS channelId, channel_task_id AS taskId FROM project_work_item_attempts WHERE work_item_id = ? ORDER BY attempt_no DESC LIMIT 1').get(workItem.id)
    return { done: Boolean(row?.taskId), row }
  }, { timeoutMs: 90_000, everyMs: 3000, label: 'attempt' })
  const inst = attempt.row ?? {}
  step('P6', '项目实例任务生成', Boolean(inst.taskId), `instance=${inst.channelId} task=${inst.taskId}`)
  if (!inst.taskId || !inst.channelId) throw new Error('accept abort: 项目实例任务未生成')

  const instLeadRow = acceptDb.prepare('SELECT id FROM channel_agents WHERE channel_id = ? AND role = \'lead\'').get(inst.channelId)
  await waitLease(inst.channelId, inst.taskId, token)
  const closed = await completeTaskRest(inst.channelId, instLeadRow?.id, inst.taskId,
    '7 × 8 的计算过程与说明。\n一、问题:计算 7 与 8 的乘积并给出可复核过程。\n二、过程:7 × 8 即 7 连续相加 8 次:7+7=14;14+7=21;21+7=28;28+7=35;35+7=42;42+7=49;49+7=56。因此 7*8=56。\n三、交叉校验:交换律 8×7=56;分解法 7×(10−2)=70−14=56;平方差 (7.5−0.5)(7.5+0.5)=56.25−0.25=56。三法互证一致。\n四、结论:7*8=56。\n五、边界:纯算术推理,未调用外部数据源与产线工具。本说明由验收方在模型 write 工具协议失败后人工收口写入(见报告边界节)。',
    token)
  save('project-instance-complete.json', closed)
  step('P7', '实例任务完成(REST 收口,已披露)', closed.ok, closed.detail)
  await api('POST', `/api/workshop/projects/${projectId}/reconcile`, {}, token)
  const draft = await pollUntil(async () => {
    const list = await api('GET', `/api/workshop/projects/${projectId}/results`, undefined, token)
    const item = (list.data ?? []).find(x => x.workItemId === workItem.id && x.status === 'draft')
    return { done: Boolean(item), item }
  }, { timeoutMs: 60_000, everyMs: 3000, label: 'draft' })
  step('P8', '结果 draft 生成', Boolean(draft.item?.id), `result=${draft.item?.id}`)
  if (!draft.item?.id) throw new Error('accept abort: 结果 draft 未生成')

  await api('POST', `/api/workshop/projects/${projectId}/results/${draft.item.id}/submit`, { title: '7×8 计算成果', summary: '7*8=56;三种方法互证。', method: '算术推导+交叉校验', validityScope: '非产线演示' }, token)
  const rev = await api('POST', `/api/workshop/projects/${projectId}/results/${draft.item.id}/review`, { decision: 'reviewed', reason: 'L1 技术复核:正文含 7*8=56' }, token)
  step('P9', 'L1 技术复核(reviewed)', rev.data?.status === 'reviewed', `status=${rev.data?.status}`)
  const accReq = await api('POST', `/api/workshop/projects/${projectId}/results/${draft.item.id}/request-acceptance`, {}, token)
  const accId = accReq.data?.id ?? accReq.data?.approvalId
  // 自批负例(owner 决策自己提交的成果 → SELF_APPROVAL_FORBIDDEN)
  const selfDec = await api('POST', `/api/workshop/projects/${projectId}/approvals/${accId}/decide`, { approve: true, reason: '自批负例' }, token)
  save('project-self-approval.json', { code: selfDec.code, message: selfDec.message })
  step('P10', '自批被拒(SELF_APPROVAL_FORBIDDEN)', selfDec.code === 'SELF_APPROVAL_FORBIDDEN', `code=${selfDec.code}`)
  // approver 用户 + L2
  const approverPassword = `Approver-${crypto.randomUUID()}!aA1`
  const apUser = await api('POST', '/api/users', { name: 'Approver One', email: `approver-${Date.now().toString(36)}@aw.local`, password: approverPassword, role: 'user', status: 'active' }, token)
  const apLogin = await api('POST', '/api/users/login', { email: apUser.data?.email, password: approverPassword }, token)
  const apToken = apLogin.data?.token
  await api('POST', `/api/workshop/projects/${projectId}/members`, { userId: apUser.data?.id, role: 'approver' }, token)
  const apDec = await fetch(`${BASE}/api/workshop/projects/${projectId}/approvals/${accId}/decide`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${apToken}` },
    body: JSON.stringify({ approve: true, reason: 'L2 成果验收通过(approver)' }), signal: AbortSignal.timeout(60_000),
  }).then(x => x.json())
  save('project-l2-decide.json', apDec)
  step('P11', 'L2 成果验收(approver 批准)', apDec.code === 0 && apDec.data?.status === 'approved', `status=${apDec.data?.status}`)
  const dels1 = await api('GET', `/api/workshop/projects/${projectId}/deliverables`, undefined, token)
  step('P12', '交付物 approved(全工作项终态)', (dels1.data ?? []).length > 0 && (dels1.data ?? []).every(d => d.status === 'approved'), JSON.stringify((dels1.data ?? []).map(d => d.status)))
  const comp = await api('POST', `/api/workshop/projects/${projectId}/complete`, {}, token)
  const compId = comp.data?.id ?? comp.data?.approvalId
  const compDec = compId ? await api('POST', `/api/workshop/projects/${projectId}/approvals/${compId}/decide`, { approve: true, reason: '项目完成' }, token) : { data: {} }
  const fin = await api('GET', `/api/workshop/projects/${projectId}`, undefined, token)
  save('project-final.json', fin.data ?? {})
  step('P13', 'Project completed', fin.data?.status === 'completed', `status=${fin.data?.status} completeDec=${compDec.data?.status ?? comp.message}`)
  const rep = await api('GET', `/api/workshop/projects/${projectId}/report`, undefined, token)
  save('project-report.json', rep.data ?? {})
  step('P14', '项目报告可查', rep.code === 0, JSON.stringify(rep.data?.progress ?? {}))

  // ===== 产线(mock 隔离模拟线) =====
  const HOLD_WINDOW_MS = 120_000
  const TRIAL_CADENCE_MS = 300_000
  const tag = `pp-${Date.now().toString(36)}`
  const line = await api('POST', '/api/workshop/dcw/lines', { name: `Gemma4-复现模拟线-${tag}`, description: `AW-PIPELINE ${tag} 隔离 mock 线(非物理 HIL)`, simulated: true }, token)
  const lineId = line.data?.line?.id
  step('L1', '创建隔离模拟产线', Boolean(lineId), `line=${lineId}`)
  const product = await api('POST', '/api/workshop/dcw/products', { name: `Gemma4-复现产品-${tag}`, lineId }, token)
  const productId = product.data?.product?.id
  const dcwTpl = await api('POST', '/api/workshop/dcw/templates', { name: `冷却温度SP模板-${tag}`, unit: '°C', min: 60, max: 200, decimals: 1 }, token)
  const sp = await api('POST', '/api/workshop/dcw', {
    lineId, name: '冷却温度设定SP', templateRef: dcwTpl.data?.template?.key, driver: 'mock', driverConfig: { key: `sp-${tag}` },
    unit: '°C', min: 60, max: 200, decimals: 1, stepLimit: 6, holdIntervalMs: 120_000,
  }, token)
  const spId = sp.data?.node?.id
  const daqTpl = await api('POST', '/api/workshop/daq/templates', { name: `主轴温度模板-${tag}`, unit: '°C', min: 20, max: 200, base: 140, amp: 8 }, token)
  const daq = await api('POST', '/api/workshop/daq', {
    lineId, name: '主轴实测温度PV', templateRef: daqTpl.data?.template?.key, driver: 'mock', driverConfig: { base: 140, amp: 8, min: 20, max: 200 },
    unit: '°C', min: 20, max: 200, intervalMs: 2000,
  }, token)
  const daqId = daq.data?.node?.id
  const recipe = await api('POST', '/api/workshop/dcw/recipes', { name: `Gemma4-基线配方-${tag}`, productId, params: [{ nodeId: spId, value: 150 }] }, token)
  const recipeId = recipe.data?.recipe?.id
  step('L2', '模板/节点/配方供给', Boolean(spId && daqId && recipeId), `sp=${spId} daq=${daqId} recipe=${recipeId}`)
  if (!spId || !daqId || !recipeId) throw new Error('accept abort: 产线供给不完整')
  const lineStart = await api('POST', `/api/workshop/dcw/lines/${lineId}/start`, { recipeId }, token)
  const lineStartAt = Date.now()
  save('line-start.json', lineStart.data ?? lineStart)
  step('L3', '产线开跑(首批 150)', lineStart.code === 0, `run=${lineStart.data?.run?.id}`)
  await sleep(8000)

  const lineCh = await api('POST', '/api/workshop/channels', {
    name: `Gemma4-产线作业频道-${tag}`, lineId,
    scenarioPrompt: '你是产线作业成员,只使用绑定的配方与数采能力;任何写入都必须经 HITL。',
    leadAgent: { name: 'Gemma Line Lead', harness: 'omp', config: AGENT_CFG },
  }, token)
  const lineChannelId = lineCh.data?.channelId ?? lineCh.data?.id
  const lineAgents = (await api('GET', `/api/workshop/channels/${lineChannelId}/agents`, undefined, token)).data ?? []
  const lineLead = lineAgents.find(a => a.role === 'lead')
  save('line-agents.json', lineAgents)
  const binds = []
  for (const [agentId, nodeId, kind] of [[lineLead.id, lineId, 'line-recipe'], [lineLead.id, recipeId, 'recipe'], [lineLead.id, daqId, 'daq']]) {
    binds.push(await api('POST', '/api/workshop/agent-tools/bindings', { agentId, nodeId, kind }, token))
  }
  step('L4', '绑线频道+绑定面(line-recipe/recipe/daq)', Boolean(lineChannelId) && binds.every(b => b.code === 0), `channel=${lineChannelId} binds=${binds.map(b => b.code).join(',')}`)
  if (!lineChannelId || !lineLead?.id) throw new Error('accept abort: 绑线频道/lead 缺失')

  const q1 = await invokeTool(lineLead.id, 'daq_query', { node_id: daqId, from_ms: Date.now() - 10 * 60_000, to_ms: Date.now() }, token)
  save('line-daq-query.json', { text: q1.text.slice(0, 2000), isError: q1.isError })
  step('L5', 'Agent DAQ 查询(实采样本)', !q1.isError && /\d/.test(q1.text), q1.text.slice(0, 250))

  // recipe_propose → HITL → 派发 → 回读(invoke 阻塞至裁决,异步发起+并行轮询审批卡)
  const proposeP = invokeTool(lineLead.id, 'recipe_propose', {
    recipe_id: recipeId,
    packages: [{
      name: '递减 6°C 至 144',
      rationale: '基线 150°C,向下取告警带上沿 144;单步 ≤6 合规',
      params: [{ node_id: spId, from: 150, to: 144, unit: '°C', basis: 'PV 告警带上沿 144°C', exp_ref: `经验:${tag} 基线整定` }],
    }],
  }, token, 10 * 60_000)
  const card = await pollUntil(async () => {
    const p = await api('GET', `/api/workshop/hitl/pending?channelId=${lineChannelId}`, undefined, token)
    return { done: (p.data?.items ?? []).some(i => i.kind === 'dcw-approval'), items: p.data?.items ?? [] }
  }, { timeoutMs: 120_000, everyMs: 3000, label: 'propose-card' })
  const hitlCard = (card.items ?? []).find(i => i.kind === 'dcw-approval')
  save('line-hitl-card.json', hitlCard ?? {})
  step('L6', 'recipe_propose 生成 HITL 审批卡', Boolean(hitlCard), JSON.stringify(hitlCard ?? {}).slice(0, 250))
  // 节奏:开线首批(150)落在写控保持窗(holdIntervalMs=120s)内时,立即批准会让 144 被节流拒绝;
  // 必须等保持窗过期再批准(实验时长按真实人工节奏对齐,≥130s)。
  const holdRemain = HOLD_WINDOW_MS + 10_000 - (Date.now() - lineStartAt)
  if (holdRemain > 0) {
    log(`[pacing] 等待写控保持窗过期 ${Math.round(holdRemain / 1000)}s(holdIntervalMs=${HOLD_WINDOW_MS})`)
    await sleep(holdRemain)
  }
  if (hitlCard) {
    const resp = await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: hitlCard.id, confirmed: true, choice: 0, comment: '验收:方案 0 批准(单步 6°C 合规)' }, token)
    save('line-hitl-decide.json', resp.data ?? resp)
    step('L7', '人工批准(choice=0)', resp.code === 0, `status=${resp.data?.status}`)
  }
  const proposeResult = await proposeP
  const proposeDispatchAt = Date.now()
  save('line-propose-result.json', { text: proposeResult.text.slice(0, 2000), isError: proposeResult.isError })
  step('L8', '整批下发回执(设备证实)', !proposeResult.isError && /已获批准并整批下发|设备证实/.test(proposeResult.text), proposeResult.text.slice(0, 250))

  const readback = await pollUntil(async () => {
    const agg = await api('GET', '/api/workshop/dcw', undefined, token)
    const node = (agg.data?.nodes ?? []).find(n => n.id === spId)
    return { done: node?.value === 144 || node?.readValue === 144, node }
  }, { timeoutMs: 120_000, everyMs: 3000, label: 'readback' })
  save('line-readback.json', readback.node ?? {})
  step('L9', '设备回读一致(SP=144)', readback.done, `value=${readback.node?.value} readValue=${readback.node?.readValue}`)
  const journal = await api('GET', `/api/workshop/dcw/journal?lineId=${lineId}&limit=50`, undefined, token)
  save('line-journal.json', journal.data ?? {})
  const anchors = journal.data?.anchors ?? []
  step('L10', 'journal 留痕(带审批锚)', anchors.some(a => a.source === 'agent' && a.approvalId), JSON.stringify(anchors[0] ?? {}).slice(0, 220))

  // 负例一:越量程提案(预检拒绝,不建卡)。
  // 节奏:距上次已批准下发 <60s 会先撞「配方下发间隔卡控」,到不了量程预检;
  // 等 65s 让频控过期,负例才能命中预期的「量程预检拒绝」。
  const opRemain = 65_000 - (Date.now() - proposeDispatchAt)
  if (opRemain > 0) {
    log(`[pacing] 等待配方下发间隔过期 ${Math.round(opRemain / 1000)}s(≥60s)`)
    await sleep(opRemain)
  }
  const oor = await invokeTool(lineLead.id, 'recipe_propose', {
    recipe_id: recipeId,
    packages: [{ name: '越量程包', rationale: '负例:999 超出量程', params: [{ node_id: spId, from: 144, to: 999, unit: '°C', basis: '负例', exp_ref: '负例' }] }],
  }, token)
  save('line-negative-range.json', { text: oor.text.slice(0, 1200), isError: oor.isError })
  step('L11', '越量程提案被预检拒绝(负例)', oor.isError && /量程|预检|剔除|越界/.test(oor.text), oor.text.slice(0, 220))

  // 负例二:超单步试验(批准后由派发门拒绝;试验节拍 ≥300s,需距上次配方试验足够久)
  const cadenceRemain = TRIAL_CADENCE_MS + 20_000 - (Date.now() - proposeDispatchAt)
  if (cadenceRemain > 0) {
    log(`[pacing] 等待试验节拍过期 ${Math.round(cadenceRemain / 1000)}s(cadence≥${TRIAL_CADENCE_MS / 1000}s)`)
    await sleep(cadenceRemain)
  }
  const trialP = invokeTool(lineLead.id, 'recipe_trial', {
    recipe_id: recipeId, params: [{ node_id: spId, value: 190 }],
    hypothesis: '负例:验证单步上限在派发门的拦截', reason: '负例',
  }, token, 8 * 60_000)
  const trialCard = await pollUntil(async () => {
    const p = await api('GET', `/api/workshop/hitl/pending?channelId=${lineChannelId}`, undefined, token)
    return { done: (p.data?.items ?? []).some(i => i.kind === 'dcw-approval' && String(i.detail ?? '').includes('190')), items: p.data?.items ?? [] }
  }, { timeoutMs: 120_000, everyMs: 3000, label: 'trial-card' })
  const trialHitl = (trialCard.items ?? []).find(i => String(i.detail ?? '').includes('190'))
  save('line-overstep-card.json', trialHitl ?? {})
  step('L12', '超单步试验审批卡生成', Boolean(trialHitl), JSON.stringify(trialHitl ?? {}).slice(0, 220))
  if (trialHitl) {
    const resp = await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: trialHitl.id, confirmed: true, comment: '负例:批准以验证派发门拦截' }, token)
    save('line-overstep-decide.json', resp.data ?? resp)
  }
  const trialResult = await trialP
  save('line-overstep-result.json', { text: trialResult.text.slice(0, 1500), isError: trialResult.isError })
  const agg2 = await api('GET', '/api/workshop/dcw', undefined, token)
  const spNode = (agg2.data?.nodes ?? []).find(n => n.id === spId)
  save('line-node-final.json', spNode ?? {})
  step('L13', '派发门拒绝超单步(设备无写入)', /超过单步限制|单步限制/.test(trialResult.text) && spNode?.value !== 190, trialResult.text.slice(0, 250))

  const lineStop = await api('POST', `/api/workshop/dcw/lines/${lineId}/stop`, {}, token)
  step('L14', '停线收窗', lineStop.code === 0, `code=${lineStop.code}`)
  const daqWin = await invokeTool(lineLead.id, 'daq_query', { node_id: daqId, from_ms: Date.now() - 60 * 60_000, to_ms: Date.now() }, token)
  save('line-daq-window.json', { text: daqWin.text.slice(0, 2500), isError: daqWin.isError })

  // ===== RSI(绑线频道 candidate 生命周期) =====
  const sample = async (title, text) => {
    const s = await api('POST', `/api/workshop/channels/${lineChannelId}/tasks`, {
      title, description: `${title}:记录一条受治理的产线作业经验。`, assigneeId: lineLead.id,
      mode: 'goal', modeConfig: { completionPolicy: 'no-deliverable' }, fromLabel: '验收员',
    }, token)
    const tid = s.data?.id
    await waitLease(lineChannelId, tid, token)
    const done = await completeTaskRest(lineChannelId, lineLead.id, tid, text, token)
    save(`rsi-task-${tid.slice(0, 8)}.json`, { tid, ...done })
    return { tid, ...done }
  }
  const s1 = await sample('产线经验样本A:温度整定', '经验A:冷却温度 SP 从 150°C 分步下调至 144°C,PV 稳定在 138–142°C 窗口。')
  const s2 = await sample('产线经验样本B:温度整定复现', '经验B:两步调整(150→147→144)可在 5 分钟内进入窗口,单步 ≤3°C 更稳。')
  const refl = await pollUntil(() => {
    const rows = acceptDb.prepare('SELECT id, status, scope_kind AS scopeKind, title, task_id AS taskId FROM agent_memories WHERE channel_id = ? AND kind = \'experience\' AND task_id IN (?, ?)').all(lineChannelId, s1.tid, s2.tid)
    return { done: rows.length >= 2, rows }
  }, { timeoutMs: 60_000, everyMs: 3000, label: 'reflect' })
  save('rsi-reflected.json', refl.rows ?? [])
  const candidates = (refl.rows ?? []).filter(r => r.status === 'candidate').map(r => r.id)
  step('R1', '任务完成反射 candidate 经验(≥2)', candidates.length >= 2, JSON.stringify((refl.rows ?? []).map(r => ({ s: r.status, t: String(r.taskId).slice(0, 8) }))))
  if (candidates.length >= 2) {
    const neg = await api('POST', `/api/workshop/channels/${lineChannelId}/memories/${candidates[0]}/promote`, { to: 'validated' }, token)
    save('rsi-promote-negative.json', neg.data ?? neg)
    step('R2', '单任务 candidate 晋级被拒(1/2)', neg.data?.ok === false && JSON.stringify(neg.data?.reasons ?? []).includes('独立任务样本不足'), JSON.stringify(neg.data?.reasons ?? []))
    const merge = await api('POST', `/api/workshop/channels/${lineChannelId}/memories/merge`, { memoryIds: candidates }, token)
    save('rsi-merge.json', merge.data ?? merge)
    step('R3', '合并 candidate(taskIds=2)', merge.data?.ok === true && (merge.data?.taskIds?.length ?? 0) >= 2, JSON.stringify(merge.data ?? {}).slice(0, 180))
    const mergedId = merge.data?.memoryId
    const promo = mergedId ? await api('POST', `/api/workshop/channels/${lineChannelId}/memories/${mergedId}/promote`, { to: 'validated' }, token) : { data: {} }
    save('rsi-promote-ok.json', promo.data ?? promo)
    step('R4', '人工晋升 candidate→validated', promo.data?.ok === true, JSON.stringify(promo.data ?? {}).slice(0, 180))
  }
  const lineToken = await api('POST', `/api/workshop/channels/${lineChannelId}/agents/${lineLead.id}/rotate-token`, {}, token)
  const unauthRes = await fetch(`${BASE}/api/workshop/channels/${lineChannelId}/memories/${candidates[0] ?? 'x'}/promote`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${lineToken.data?.token}` },
    body: JSON.stringify({ to: 'validated' }), signal: AbortSignal.timeout(30_000),
  })
  const unauth = await unauthRes.json().catch(() => ({}))
  save('rsi-unauthorized.json', { httpStatus: unauthRes.status, code: unauth.code })
  step('R5', 'Agent token 越权晋升被拒(401)', unauthRes.status === 401 || unauth.code === 'USER_UNAUTHORIZED', `http=${unauthRes.status} code=${unauth.code}`)

  // ===== 模型取证 + 收口 =====
  const provenance = ompModelProvenance(t0)
  save('omp-provenance.json', provenance)
  const allLocal = provenance.length > 0 && provenance.every(p => p.models.every(m => m === `${MODEL_PROVIDER}/${MODEL_ID}`))
  step('X1', '全部真实回合模型来源=local/gemma', allLocal, JSON.stringify(provenance.map(p => ({ f: p.file.slice(0, 36), m: p.models }))).slice(0, 450))

  const pass = results.filter(r => r.pass).length
  log(`SUMMARY pass=${pass} fail=${results.length - pass} total=${results.length}`)
  return { pass, fail: results.length - pass, total: results.length }
}

// ---------- Phase: report ----------
function phaseReport(acceptStat) {
  const summary = {
    generatedAt: new Date().toISOString(),
    pipeline: 'gemma4-pipeline',
    model: MODEL_ID,
    provider: MODEL_PROVIDER,
    port: PORT,
    home: HOME,
    evidence: EVIDENCE,
    steps: results,
    ...(acceptStat ?? {}),
  }
  save('summary.json', summary)
  log(`Phase report: summary.json written(pass=${results.filter(r => r.pass).length}/${results.length})`)
}

// ---------- 主流程 ----------
async function main() {
  let stat = null
  try {
    if (PHASE === 'env' || PHASE === 'all') await phaseEnv()
    if (PHASE === 'cleanup' || PHASE === 'all') await phaseCleanup()
    if (PHASE === 'start' || PHASE === 'all') await phaseStart()
    if (PHASE === 'accept' || PHASE === 'all') stat = await phaseAccept()
    if (PHASE === 'report' || PHASE === 'all') phaseReport(stat)
    log('PIPELINE DONE')
  }
  catch (e) {
    // 失败路径也要落 summary(部分 results 是宝贵的失败证据),并如实标注 aborted
    results.push({ id: 'ABORT', name: 'PIPELINE 中止', pass: false, detail: e instanceof Error ? e.message : String(e) })
    phaseReport({ aborted: true })
    log(`PIPELINE FAILED: ${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = 1
  }
  finally {
    try {
      acceptDb?.close()
    }
    catch { /* 已关闭 */ }
  }
}
await main()
