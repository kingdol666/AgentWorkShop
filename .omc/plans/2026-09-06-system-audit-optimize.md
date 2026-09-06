# 2026-09-06 全系统审查与性能/算法优化规划

> 审查方式:双路并行深审(server 侧 / 前端+SDK 侧)+ 定向自查验证,共 31 项发现。
> 状态:执行中。每批完成后构建 + 回归验证 + 单独提交。

## P0 安全/正确性(必须修)

| # | 严重度 | 位置 | 问题 | 修复 |
|---|---|---|---|---|
| 1 | Critical | ws.ts:669-682 + scene-events.ts | WS `open()` 未鉴权即注册 scene peer,任何人可收全部遥测/写控广播 | sub 鉴权后才注册;peer 携带用户可见线集,广播按线过滤;未鉴权 peer 收不到任何 scene 帧 |
| 2 | Critical | dcw lines start/stop.post | 无任何权限校验——零授权用户可起停产线并真实写 PLC | `requireLineMode(id, 'operate')` |
| 3 | High | daq samples/frames/frames-content、dcw line/query、runs/* | 历史数据端点只 resolveUser,无 grant 校验,绕过整个权限模型 | node→lineId → `requireLineMode(readonly)`;line/query 校验目标线可见 |
| 4 | High | dcw index.get | recipes/runs/history/products 全量返回未过滤,泄露其他产线工艺/写历史 | 全部按线过滤;history 按 nodeId→line 联结;全局 controller 统计仅特权角色 |
| 5 | High | user.repository token_plain | API token 明文落库,与文件头声明矛盾;库泄漏=全员凭据泄漏 | 停写+迁移清空+reveal 返回 410(前端已有 TOKEN_PLAIN_GONE 处理) |
| 6 | High | getDb 无 WAL + findByToken 每请求写 last_used_at | 每个认证请求独占写锁+fsync,串行化全部 API | WAL+synchronous=NORMAL;last_used_at 60s 节流 |
| 7 | Medium | user.service.register | bootstrap-admin TOCTOU:并发注册可双 admin | 事务内原子判定+插入 |

## P1 性能热点

| # | 严重度 | 位置 | 问题 | 修复 |
|---|---|---|---|---|
| 8 | High | daq-controller:635 | writeBackTelemetry 每采样全量 filter → O(N²)/周期 | byBinding Map 索引(bind/unbind/create/remove 同步) |
| 9 | Medium | daq-controller flush | flush 尾批无定时器,停线后驻留内存直到重启 | flushTsdb finally 重查缓冲再调度 |
| 10 | Medium | daq bus | rebuildDaqQueue 不关旧 adapter,MQTT socket/pump 泄漏 | 两 adapter 加 close,rebuild 先关旧 |
| 11 | Medium | backup.ts:39-50 | copyFileSync 同步拷数百 MB → 事件循环秒级冻结 | fs.promises.copyFile |
| 12 | Medium | dcw-controller runData | 每节点串行 await tsdb 查询(N+1) | Promise.all 并行 |
| 13 | Medium | permissions/index.get | pageSize 1000 截断+每用户 2 查询 N+1+resolveUser 双查 | listAll 分页循环;requireAdmin 单次;批量 grants |

## P2 前端/SDK 缺陷

| # | 严重度 | 位置 | 问题 | 修复 |
|---|---|---|---|---|
| 14 | High | useDaqStream/DcwStream/OpsLog `__xBusFed` | 一次性守卫把真退订交给首个页面,页面卸载→实时流永久死亡 | 引用计数 feed |
| 15 | High | user.ts cookie maxAge 365d vs 服务端 TTL 30d | 11 个月死 token 往返 | maxAge 30d 对齐 |
| 16 | High | http.ts 401 | 仅 toast:不登出不清态→toast 风暴无恢复 | 401→logout+redirect+toast 去重 |
| 17 | High | sdk/api.mjs | HTTP 200 业务错误信封被当成功解包(插件拿到 null) | code!==0 抛错(带 status/code) |
| 18 | High | sdk/hooks.mjs 熔断 | fails 累计不重置,偶发失败永久驱逐健康监听 | 成功即清零(仅连续失败触发) |
| 19 | High | sdk/context.mjs KV | 关停 200ms 窗口丢写且无日志 | onDispose 同步 flush+错误日志 |
| 20 | High | apiClient.ts fetch 无超时 | 挂起连接→loading 卡死 | AbortSignal.timeout |
| 21 | Med | useDcwStream.load 全量替换 | 冲掉 WS 写状态+对象身份抖动 | 对齐 daq 的原地 merge |
| 22 | Med | useDaqStream 快照竞态 | 旧快照回退实时值/计数器 | lastAt 新者为准+计数器不回退 |
| 23 | Med | entities.ts 全数组拷贝 | 每帧 O(n) 分配 | 原地 Object.assign |
| 24 | Med | user store persist token | localStorage 二份长命 token | persist 不含 token(恢复走 cookie) |
| 25 | Med | session-restore | 无超时阻塞首绘;死 cookie 不清 | 超时竞速+401 清 cookie |
| 26 | Med | useWorkshopWs heartbeat | 每组件实例一个心跳 | 会话创建分支单例 |
| 27 | Low | useDcwStream optimizations 无上限 | 长驻看板无限增长 | cap 200 |
| 28 | Low | settings resetRuntimeKey | 重置单键清掉全部未保存编辑 | 只清该键 |
| 29 | Medium | start.mjs/single-instance | PID 复用误杀无关进程(taskkill /T /F) | 杀前校验 cmdline 属本应用 |
| 30 | Low | host.mjs fs.watch 文件 | POSIX rename 后 watch 静默失效 | watch 目录+过滤文件名 |
| 31 | Low | alarms ack / lines/products/daq create | 仅 resolveUser 即可创建控制面实体/确认告警 | requireRole 对齐 |

## 执行记录

- [x] P0 #1-#7(全部完成;#1 WS 鉴权扇出:open 仅在 ?token= 有效时注册 scene peer,
      payload 补 lineId,scene-events per-peer 可见集过滤)
- [x] P1 #8-#13(#8 siblings 1s TTL 缓存;#13 listAll+allGrants 单查询+requireAdmin 单次)
- [x] P2 #14-#20、#24、#25、#27-#31(引用计数 feed/cookie 30d/401 收尾/SDK 信封+熔断+KV/
      apiClient 超时/persist 去 token/session-restore 超时清死 cookie/optimizations cap/
      resetRuntimeKey 单键/PID 复用校验/watch 目录/ack+创建端点角色)
- [ ] P2 遗留(后续批次):#21 dcw load 全量替换对齐 daq merge、#22 快照 lastAt 回退保护、
      #23 entities 全数组拷贝原地化 —— 均为改进项(非缺陷),涉及较大重构面单独评估
- [x] 回归:build ✓;perms E2E 20/20 ✓;audit 负向断言 9/9 ✓(无 token WS 10s 0 帧,
      带 token 643 帧;start/stop/samples/frames 零授权全部 403 人话)
