# 插件兜底:什么时候写、写到哪一层、怎么验收

## 1. 判定顺序

先试声明式,再试解码器,最后才写驱动。每往下一层,维护成本与回归面都更大。

```
driverConfig 路径(jsonPath/pointsPath/imagePath/fields)
  └─ 不够 → ctx.daq.registerDecoder(name, fn)          私有 JSON/二进制 → scalar/vector/image
      └─ 不够 → ctx.daq.registerDriver(driver)         新传输协议/会话/心跳/批量读
          └─ 写侧需要自定义封装 → ctx.dcw.registerWriteDriver(driver)
              └─ 需要新数据形态 → 核心扩展(不是插件)
```

“不够”的典型信号:

- 报文不是 JSON/纯数字,或需要校验和、长度前缀、握手、分片;
- 一次读要发多条命令才能拼出一个样本;
- 写入需要多动态值、二进制帧、设备应答码判定;
- 设备要求长连接/订阅,而不是轮询。

## 2. 最小解码器(私有 JSON → 标量)

```js
export default {
  name: 'my-decoder',
  setup(ctx) {
    ctx.daq.registerDecoder('my-device-json', ({ json, config }) => {
      const t = Number(json?.payload?.t)
      if (!Number.isFinite(t)) throw new Error('payload.t 不是数值')
      return { kind: 'scalar', value: t }
    })
  },
}
```

节点 `driverConfig.decoder = 'my-device-json'` 即启用。解码器必须是**同步纯函数**,返回形态必须与模板 `signalKind` 一致;不要在里面发网络请求或写库。

## 3. 最小读驱动(私有协议)

```js
export default {
  name: 'my-protocol',
  setup(ctx) {
    ctx.daq.registerDriver({
      kind: 'my-protocol',
      async available() { return true },
      async sample({ driverConfig }) {
        // 连接、发命令、校验、解析
        return 25.3                       // 标量
        // 或 { frame: { kind: 'vector', points: [...] } }
        // 或 { frame: { kind: 'image', blob, mime, width, height } }
      },
      async test(driverConfig) {
        return { ok: true, message: '连接成功', sampleValue: 25.3 }
      },
      meta: {
        label: 'My Protocol',
        status: 'real',
        configFields: [
          { key: 'host', label: '地址', type: 'string', required: true },
          { key: 'port', label: '端口', type: 'number', default: 9000 },
        ],
      },
    })
  },
}
```

推送式协议实现可选 `subscribe(input)`(返回幂等 stop)与 `fingerprint(cfg)`;一旦实现 `subscribe`,控制器按事件驱动采集,不再进入 `intervalMs` 轮询。

## 4. 最小写驱动

```js
export default {
  name: 'my-writer',
  setup(ctx) {
    ctx.dcw.registerWriteDriver({
      kind: 'my-protocol',
      async available() { return true },
      async write({ eng, driverConfig }) {
        // 组帧、发送、按设备应答判定
        return { ok: true, message: '设备已受理', raw: null, readback: eng, ack: 'transport-ack' }
      },
      async test() { return { ok: true, message: '连接成功' } },
      // 可选:read(input) 回读;canRead(cfg) 判定是否真的有读通道
    })
  },
}
```

`ack` 必须如实:`readback-verified`(独立回读且容差通过)/ `transport-ack`(仅链路受理)/ `unverified`(无确认)。不要把 `transport-ack` 冒充成设备证实。

## 5. 热加载与生效

1. 放 `.AgentWorkShop/plugins/<name>/index.mjs`(project)或 `~/.AgentWorkShop/plugins/<name>/index.mjs`(user);`aw plugin install <dir>` 也可。
2. `aw_plugin_toggle { name, enabled: true }` 或触碰 `<home>/plugins-state.json`;宿主 ~1s 全量重载。
3. `aw_plugin_list` 确认插件存在、`failures` 为空。
4. 实测:驱动出现在 `GET /api/workshop/daq` 的 `drivers[]`(带 `plugin:true`);路由可访问;钩子计数增加。
5. 改代码后保存 → 再 toggle 一次(ESM cache-bust);**不要重启进程**。

builtin 插件(`server/plugins-builtin/`)的 entry 也会随状态文件重载,但内部 helper 模块可能被 ESM 缓存,且 builtin 优先级会遮蔽 project 同名副本;验证不生效时移交维护窗口,不要重启生产进程。

## 6. 验收:插件“接上了”不等于“数据对了”

- **协议面**:`test-driver` 返回 `ok=true`;节点 `lastError` 为空;采样周期稳定。
- **值面**:`verify-mirror.mjs --expect '{"value":...}'` 命中;不是常量/上一批残留。
- **形态面**:vector 点数=模板声明;image `meta.objectKey` 存在且内容端点字节非空。
- **写面**:`aw_dcw_write` 回执 `ack` 等级与驱动声明一致;有 `readTopic` 时回读=目标值;无读通道时用独立 DAQ 观测物理量跟随。
- **导出面**:CSV 列名/行数与文件一致(DAQ manifest 不含 sha256/列名,需自行核对);时间戳在窗口内且单调;`line/product/recipe/run` 标签正确。
- **回归面**:既有内置协议节点不受影响;`aw_plugin_list` 无 failures;停用插件后驱动立即失效(热重载清退)。

## 7. 回滚

- 停用插件:`aw_plugin_toggle { name, enabled:false }`;宿主会清空该插件的驱动/解码器,但**处理器/模板目前不会自动清退**(代码缺口),需要维护窗口重启或改名规避。
- 删除本次创建的测试节点/线(按 id 逆序);不要删除既有资源。
- 如果插件只用于测试,保留目录但停用,便于下次复用;生产不需要时再 `aw plugin` 移除。

## 8. 不要做的事

- 不要在插件里绕过 `ctx.http` 直连任意 URL;出站仍受 SSRF 白名单约束。
- 不要吞异常返回假值;失败要让 `sample` 抛错,节点 `lastError` 才会可见。
- 不要把凭据写进插件源码或 KV;用 `secretRef`/环境变量。
- 不要为“让插件生效”重启生产进程;热加载足够。
