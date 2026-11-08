# 生产就绪审计 · 终报（2026-11-08）

> 输入：8 项外部指控 + 全局代码扫描 + :4001 活体复现 + 独立专家评审（复核 5 项声称/盲区 6 角度）。
> 底稿：AUDIT-BASE.md · 评审：EXPERT-REVIEW（本文件含其结论）。
> 生产场景定义：单实例/小团队内网部署、局域网产线接入、有真实设备写控。

## 一、八项指控裁决

| # | 指控 | 裁决 | 定级 | 一句话证据 |
|---|---|---|---|---|
| 1 | 热重载非原子/无回滚 | 部分真实 | P2（专家降级：维护窗+重启绕行） | clear→load 实证，POST 阻塞 6.06s×2；omp 工具面已缓解；有单插件半装载回滚、无宿主版本快照回滚 |
| 2 | watcher 错目录 | 真实 | P1 | 非递归 watch+遗留布局 vs 生效配置在 `.AgentWorkShop/`；CLI 打印虚假「实时生效」；无手动 reload 端点 |
| 3 | one-shot 构造崩溃 | **真实** | **P0** | base 构造器读未初始化 `this.spec` → 6/14 引擎 TypeError；**活体**：gemini activate 500/43.4s；restore 路径可启动崩溃循环；2026-10-31 回归 8 天零拦截=无契约测试 |
| 4 | Codex copy 先于 mkdir | 部分真实 | P1 | 顺序错误属实+首用必触发，但被 catch 吞→静默种子丢失；次生 CODEX_HOME 时序缺陷（首回合无 MCP 桥） |
| 5 | 成果提交时序缺口 | 真实 | P1 | release 置 `channels.enabled=0`→实例提交面关闭；自主模式（owner 不值守）项目可卡死；多会话轮驱动已实证绕行路径 |
| 6 | 事件协议无结构化 Block | 真实 | P1（审计面） | `🔧`+正则全链路；300 字符截断；完整审计 opt-in 默认关；各 harness 文案互不一致 |
| 7 | UI 与后端不一致 | 部分真实 | P2 | 后端 14 引擎+动态接口已就绪；Project Leader 4 项/Channel LLM 4 项/泳道成员 3 项三处硬编码；终端 omp-only=三层一致的设计 |
| 8 | leaderHarness 默认 mock | 真实 | P1 | service.ts:609/628/3888 三处 `?? 'mock'` 静默替身 |

## 二、专家复核修正与新增

- **修正**：备份冻结底稿定 P1 **过时**——库文件拷贝已异步化（backup.ts:100-104 注释记载既往事故与修复）；残留仅 dirBytes 同步遍历与对象面 cpSync（200MB 上限截停）→ 降 P2。
- **新增 P0-2（审计盲区）**：**daq/dcw 设备驱动 `?? 'mock'` 静默默认**（daq-node.ts:97、dcw-node.ts:108）——有真实设备写控的产线，节点漏配 driver 即静默 mock：数据是假的、写控 ACK 是假的、journal 照常留痕。安全级，与既往 skill 教训（mock 写入"成功"设备零触达）互证。
- **新增 P1**：升级路径——legacy rebuild 多语句 exec 无事务包裹（migrations.ts:375-387），迁移早于首备（+30s），迁移炸库无前置快照可回。
- **正面确认**：SIGTERM 优雅停机链路完整；agent token 轮换宽限+REST 不透出；/api/metrics 实用；SQLite WAL+busy_timeout；迁移幂等加列式。
- **盲区解释 P0 为何潜伏 8 天**：metrics 无引擎失败计数——崩了没有任何信号可见。

## 三、生产风险全景（专家重排后）

**P0（上线阻断，2 项）**
1. 6/14 引擎构造崩溃 + restore() 无逐 channel 兜底
2. 设备节点驱动 mock 静默默认（真实写控场景=假数据+假 ACK）

**P1（上线后 30 天内收敛，5+3 项）**
成果提交缺口（按项目策略：auto=自动 integrator / manual=UI 待办显式化，release 改为交付门关闭后释放）· activate 长阻塞无超时（43s，P0 放大器）· watcher 错位+CLI 虚假确认 · 事件协议结构化块+审计默认开 · leaderHarness 去默认 · 迁移无事务+无前置快照 · 停机 10s 兜底 vs 30-90s 冷启动的检查点未验证

**P2（排期，5+ 项）**
插件宿主版本快照回滚 · 备份对象面异步化+dirBytes 护栏 · 无全局限流（代理层兜+端点级上限） · Timescale 缺省口令（上线清单必改） · UI 三处硬编码引擎清单 · 设置页 env-locked 徽标 · SQLite 容量声明

## 四、优化 Plan（专家骨架，已采纳）

**阶段 0：上线前阻断（约 1 周）**
1. 修 one-shot 构造顺序 + restore 逐 channel try/catch + **CI 全 14 引擎构造契约测试**（防"8 天盲窗"复发）——S-M
2. 产线绑定节点禁 mock 驱动：绑定产线的 daq/dcw 节点强制显式 driver，启动 fail-loud 校验——S
3. leaderHarness 去默认（缺省 400 带提示）——S
4. activate 服务端 deadline ~30s + 引擎失败/延迟计数器入 /api/metrics——S-M
5. 升级保护：schema 变更启动先快照三库+配置到 pre-upgrade-*；legacy rebuild 包 BEGIN IMMEDIATE——S
6. 部署 runbook：env pin 清单/Timescale 改口令/token 轮换/**恢复演练**——M

**阶段 1：上线后 30 天**
watcher 修+CLI 诚实化(S) · 结构化工具块 v1（omp emitter 先行，data Part kind='tool_event' 并行发射）+生产 profile 事件日志默认开(M) · 交付物门按项目策略实现+release 改门后释放(M-L) · 停机加固（兜底可配+检查点验证+kill -9 演练）(S-M) · 观测告警阈值(S-M) · 限流(S)

**阶段 2：90 天**
宿主级版本快照回滚(M-L) · SQLite 容量/保留声明+实测数字(M) · 全 harness 事件协议对齐(M-L) · env-locked 徽标(S) · 备份异步化收尾(S)

## 五、总判定

**CONDITIONAL-GO** —— 满足阶段 0 六项后可上线；其余 P1 在上线后 30 天内收敛。
底稿全部证据与专家全文见同目录。
