# DAQ / DCW 驱动契约(实现速查)

> 事实源:`server/services/workshop/daq/drivers/shared.ts`、`server/services/workshop/dcw/drivers/shared.ts`。类型以代码为准;本文只摘实现时最容易错的部分。

## 1. DAQ 读驱动

```ts
export interface DaqDriverInput {
  ctx: { nodeId: string; now: number; ageMs: number }
  config: { base: number; amp: number; min: number; max: number }
  driverConfig: Record<string, unknown>
  signalKind?: 'scalar' | 'vector' | 'image'
  vector?: { points: number; min: number; max: number }
}

export interface DaqDriver {
  readonly kind: string
  available(): Promise<boolean>
  sample(input: DaqDriverInput): Promise<number | DaqFrameSample | null> | number | DaqFrameSample | null
  test(cfg: Record<string, unknown>, signalKind?: 'scalar'|'vector'|'image'): Promise<DriverTestResult>
  subscribe?(input: DaqPushInput): Promise<() => void | Promise<void>>
  fingerprint?(cfg: Record<string, unknown>): string
  meta?: { label: string; status: 'builtin'|'real'|'planned'; configFields: DriverConfigField[] }
}
```

### 返回形态

| 形态 | 返回 | 后续 |
| --- | --- | --- |
| scalar | `number` | `applyTransform` → `daq_samples` → WS `daq.reading` |
| vector | `{ frame: { kind:'vector', points:number[], metrics?:Record<string,number> } }` | sink 管线 → `daq_frames`（点列入 `meta.points`） |
| image | `{ frame: { kind:'image', blob:Buffer, mime, width, height, metrics? } }` | sink 管线 → 对象存储 + `daq_frames.meta` |

限制:vector 1~4096 个有限数(控制器 `slice(0,4096)`)。image 的限制**按入口不同**:MQTT/decoder 路径 ≤10MB、≤1600 万像素、单边 ≤16384、仅 raster MIME(PNG/JPEG/WebP/BMP/GIF/TIFF);外部 ingest 只查 ≤10MB 且 `image/*`(当前允许 SVG,是缺口);HTTP DAQ 不限大小;驱动直接返回的帧绕过这些检查。

### `sample` 的错误语义

- 抛错 = 本次采样失败,节点 `lastError` 记录,状态按故障处理;不要返回 `0` 或上次值掩盖。
- 返回 `null` = 本次无样本(合法,例如设备暂无数据)。
- 慢驱动会自然降频(采样耗时计入周期),不要在驱动内再做长轮询。

### 推送式协议(`subscribe`)

```ts
export interface DaqPushInput extends DaqDriverInput {
  onSample: (s: { value:number, atMs:number } | { frame: DaqFrameSample['frame'], atMs:number }) => void
  onError?: (err: Error) => void
}
```

- 存在 `subscribe` 的驱动由控制器按事件驱动采集,不再进入 `intervalMs` 轮询。
- 返回的 stop 必须幂等;节点停用/删除/网关停止都会调用。
- `fingerprint(cfg)` 变化(凭据/主题/QoS/TLS)时控制器重建订阅;不实现则按常见字段拼保守指纹。
- 解析失败通过 `onError` 上报,不要静默丢弃。

### 示例(最小 HTTP 标量驱动)

```js
ctx.daq.registerDriver({
  kind: 'my-http',
  async available() { return true },
  async sample({ driverConfig }) {
    const res = await fetch(String(driverConfig.url), { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const j = await res.json()
    const v = Number(j?.data?.value)
    if (!Number.isFinite(v)) throw new Error('响应缺少 data.value')
    return v
  },
  async test(cfg) {
    try { return { ok: true, message: '连接成功', sampleValue: await this.sample({ driverConfig: cfg }) } }
    catch (e) { return { ok: false, message: e.message } }
  },
  meta: { label: 'My HTTP', status: 'real', configFields: [{ key: 'url', label: 'URL', type: 'string', required: true }] },
})
```

## 2. DCW 写驱动

```ts
export interface DcwWriteInput {
  eng: number                 // 工程值(已过工艺量程)
  tolerance: number           // 回读容差
  domain: { min: number; max: number }
  driverConfig: Record<string, unknown>
}

export interface DcwWriteResult {
  ok: boolean
  message: string
  raw: number | null
  readback: number | null
  ack?: 'readback-verified' | 'transport-ack' | 'unverified'
}

export interface DcwWriteDriver {
  readonly kind: string
  available(): Promise<boolean>
  write(input: DcwWriteInput): Promise<DcwWriteResult>
  test(cfg: Record<string, unknown>): Promise<{ ok: boolean; message: string }>
  read?(input: DcwReadInput): Promise<DcwReadResult>
  canRead?(cfg: Record<string, unknown>): boolean
  fetchHistory?(input: DcwFetchHistoryInput): Promise<DcwFetchHistoryResult>
}
```

### ack 三档

