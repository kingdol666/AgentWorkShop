/**
 * MQTT 结构化解码 + 用户 sink 扩展点单测(2026-10-27 结构化解析轮)。
 *
 * 目标:证明 broker 传来的结构化 JSON 可在节点配置层解析为
 *   scalar(单个数字)/ vector(数组)/ image(base64 或二进制)，
 * 并可经模板 sink 处理器(含用户注册的处理器)加工后交给采集管线；
 * 自定义解码器注册表(ctx.daq.registerDecoder 同源)是留给用户的统一接口。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-mqtt-decode-test-'))
delete process.env.AW_BENCH_MODE

const { decodeMqttPayload, describeMqttPayload } = await import('../server/services/workshop/daq/drivers/mqtt-decode')
const { registerDecoder, clearDecoders, listDecoders, resolveDecoder } = await import('../server/services/workshop/daq/decoders')
const { registerFrameProcessor, runSinkPipeline } = await import('../server/services/workshop/daq/frames')
const { encodePng } = await import('../server/services/workshop/daq/png-enc')

const png2x2 = encodePng(2, 2, new Uint8Array([0, 64, 128, 255]))
const pngB64 = png2x2.toString('base64')

function decode(raw: string, signalKind: 'scalar' | 'vector' | 'image', config: Record<string, unknown> = {}, bytes = Buffer.from(raw)) {
  return decodeMqttPayload({ raw, bytes, json: null, config, signalKind, nodeId: 'dn-test' })
}

test('scalar:JSON jsonPath / 纯数字 / JSON 数字字符串 / 非法路径', () => {
  const a = decode('{"data":{"temp":42.5}}', 'scalar', { jsonPath: 'data.temp' })
  assert.deepEqual(a, { kind: 'scalar', value: 42.5 })
  const b = decode(' 41.2 ', 'scalar')
  assert.deepEqual(b, { kind: 'scalar', value: 41.2 })
  const c = decode('{"data":{"temp":"38.6"}}', 'scalar', { jsonPath: 'data.temp' })
  assert.deepEqual(c, { kind: 'scalar', value: 38.6 })
  const d = decode('"42.5"', 'scalar')
  assert.deepEqual(d, { kind: 'scalar', value: 42.5 })
  assert.throws(() => decode('{"data":{}}', 'scalar', { jsonPath: 'data.temp' }), /无法得到单个数值/)
  assert.throws(() => decode('not-json', 'scalar', { jsonPath: 'a.b' }), /不是合法 JSON/)
  // null/boolean/空串不得静默变成 0/1
  assert.throws(() => decode('{"data":{"temp":null}}', 'scalar', { jsonPath: 'data.temp' }), /无法得到单个数值/)
  assert.throws(() => decode('{"data":{"temp":true}}', 'scalar', { jsonPath: 'data.temp' }), /无法得到单个数值/)
  assert.throws(() => decode('{"data":{"temp":""}}', 'scalar', { jsonPath: 'data.temp' }), /无法得到单个数值/)
})

test('vector:pointsPath / 根数组 / metricsPath / 非法点列(含 null)', () => {
  const a = decode('{"data":{"points":[1,2,3.5],"metrics":{"avg":2.2,"max":3.5}}}', 'vector', { pointsPath: 'data.points', metricsPath: 'data.metrics' })
  assert.equal(a.kind, 'vector')
  assert.deepEqual(a.kind === 'vector' ? a.points : [], [1, 2, 3.5])
  assert.deepEqual(a.kind === 'vector' ? a.metrics : {}, { avg: 2.2, max: 3.5 })
  const b = decode('[4,5,6]', 'vector')
  assert.deepEqual(b.kind === 'vector' ? b.points : [], [4, 5, 6])
  assert.throws(() => decode('{"points":["x",1]}', 'vector'), /非数值/)
  assert.throws(() => decode('{"points":[1,null,3]}', 'vector'), /非数值/)
  assert.throws(() => decode('{"points":[]}', 'vector'), /长度 0 非法/)
  assert.throws(() => decode('{}', 'vector'), /缺少点列数组/)
  assert.throws(() => decode(JSON.stringify({ points: Array.from({ length: 4097 }, () => 1) }), 'vector'), /长度 4097 非法/)
  const nullMetric = decode('{"points":[1,2],"metrics":{"avg":null}}', 'vector', { metricsPath: 'metrics' })
  assert.equal(nullMetric.kind === 'vector' ? nullMetric.metrics : 'x', undefined, 'null 指标必须被丢弃')
})

test('image:JSON base64(自动 PNG IHDR)/ data URL / binary / MIME 与上限', () => {
  const a = decode(JSON.stringify({ data: { png: pngB64 } }), 'image', { imagePath: 'data.png' })
  assert.equal(a.kind, 'image')
  if (a.kind === 'image') {
    assert.equal(a.mime, 'image/png')
    assert.equal(a.width, 2)
    assert.equal(a.height, 2)
    assert.equal(a.blob.length, png2x2.length)
  }
  const b = decode(JSON.stringify({ img: `data:image/jpeg;base64,${pngB64}` }), 'image', { imagePath: 'img' })
  assert.equal(b.kind === 'image' ? b.mime : '', 'image/jpeg', 'data URL MIME 优先于缺省 image/png')
  const mp = decode(JSON.stringify({ png: pngB64, m: { type: 'image/webp' } }), 'image', { imagePath: 'png', mimePath: 'm.type', imageMime: 'image/png' })
  assert.equal(mp.kind === 'image' ? mp.mime : '', 'image/webp', 'mimePath 优先于静态 imageMime')
  const c = decode('', 'image', { imageFormat: 'binary', imageMime: 'image/png' }, png2x2)
  assert.equal(c.kind, 'image')
  assert.equal(c.kind === 'image' ? c.width : 0, 2)
  assert.throws(() => decode(JSON.stringify({ png: '%%%' }), 'image', { imagePath: 'png' }), /不是合法 base64/)
  assert.throws(() => decode(JSON.stringify({ png: 'http://camera/live.png' }), 'image'), /缺少 base64/, '非 base64 的 image 字段不得冒充图像')
  assert.throws(() => decode(JSON.stringify({}), 'image'), /缺少 base64/)
  assert.throws(() => decode(JSON.stringify({ png: pngB64 }), 'image', { imageMime: 'image/svg+xml' }), /MIME 不受支持/)
  assert.throws(() => decode(JSON.stringify({ png: pngB64 }), 'image', { imageMaxBytes: 10 }), /超过上限/)
  // 不可信 IHDR 超大尺寸 → 拒绝(不分配像素)
  const ihdr = Buffer.alloc(33)
  ihdr[0] = 0x89; ihdr[1] = 0x50; ihdr[2] = 0x4E; ihdr[3] = 0x47
  ihdr.writeUInt32BE(13, 8)
  ihdr.write('IHDR', 12, 'ascii')
  ihdr.writeUInt32BE(100000, 16)
  ihdr.writeUInt32BE(100000, 20)
  assert.throws(() => decode(JSON.stringify({ png: ihdr.toString('base64') }), 'image'), /超过上限/)
})

test('形态校验:类型与模板 signalKind 不一致必须报错', () => {
  assert.throws(() => decode('{"points":[1,2]}', 'scalar', { jsonPath: 'points' }), /vectors?|单个数值|数组|对象/)
  // 自定义解码器返回 vector 但模板是 scalar → 明确拒绝
  registerDecoder('wrong-kind', () => ({ kind: 'vector', points: [1, 2] }))
  try {
    assert.throws(() => decode('{}', 'scalar', { decoder: 'wrong-kind' }), /不一致/)
  }
  finally {
    clearDecoders()
  }
})

test('自定义解码器:用户 sink 解析结构化报文(注册表统一接口)', () => {
  clearDecoders()
  registerDecoder('sum-xy', (input) => {
    const j = JSON.parse(input.raw) as { x: number, y: number }
    return { kind: 'scalar', value: j.x + j.y }
  })
  registerDecoder('sum-json', (input) => {
    // 文档承诺 input.json 是已解析 JSON
    const j = input.json as { x: number, y: number } | null
    if (!j) throw new Error('缺少 json')
    return { kind: 'scalar', value: j.x + j.y }
  })
  assert.deepEqual(listDecoders(), ['sum-json', 'sum-xy'])
  const out = decode('{"x":40,"y":2.5}', 'scalar', { decoder: 'sum-xy' })
  assert.deepEqual(out, { kind: 'scalar', value: 42.5 })
  assert.deepEqual(decode('{"x":1,"y":2}', 'scalar', { decoder: 'sum-json' }), { kind: 'scalar', value: 3 })
  assert.throws(() => decode('{}', 'scalar', { decoder: 'nope' }), /未知解码器/)
  // 异步解码器必须明确拒绝
  registerDecoder('async-one', (() => Promise.resolve({ kind: 'scalar', value: 1 })) as never)
  assert.throws(() => decode('{}', 'scalar', { decoder: 'async-one' }), /同步纯函数/)
  // 自定义输出同样受类型/上限校验
  registerDecoder('bad-blob', (() => ({ kind: 'image', blob: 'not-buffer', mime: 'image/png' })) as never)
  assert.throws(() => decode('{}', 'image', { decoder: 'bad-blob' }), /非空 Buffer/)
  registerDecoder('bad-metrics', (() => ({ kind: 'vector', points: [1, 2], metrics: { avg: Number.NaN } })) as never)
  assert.throws(() => decode('{}', 'vector', { decoder: 'bad-metrics' }), /metrics/)
  clearDecoders()
})

test('解码器生命周期:按插件 owner 撤销 / 全清', () => {
  clearDecoders()
  registerDecoder('a-dec', () => ({ kind: 'scalar', value: 1 }), 'plugin-a')
  registerDecoder('b-dec', () => ({ kind: 'scalar', value: 2 }), 'plugin-b')
  assert.deepEqual(listDecoders(), ['a-dec', 'b-dec'])
  clearDecoders('plugin-a')
  assert.deepEqual(listDecoders(), ['b-dec'])
  assert.equal(resolveDecoder('a-dec'), undefined)
  clearDecoders()
  assert.deepEqual(listDecoders(), [])
})

test('连接测试自动识别:scalar / vector / image / 根数组', () => {
  assert.equal(describeMqttPayload('{"data":{"points":[1,2,3]}}', Buffer.from(''), { pointsPath: 'data.points' }).kind, 'vector')
  assert.equal(describeMqttPayload('[1,2,3]', Buffer.from(''), {}).kind, 'vector')
  assert.equal(describeMqttPayload(JSON.stringify({ png: pngB64 }), Buffer.from(''), {}).kind, 'image')
  assert.equal(describeMqttPayload('{"data":{"temp":12.5}}', Buffer.from(''), { jsonPath: 'data.temp' }).kind, 'scalar')
})

test('用户 sink:内置处理器 + 注册自定义处理器加工帧', () => {
  const builtin = runSinkPipeline({ kind: 'vector', points: [1, 2, 3, 4] }, [
    { name: 'derive-metric', args: { name: 'avg', op: 'avg' } },
    { name: 'zones', args: { n: 2 } },
  ], 'dn-sink')
  assert.equal(builtin.metrics?.avg, 2.5)
  assert.equal(builtin.metrics?.zone1_avg, 1.5)
  assert.equal(builtin.metrics?.zone2_avg, 3.5)

  registerFrameProcessor({
    name: 'double-points',
    applies: 'vector',
    process: frame => ({ ...frame, points: (frame.points ?? []).map(v => v * 2) }),
  })
  const custom = runSinkPipeline({ kind: 'vector', points: [1, 2, 3] }, [{ name: 'double-points' }], 'dn-sink')
  assert.deepEqual(custom.points, [2, 4, 6])
})
