# 插件系统/SDK/CLI 设计评审 + 双插件启停矩阵实测(2026-09-29)

## 一、实测结论:38/38 断言全 PASS(真实 KB 后端 + mock IDD 加速)

| 场景 | 结果 | 关键证据 |
|---|---|---|
| S1 KB 单独启用 | PASS | kb_agent sync 检索(5090 字结构化文本)、async 入库→kb_agent_status 完成;diag_run 被门禁拒绝("该团队未启用插件 diag-bridge") |
| S2 diag 单独启用 | PASS | diag_run 提交返 task_id → diag_status=completed+报告路径+入库指引;kb_agent 被拒 |
| S3 双插件同频道(核心) | PASS | diag_run→completed→按指引 kb_agent async 入库→kb_agent_status 回执→sync 检索**命中刚入库文档**(向量索引可查) |
| S4 双双关闭 | PASS | 两工具均门禁拒绝(隔离成立) |
| S5 频道级热切换 | PASS | PUT plugins off→工具立即不可用;on→恢复(~2s 重载) |
| S6 CLI | PASS | `aw plugin list` 四内置+作用域;disable→manifest enabled=false→enable 恢复(热重载) |

附带验证:rag-bridge token 热应用生效(health anonymous→bearer,上轮 init.mjs 修复的实证);KB 侧 fail-closed(报告文件不存在时明确 "NOT INGESTED",无编造)。矩阵脚本存档 `.e2e-tmp/plug-e2e/`。

## 二、架构评审(面向"设计是否合理、是否可维护")

### 分层判定:合理,符合 VS Code 扩展模型

```
插件作者 ──只看──▶ SDK 门面 sdk/context.mjs(ctx.hooks/config/kv/timer/route/api/http/events/twin)
                     │  零导入依赖契约:入口导出 { name, setup(ctx) } 即被装载
宿主 ──────────────▶ plugins/host/(10 文件 ≈1000 行,单文件 54~321 行)
                     │  发现(三作用域 builtin>project>user)/装载(错误隔离)/启停(状态文件
                     │  +watch+10s mtime 轮询双保险)/热重载(幂等)/配置注入/设置描述符回流
平台接缝 ──────────▶ /api/plugins/[name]/[...path] 统一鉴权(default-deny)·设置页自动渲染
                     ·  channel_plugins 表按频道过滤工具注入与 dispatch(无行=全启用,向后兼容)
插件实现 ──────────▶ plugins-builtin/{rag-bridge,diag-bridge,…} 自包含目录,声明式
                     settings/configGroups/auth + setup(ctx) 运行时追加
```

**命中最佳实践的点**(按重要性):
1. **依赖倒置干净**:插件零导入,只依赖 ctx 门面;宿主内部可整体重写不破坏第三方插件——这是插件系统最核心的正确性。
2. **错误隔离完备**:单插件装载失败不拖垮主服务(failures 登记);钩子内不抛;定时器/订阅经 onDispose 自动回收——插件崩溃边界清晰。
3. **热重载工程判断正确**:状态文件 rename 原子写 + 目录级 watch(POSIX 文件 watch 挂旧 inode 的坑已规避)+ mtime 轮询兜底(Windows rename 事件丢失)——三层冗余是踩坑后的对的设计。
4. **插件协同松耦合**:diag_status 输出 kb_agent 调用指引而非硬编码互调——任一插件缺席都优雅降级(S1/S2 实证),双开时由 Agent 编排完成"诊断→入库→检索"闭环(S3 实证)。
5. **开发者体验闭环**:SDK 版本号 + docs/plugins.md 契约 + aw-plugin-dev skill + `aw plugin create` 脚手架 + aw 工业 MCP 装载验证——第三方开发者全链路有人管。
6. **配置注入健壮**:每请求现读(无缓存陈旧)、三级根回退(cwd→packageRoot→AW_PACKAGE_ROOT)、PATCH 即热生效(本轮 S 项实证)。

**弱点与建议**(诚实清单,均非阻断):
1. `sdk/context.mjs` 单文件 ~700 行承载 11 个 ctx 域——建议按域拆成 createTwin/createConfig/createKv 等模块文件,context.mjs 只做组装;可读性会显著提升(本次不改:纯结构性重构,验收刚过不值得冒回归风险,留作下一轮)。
2. 同名插件三作用域静默遮蔽(builtin>project>user)——建议装载时对遮蔽打 warn 日志。
3. `enableKnowledgeBase:true` 只写 rag-bridge 一行,diag-bridge 维持平台默认 on——"模板开关≠完整勾选集"的语义要在 docs 里写明(实测确认行为一致且可显式 PUT 修正,非缺陷)。
4. host/ 拆分文件保留"逐行原文搬运"头注释——历史重构痕迹,建议后续统一清掉。
5. ctx.kv 防抖落盘在崩溃窗口内可能丢写——备份机制(098f419 起含 JSON 快照)已兜底,接受。

### 结论
**设计合理、鲁棒,符合插件系统与配置管理的最佳实践;全部功能实测通过(38/38),无需返工。** 唯一值得排期的改进是 SDK 门面文件拆分(可读性),不构成发布阻塞。

## 三、遗留事实记录
- mock-idd 已补 `{success:true}` 信封以对齐真实 IDD v4 协议(diag-bridge 断言 success===true,fail-closed 正确)。
- diag_run 同产线单飞:running 期间同线再发起被拒(设计行为,sweep 15s 清理)。
- 隔离 home 无数采样本时 diag_run 快照腿 fail-closed 拒发(正确),走 data_path 离线数据可测。