| ack | 含义 | 何时用 |
| --- | --- | --- |
| `readback-verified` | 独立回读,且 \|回读-设定\| ≤ 容差 | 寄存器/OPC UA 驱动内回读 |
| `transport-ack` | 仅链路受理(MQTT puback / HTTP 2xx),无设备数值确认 | 无回读通道 |
| `unverified` | 发送失败或无任何确认 | 失败/未知 |

网关按 ack 分级;`ok:true` + `ack:'transport-ack'` 不等于设备已证实。批量/配方写由 `write-verify` 的 `readNow` 提升为 `readback-verified`。

### 回读与历史

- `read(input)` 返回 `{ ok, message, eng, raw, dictionary? }`;没有读通道就实现 `canRead(cfg) => false`,网关跳过周期读。
- `fetchHistory` 行格式:`scalar`(`value`)、`vector`(`values`)、`image`(`data`+`mime`)、`table/event`(`record`);分页必须配 `nextCursorPath`。
- 换算用 `engToRaw/rawToEng`;回读判定用 `readbackAck`;整数编码用 `encodeWords`(越界抛错,不按位回绕)。

### 示例(最小写入)

```js
ctx.dcw.registerWriteDriver({
  kind: 'my-writer',
  async available() { return true },
  async write({ eng, driverConfig }) {
    const res = await fetch(String(driverConfig.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ setpoint: eng }),
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}`, raw: null, readback: null, ack: 'unverified' }
    return { ok: true, message: '已受理', raw: null, readback: null, ack: 'transport-ack' }
  },
  async test() { return { ok: true, message: '连接成功' } },
})
```

## 3. 解码器

```ts
type DaqDecoded =
  | { kind: 'scalar', value: number }
  | { kind: 'vector', points: number[], metrics?: Record<string, number> }
  | { kind: 'image', blob: Buffer, mime: string, width?: number, height?: number, metrics?: Record<string, number> }

type DaqDecoder = (input: {
  raw: string; bytes: Buffer; json: unknown
  config: Record<string, unknown>
  signalKind: 'scalar'|'vector'|'image'
  nodeId: string
}) => DaqDecoded
```

- 必须同步纯函数:不发网络请求、不写库、不读时钟。
- 输出形态必须与节点模板 `signalKind` 一致;控制器会校验。
- 解码器优先于声明式 `jsonPath/pointsPath/imagePath`;节点 `driverConfig.decoder = name` 启用。
- 失败抛错,由 MQTT/HTTP 驱动转成节点 `lastError`。

## 4. 下沉处理器

```ts
interface DaqFrameProcessor {
  name: string
  applies: 'vector' | 'image' | 'any'
  process(frame: DaqFrameWorking, args: Record<string, unknown>): DaqFrameWorking
}
```

- `DaqFrameWorking`:`{ kind:'vector', points?, metrics? }` 或 `{ kind:'image', blob?, thumbBlob?, mime?, width?, height?, metrics? }`。
- 执行点 `runSinkPipeline` 只在帧采样路径;单步失败保留原帧并告警,不抛出。
- 注册 `'scalar'` 会被桥映射为 `'any'`:标量样本不受影响(本来就不走 sink),但它会跑在 vector/image 帧上;标量加工放驱动/解码器。
- 同名覆盖内置会告警;热重载**不会**清退处理器(代码缺口),停用后仍可能残留到重启;需要严格卸载时换 name 或维护窗口重启。

## 5. 模板注册

```js
ctx.daq.registerTemplate({
  key: 'my-tpl', name: '我的模板', code: 'MY · TPL', ch: '通道语义',
  unit: '℃', base: 25, amp: 1, min: 0, max: 60, decimals: 2, icon: 'thermo',
  signalKind: 'scalar',                    // scalar|vector|image
  vector: { points: 64, min: 0, max: 1 },  // signalKind=vector 时
  sink: { processors: [{ name: 'resample', args: { n: 64 } }] },
  metrics: [{ key: 'avg', label: '平均', warnLow: 0.4, warnHigh: 0.6 }],
})
```

插件模板是内存态,`GET /api/workshop/daq` 的 `templates[]` 可见,但 REST 不可增删改;停用/重载**不会**自动清退(当前代码缺口),需要维护窗口重启或换 key。

## 6. 常见错误

| 错误 | 后果 | 修正 |
| --- | --- | --- |
| `sample` 返回 `NaN`/字符串 | 被当无样本或异常 | 只返回有限 `number` 或抛错 |
| 帧里塞标量 `value` | 未知 kind 被丢帧 | 标量走 `number`,帧只走 vector/image |
| image 返回 SVG/HTML | 入口策略不一致:MQTT/decoder 拒绝,ingest/HTTP/驱动路径可能放行 | 只用 raster MIME,不要依赖单一入口做安全假设 |
| vector >4096 点 | 控制器截断 | 驱动侧先降采样或报错 |
| 写驱动不填 `ack` | 网关按旧口径归一,可能误判 | 显式上报三档 |
| 解码器异步 | 契约违背 | 改为同步纯函数,异步放驱动 |
