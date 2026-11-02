/**
 * P5 双通道互审 + 审批卡科学载荷单测(科学探索计划):
 *  - A5-1 冲突矩阵:模型有效应 & 本体明确无路径 → 自动拒/人工须理由;
 *         模型无效应 & 本体有路径 → 冲突;unknown(无模型/未声明)不拦(缺证据不是反证);
 *         UQ 拒收 → 自动拒;欠功效 → 仅告警
 *  - A5-2 事故场景回放:吹压 SP 提案在 auto 模式被拒,理由同时含"本体无耦合路径"与"模型有效应"
 *  - A5-3 科学载荷字段齐全(效应/CI/MDE/覆盖/证据边/可证伪方式),审批卡人读行同源
 *  - A5-4 审批载荷经 requestManualApproval → approvals.request(payload) 透传
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-p5-'))

const { evaluateCrossCheck, scientificPayloadLines } = await import('../server/services/workshop/aml/twin/cross-check')

// 一阶 ARX:y(k)=0.5y(k-1)+0.3u(k-1) → 增益 0.6;对照组增益 0
const withEffect = {
  A: [[0.5, 0.3], [0, 0]],
  B: [[0], [1]],
  C: [[1, 0]],
  D: [[0]],
  mvOrder: ['dw-sp'],
  cvOrder: ['daq-thickness'],
}
const noEffect = { ...withEffect, A: [[0.5, 0], [0, 0]] }

describe('A5-1 冲突矩阵(三值逻辑)', () => {
  it('模型有效应 & 本体明确无路径 → 自动拒,冲突理由双语可读', () => {
    const r = evaluateCrossCheck({
      controlNodeId: 'dw-sp', targetNodeId: 'daq-thickness', proposedDelta: -0.2, auto: true,
      model: { artifact: withEffect, targetNodeId: 'daq-thickness' },
      ontology: { hasCouplingPath: false, evidence: ['本体 v3:无 actuator→target 边'] },
    })
    assert.equal(r.decision, 'reject')
    assert.match(r.conflicts[0] ?? '', /模型预测有效应/)
    assert.match(r.conflicts[0] ?? '', /无耦合路径/)
  })

  it('模型无效应 & 本体断言有路径 → 自动拒(提示先查 G6)', () => {
    const r = evaluateCrossCheck({
      controlNodeId: 'dw-sp', targetNodeId: 'daq-thickness', proposedDelta: -0.2, auto: true,
      model: { artifact: noEffect, targetNodeId: 'daq-thickness' },
      ontology: { hasCouplingPath: true, evidence: ['relation influences(sign=+)'] },
    })
    assert.equal(r.decision, 'reject')
    assert.match(r.conflicts[0] ?? '', /G6/)
  })

  it('unknown 不拦:无模型 + 本体未声明 → allow', () => {
    const r = evaluateCrossCheck({
      controlNodeId: 'dw-sp', targetNodeId: 'daq-thickness', proposedDelta: -0.2, auto: true,
      model: { artifact: null, targetNodeId: 'daq-thickness' },
      ontology: { hasCouplingPath: null, evidence: [] },
    })
    assert.equal(r.decision, 'allow')
    assert.equal(r.conflicts.length, 0)
    assert.equal(r.payload.modelEffect, null)
    assert.equal(r.payload.ontologyHasCouplingPath, null)
  })

  it('未收敛模型不参与冲突(unknown 语义)', () => {
    const r = evaluateCrossCheck({
      controlNodeId: 'dw-sp', targetNodeId: 'daq-thickness', proposedDelta: -0.2, auto: true,
      model: { artifact: { ...withEffect, A: [[1, 0.3], [0, 0]] }, targetNodeId: 'daq-thickness' },
      ontology: { hasCouplingPath: false, evidence: [] },
    })
    assert.equal(r.decision, 'allow')
    assert.equal(r.payload.modelConverged, false)
  })

  it('UQ 拒收 → 自动模式拒;人工模式需人审', () => {
    const auto = evaluateCrossCheck({
      controlNodeId: 'dw-sp', targetNodeId: 'daq-thickness', proposedDelta: -0.2, auto: true,
      model: { artifact: withEffect, targetNodeId: 'daq-thickness', uq: { accepted: false, rejectCode: 'OOD_DISTANCE_HIGH' } },
      ontology: { hasCouplingPath: true, evidence: [] },
    })
    assert.equal(auto.decision, 'reject')
    const manual = evaluateCrossCheck({
      controlNodeId: 'dw-sp', targetNodeId: 'daq-thickness', proposedDelta: -0.2, auto: false,
      model: { artifact: withEffect, targetNodeId: 'daq-thickness', uq: { accepted: false, rejectCode: 'OOD_DISTANCE_HIGH' } },
      ontology: { hasCouplingPath: true, evidence: [] },
    })
    assert.equal(manual.decision, 'allow_with_warning')
  })

  it('欠功效/混杂 → 仅告警,不阻断(卡片写明"不构成可分辨干预")', () => {
    const r = evaluateCrossCheck({
      controlNodeId: 'dw-sp', targetNodeId: 'daq-thickness', proposedDelta: -0.2, auto: false,
      ontology: { hasCouplingPath: true, evidence: [] },
      identifiability: { verdict: 'UNDERPOWERED', mde: 0.003 },
    })
    assert.equal(r.decision, 'allow_with_warning')
    assert.ok(r.warnings.some(w => /可辨识性 UNDERPOWERED/.test(w)))
    assert.match(scientificPayloadLines(r.payload).join('\n'), /未评估|UNDERPOWERED/)
  })
})

describe('A5-2 事故场景回放(吹压 SP 2.6→2.4)', () => {
  it('auto 模式:冲突被拒且理由含本体无路径 + 模型有效应 + 可证伪方式', () => {
    const r = evaluateCrossCheck({
      controlNodeId: 'dw-sp', targetNodeId: 'daq-thickness', proposedDelta: -0.2, auto: true,
      model: { artifact: withEffect, targetNodeId: 'daq-thickness' },
      ontology: { hasCouplingPath: false, evidence: ['本体 v3 无该耦合边(KB 断言不可追溯)'] },
      identifiability: { verdict: 'UNDERPOWERED', effect: 0.001, ciLow: -0.002, ciHigh: 0.004, mde: 0.003 },
    })
    assert.equal(r.decision, 'reject')
    assert.equal(r.payload.mde, 0.003)
    const text = scientificPayloadLines(r.payload).join('\n')
    assert.match(text, /明确无耦合路径/)
    assert.match(text, /MDE/)
    assert.match(text, /可证伪/)
  })
})

describe('A5-3 科学载荷与审批卡人读行', () => {
  it('载荷字段齐全且与 detail 行同源', () => {
    const r = evaluateCrossCheck({
      controlNodeId: 'dw-sp', targetNodeId: 'daq-thickness', proposedDelta: -0.2, auto: false,
      model: { artifact: withEffect, targetNodeId: 'daq-thickness' },
      ontology: { hasCouplingPath: true, evidence: ['relation#1 influences'] },
      identifiability: { verdict: 'IDENTIFIABLE', effect: 0.03, ciLow: 0.02, ciHigh: 0.04, mde: 0.003 },
      actionCoverage: {
        controlId: 'dw-sp', distinctLevels: 3, stepCount: 4, collinearityWithTime: 0.1, saturationRatio: 0.4,
        levelPhaseMatrix: [], levelBlocks: [1, 2, 1], monolithicSequence: false, samples: 400,
      },
    })
    const p = r.payload
    assert.ok(Math.abs((p.modelEffect ?? 0) - 0.6 * -0.2) < 1e-9)
    assert.equal(p.identifiabilityVerdict, 'IDENTIFIABLE')
    assert.equal(p.mde, 0.003)
    assert.equal(p.actionCoverage?.distinctLevels, 3)
    assert.deepEqual(p.evidenceEdges, ['relation#1 influences'])
    assert.ok(p.falsificationMethod.length > 20)
    const text = scientificPayloadLines(p).join('\n')
    assert.match(text, /模型预测/)
    assert.match(text, /本体耦合:存在路径/)
    assert.match(text, /动作覆盖:水平 3/)
  })
})

describe('A5-5 下发前强制互审(服务态)', () => {
  it('模型有效应 + 本体明确无路径 → auto 拒绝;无模型/无本体 → 不拦', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const { openWorkshopDb } = await import('../server/services/workshop/db/database/open')
    const { configureAmlRuntime, getAmlRuntime } = await import('../server/services/workshop/aml/runtime')
    const { setHybridChannelProfile } = await import('../server/services/workshop/aml/twin/channel-profile')
    const { preDispatchCrossCheck } = await import('../server/services/workshop/aml/twin/cross-check-service')
    const { getOntologyRepo } = await import('../server/services/workshop/ontology/repo')

    const home = mkdtempSync(join(tmpdir(), 'aw-p5b-'))
    const db = openWorkshopDb(join(home, 'p5b.sqlite'))
    configureAmlRuntime(db)
    const now = new Date().toISOString()
    // 已发布本体(无 coupling 边 = 明确无路径)
    db.prepare(`INSERT INTO ontology_versions (id, version, name, line_id, parent_version, content_hash, compiled_json, changelog_json, status, owner_user_id, published_by, created_at, updated_at)
      VALUES ('ont-p5b', 1, 'p5b', 'ln-p5b', NULL, '', '{}', '{}', 'published', 'u1', 'u1', ?, ?)`).run(now, now)
    // ARX 工件:y=0.5y+0.3u → 增益 0.6(有效应)
    const dir = join(home, 'model')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'model.json'), JSON.stringify({
      kind: 'linear_state_space@1', stateDim: 2,
      A: [[0.5, 0.3], [0, 0]], B: [[0], [1]], C: [[1, 0]], D: [[0]],
      mvOrder: ['dw-p5b-sp'], cvOrder: ['daq-p5b-th'],
    }))
    // 模型行有 dataset→job→experiment 外键链:按真实谱系插最小行(不绕过约束)
    const rt = getAmlRuntime()
    rt.repo.dataset.insert({
      id: 'ds-p5b', lineId: 'ln-p5b', productId: 'pd', recipeId: 'rc', runIds: [], specJson: '{}', sha256: 'x',
      rowCount: 100, fromMs: 0, toMs: 1, path: join(home, 'ds'), createdBy: 't', createdByKind: 'user', note: '', createdAt: now,
    })
    rt.repo.job.insert({ id: 'job-p5b', datasetId: 'ds-p5b', purpose: 'mpc_surrogate', budget: {}, createdAt: now })
    rt.repo.experiment.insert({ id: 'exp-p5b', jobId: 'job-p5b', datasetId: 'ds-p5b', changeNote: '', configJson: '{}', createdAt: now })
    rt.repo.model.insert({
      id: 'mdl-p5b', experimentId: 'exp-p5b', datasetId: 'ds-p5b', productId: 'pd', recipeId: 'rc',
      purpose: 'mpc_surrogate',
      ioSpecJson: JSON.stringify({ mvOrder: ['dw-p5b-sp'], cvOrder: ['daq-p5b-th'], norm: { u: { mean: [0], std: [1] }, y: { mean: [0], std: [1] } } }),
      metricsJson: '{}', path: dir, createdBy: 't', note: '', lineId: 'ln-p5b', artifactKind: 'linear_state_space@1', createdAt: now,
    })
    // 频道 profile 对 channels(id) 有外键:先插频道行
    db.prepare(`INSERT INTO channels (id, name, description, enabled, created_at, updated_at) VALUES ('ch-p5b', 'p5b', '', 1, ?, ?)`).run(now, now)
    setHybridChannelProfile({ channelId: 'ch-p5b', profile: 'aml_optimization', capability: {}, controlPolicy: 'bounded_auto', boundModelId: 'mdl-p5b' })

    const blocked = preDispatchCrossCheck({ lineId: 'ln-p5b', controlNodeId: 'dw-p5b-sp', targetNodeId: 'daq-p5b-th', proposedDelta: -0.2, channelId: 'ch-p5b', auto: true })
    assert.equal(blocked.blocked, true, blocked.text)
    assert.match(blocked.text, /模型预测有效应/)
    assert.match(blocked.text, /无耦合路径/)
    assert.match(blocked.text, /可证伪/)
    assert.equal(getOntologyRepo().listEvidence('ont-p5b', { limit: 5 }).length, 0, '互审不写证据')

    // 无模型无本体 → unknown 不拦(缺证据不是反证)
    const pass = preDispatchCrossCheck({ lineId: 'ln-unknown', controlNodeId: 'a', targetNodeId: 'b', proposedDelta: -0.2, channelId: 'ch-none', auto: true })
    assert.equal(pass.blocked, false, pass.text)
    assert.match(pass.text, /unknown/)
  })
})

describe('A5-4 审批载荷透传', () => {
  it('requestManualApproval 把 payload 传进 approvals.request', async () => {
    const { openWorkshopDb } = await import('../server/services/workshop/db/database/open')
    const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
    const { bindOpsRepos } = await import('../server/services/workshop/ops/ops')
    const { createAlarmEventRepo, createApprovalHistoryRepo, createApprovalRequestRepo, createAuditRepo } = await import('../server/services/workshop/db/ops.repo')
    const db = openWorkshopDb(join(process.env.AW_HOME!, 'p5.sqlite'))
    configureAmlRuntime(db)
    bindOpsRepos({
      approvalHistory: createApprovalHistoryRepo(db),
      alarmEvents: createAlarmEventRepo(db),
      audit: createAuditRepo(db),
      approvalRequests: createApprovalRequestRepo(db),
    })
    const { getToolApprovals } = await import('../server/services/workshop/agents/tool-approvals')
    const { requestManualApproval } = await import('../server/services/workshop/agents/industrial/manual-approval')
    const approvals = getToolApprovals()
    let captured: unknown
    const original = approvals.request.bind(approvals)
    // 在 request 前截获 payload,立即走原实现(10ms 超时按拒绝收敛)
    approvals.request = (async (agentId: string, nodeId: string, kind: 'dcw' | 'daq' | 'kb', detail: string, opts?: { timeoutMs?: number, payload?: unknown }) => {
      captured = opts?.payload
      return original(agentId, nodeId, kind, detail, { ...opts, timeoutMs: 10 })
    }) as typeof approvals.request
    const payload = { effectEstimate: 0.03, ciLow: 0.02, ciHigh: 0.04, mde: 0.003, evidenceEdges: ['e1'], falsificationMethod: '若 CI 含 0 则否证' }
    await requestManualApproval({ agentId: 'ag-p5', nodeId: 'dw-p5', detail: '测试载荷', payload })
    assert.deepEqual(captured, payload)
  })
})
