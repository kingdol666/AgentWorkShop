# 生产实例启动/复活 Runbook(AW_HOME=D:/tmp/aw-prod-1031 @3300)

> 来源:2026-11-01 final-acceptance 轮 E-2/E-4 实录。任何"重启生产实例"的动作只允许在实例已死或配置漂移时执行;运行中实例禁重启(生产附加纪律)。

## 1. 启动 env 清单(必须齐全,缺一即功能降级)

```bash
export AW_MODE=home
export AW_HOME="D:/tmp/aw-prod-1031"
export AW_ALLOW_PRIVATE_OUTBOUND=1   # 缺失 → diag-bridge/IDD/RAG 出站全被 SSRF 守卫拒绝
export AW_MCP_ENABLED=true           # 缺失 → MCP 工具面被拒
```

## 2. 标准启动(真分离)

```bash
node scripts/_audit/detached-start.mjs --port 3300 --log /d/tmp/aw-3300-<tag>.log --wait 60
curl -s http://127.0.0.1:3300/api/health   # 期望 status=ok
```

- detached-start 检测到健康实例会"不重复启动"——**改配置必须先杀旧实例**(见 §3),否则 env 漂移悄悄存续(E-2 实录)。

## 3. 崩溃/漂移后的正确复活顺序(E-4 教训)

1. 找 3300 监听 PID:`netstat -ano | grep :3300 | grep LISTENING`
2. **顺进程链杀整树**:`aw.mjs start`(祖父)→ `scripts/start.mjs`(守护)→ `.output/server/index.mjs`(子)——只杀子进程,守护会立刻用**旧 env** 复活(E-4 实录);用 `taskkill //PID <祖父> //T //F`
3. 带完整 env(§1)执行 §2
4. 验证:`/api/plugins/diag-bridge/health` → `remote.status=ok`(证 env 生效);插件 11 enabled/工具 126 available

## 4. 守护放弃(“N 次退出超出上限”)后

- 这是按设计 fail-loud,**不会有自动外呼**——监控必须盯着日志行「放弃重启,请人工排查」
- 排查顺序:先看系统内存(31GB 机器上 4 组并行单测+多 dev 实例足以挤崩生产堆,E-1 实录)→ 再看崩溃 stderr → 修资源/代码后按 §3 复活

## 5. AML 训练前置(数据面三道门)

1. 三元组齐备(line_id/product_id/recipe_id)+ 操作者持有节点 daq 绑定(绑线只读≠训练授权,"绑定只缩不放")
2. 批次必须**已完结**(close 后才可训)
3. 网格缺失率 ≤30%(beat_ms 可放宽,但宕机洞/设备重启会让数据永久不合格——重开干净连续批次 ≥30min)
