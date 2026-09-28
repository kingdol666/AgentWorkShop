# 安全加固与红队验收记录(2026-09-29)

范围:公网化上线前的全量安全加固。方法 = 3 路只读审计(SQL注入/命令注入/路径穿越面、认证隔离/越权面、滥用防护与备份现状)+ Mimosa 深度扫描 + 修复 + 3 路红队实弹测试(SQL注入 139 样本 / 认证绕过越权 8 矩阵 / 限流反爬压测 8 项)+ 基准回归。

## 一、红队测试结果(修复后终态)

| 红队 | 样本 | 结论 |
|---|---|---|
| A·SQL注入/盲注/错误面 | 139 | **0 LEAK,0 BYPASS**。全参数绑定+白名单列名;500 信封无堆栈无路径;时间型盲注无时差;原型污染无 |
| B·认证绕过/越权 | 8 矩阵 | MCP/A2A 匿名与跨 channel、fs 白名单、注册闸门、token 混乱、水平越权、自提权**全数 BLOCKED** |
| C·限流/防爆破/反爬/上限 | 8 项 | auth 面 20/min、API 面 600/min 独立两档;登录失败 5 次锁 15 分钟;404 扫描 60 发封 IP 10 分钟;UA 黑名单;body 64MB;MCP 会话 64 上限——**全部按预期生效** |
| bench 回归 | 82 断言 | **fail=0**,防护中间件对正常负载零拦截(AW_BENCH_MODE=1 旁路限流;安全头照常生效) |

## 二、修复的漏洞(P0×2 + P1×5 + 加固)

1. **MCP 端点工具无鉴权(P0)**:workshop.channel.create/remove、agent.create/add/remove、task.submit、device.read/control/push_telemetry 匿名可调 → 全部 requireCaller + channel 归属校验 + 设备绑定尊重;sessions Map 加 64 上限(防匿名刷爆内存)。
2. **A2A JSON-RPC 匿名(P0)**:tasks/send/sendSubscribe/get/list/cancel 匿名可打、cancel 曾以 lead 系统身份回退 → 统一 requireA2ACaller(有效 Bearer token + URL agent 同 channel),删除 lead 回退。
3. **插件转发层默认开放(P1)**:默认 auth 'none' → default-deny('user');并修真根因 `plugins/host/load.mjs` 预置 `?? 'none'` 架空转发层默认值(红队 B 抓到的唯一 BYPASS:aw-matrix-plugin/stats 匿名可达)。确需匿名的路由由插件显式声明 'none'。
4. **fs/dirs 任意目录列举(P1)**:path 白名单(项目根+配置根+数据目录,isPathInside 判定),parent 链不出根。
5. **注册面(P1)**:security.allowRegistration(默认 true)总闸;关闭且首 admin 就位后两个注册端点 403 REGISTRATION_CLOSED。
6. **配方 revert 缺角色门(P1)**:与 apply 同 requireRole(admin/editor)。
7. **metrics/ops-logs 收权(P1)**:metrics 需任意有效用户 token;ops-logs 收 admin/editor。
8. **token 明文(P2)**:遗留导入路径不再落 token_plain(哈希鉴权不变;存量每次启动清空的迁移原保留)。
9. **健壮性**:users 分页参数钳制(1e20 页码不再 500);line/query 数值参数非负安全整数校验;LIKE 通配符 ESCAPE 转义。

## 三、新增防护基建

- `server/middleware/00-security-headers.ts`:XCTO/XFO/Referrer-Policy/Permissions-Policy/CSP 全站;HSTS 按 security.hstsEnabled 开关;/api/* no-store。
- `server/middleware/01-rate-guard.ts`:UA 黑名单(默认拦 sqlmap/nikto/nuclei 等,AW_UA_BLOCKLIST 可追加)、body 64MB(AW_BODY_LIMIT_MB)、auth 面 20/min(AW_RATE_LIMIT_AUTH_PER_MIN)、API 面 600/min(AW_RATE_LIMIT_API_PER_MIN)、404 扫描 60 发封 10 分钟;AW_RATE_LIMIT_OFF / AW_BENCH_MODE=1 旁路。
- 登录防爆破:user.service 15 分钟窗口 5 次失败锁(ip+邮箱隔离;单次失败不锁——红队 C 发现初版"1 次即锁"的可用性缺陷,已修)。
- `public/robots.txt`:全站 Disallow(登录制平台无公开内容)。
- 新设置:security.allowRegistration / security.hstsEnabled(115 项/18 组基线,README/docs 已同步)。

## 四、备份机制(生产级)

- 原有:三 SQLite 库每日定时快照(backup.interval_hours/keep,设置页可配)。
- 新增:data 目录全部 JSON 仓储 + config.yml + runtime-settings.json 一并快照(files-<stamp>/ 目录,同 keep 轮转)。
- 新增管理面:POST /api/system/backup/run(admin 手动触发)、GET /api/system/backup/list(admin 清单);备份成败落 audit_log(system.backup.*);settings PATCH/reset、用户增改删、均落审计(值不落审计防凭据泄露)。

## 五、Mimosa 深度扫描

scan-2026-09-28T17-22-54(seal sha256:9450…e8fb),45 findings:**无新增真实漏洞**——HIGH 均为误报(i18n 文案键名、本地测试脚本口令、data/workspaces 运行时生成物、bench 分析 CLI);状态 inconclusive(静态边界)如实记录。

## 六、已知接受风险与运维提示

- token 经 WS `?token=` 查询串(会进反代日志)——建议反代侧屏蔽该参数日志,后续轮改 sub 帧。
- A2A agent card 与 /api/plugins/manifest 保持公开(A2A 规范/插件面板设计)。
- CSP 含 'unsafe-inline'/'unsafe-eval'(Nuxt 水合与 dev 需要);反代上 TLS 后开启 hstsEnabled。
- 多实例部署时内存态限流/锁定每实例独立,应在反代层(WAF/网关)再配一层。
- 红队产物:.e2e-tmp/rt-{a,b,c}/、rt-final.mjs;靶机日志 .e2e-tmp/rt-platform*.log。
