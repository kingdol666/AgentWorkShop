# 企业生产化第二轮上线加固报告(2026-10-09)

> 依据 2026-10-08 上线就绪度评审的 P0 清单实施(审批离线外呼按用户指示本轮**不做**,待接入方式确定后另行落地)。
> 目标:企业生产可落地 —— HITL 真人审批闭环、MQTT 真实产线协议、认证生产姿态、备份恢复韧性、部署基线。

## 一、结论

**P0 批次六项全部落地,专项 e2e 39/39 全绿,全量回归全绿,LICENSE 已换 Apache-2.0。** 平台具备单机内网 + 反代 TLS 形态的企业生产落地条件。

| 项 | 内容 | 结果 |
|---|---|---|
| A1 | HITL 巡检豁免(真人审批>150s 不再被误杀) | ✅ 专项 I 腿实证 |
| A2 | MQTT mqtts(TLS)+ 陈值保护(采/写双侧) | ✅ 专项 Q 腿实证 |
| A3 | 注册闸门缺省关(新装 fail-safe) | ✅ 专项 R 腿实证 |
| A4 | 备份扩围(daq-objects/exports + MANIFEST)+ 恢复演练 | ✅ 专项 K/X 腿实证 |
| A5 | 首登强制改密全链(建号/重置/改密/会话吊销) | ✅ 专项 M 腿实证 |
| A6 | README 双语「部署(生产)」章(TLS 反代/systemd·nssm/备份恢复/检查清单,修复悬空引用) | ✅ docs:check 91/91 |
| A7 | LICENSE:PolyForm Noncommercial → **Apache-2.0**(用户拍板;LICENSE/package.json/CITATION/README 双语/cli 表/license 指南页中英全链同步) | ✅ 同源对全一致 |

## 二、实施明细(file:line)

1. **HITL 巡检豁免**:`server/services/workshop/runtime/manager/runtime-wiring.ts:264` —— `unloadAgent` 增加挂起审批守卫(动态 import `getToolApprovals().listPending(agentId)`,避免 tool-approvals → platform-notice → manager 静态环)。有 pending 审批卡的 agent 不再被空闲巡检卸载(此前 ~150s 停机 → `cancelAllForAgent` 把真人待批卡收敛为「回合已被中止」拒绝,hold 模式也拦不住)。删除实例/频道仍走 `stopAndDetach` 直达,管理动作保持 fail-closed。
2. **MQTT 陈值保护**:`daq/drivers/mqtt.ts` —— sample 层 `staleMs` 判定(缺省 300s,`driverConfig.staleMs` 覆盖,0=关):连接活着但设备停发时**拒用冻值**,节点离线且 lastError 如实(「MQTT 数据停发超过 Ns(陈值保护)」),恢复发布自动回流。
3. **MQTT TLS(mqtts)**:采/写双侧同源 —— `daq/drivers/mqtt.ts` 导出 `mqttConnectOpts()`(节点 `driverConfig.secure/caFile/rejectUnauthorized` 优先,回落全局 `daq.mqtt.*` runtime-settings/env 别名),`dcw/drivers/mqtt.ts` 复用;坏 CA 配置期显式报错,不静默降级明文。连接池键含 scheme+CA 防串连。
4. **注册闸门**:`shared/config/schema.json` `security.allowRegistration` 缺省 true→**false**(首管理员就位后注册端点 403;首启引导不受影响 —— 零用户时首注册仍是 bootstrap admin)。存量部署经设置 API 同步切 false(此前 runtime-settings 显式 true)。
5. **首登强制改密**:`users.sqlite` 加 `must_change_password` 列(幂等迁移);管理员建号/PUT 重置 → 强制标记 + **吊销全部旧会话**(`userRepository.revokeAllTokens`);新端点 `POST /api/users/change-password`(当前密码验证);前端 `ChangePasswordModal.vue` 挂主壳(不可关闭,改密成功前不得进入工作台),i18n 中英齐备。实施中修了两个缺陷:toUser 列别名读错(查询别名 `mustChangePassword` vs 读取 `must_change_password`,强制标记恒 false)、PUT 改密路径漏吊销会话。
6. **备份扩围**:`server/plugins/backup.ts` —— `daq-objects/`(图像帧对象存储)+ `daq-exports/`(导出宽表)入备份,体量上限 `AW_BACKUP_OBJECTS_MAX_MB`(缺省 200MB,超限显式跳过落日志不做半份拷贝);每次附带 `manifest-<stamp>.json`(dbs/objects/infraNote 声明 Timescale/MinIO 卷边界);objects 束同 keep 轮转。
7. **部署文档**:README.md / README-zh.md 新增「部署(生产)」章 —— caddy/nginx TLS 反代样例(含 WS Upgrade 头)、systemd unit + Windows nssm、备份内容与恢复步骤、生产检查清单(随机 session 密钥拒启默认值/注册闸/HSTS/限流在岗);`server/plugins/security.ts` 拒启文案对 README「部署」的引用由悬空变有效。

## 三、专项 e2e(39/39)

`node tmp-e2e/production-hardening2.mjs`,六腿:

- **R 注册闸门(5)**:schema 缺省 false;live=false;注册 403 REGISTRATION_CLOSED;开闸→放行→关闸复原双向验证。
- **M 强制改密(10)**:建号强制 → 首登//me 带标记 → 错当前密码 401 → 改密清除 → 重置再强制 → **旧会话 token 即死(401)**。
- **Q MQTT 陈值+TLS(8)**:mqtts 坏 CA 显式拒;节点(staleMs=6s)发布入库 → 停发 12s 后 lastError「数据停发超过 12s(陈值保护,拒用冻值)」且无新桶 → 恢复发布 10s 内 4 桶回流自愈。
- **K 备份 MANIFEST(4)**:dbs 三库;objects 面入备(daq-exports 36MB 入备;daq-objects 627MB>200MB 上限显式跳过);infraNote 边界声明。
- **I 巡检豁免(6)**:manual 总闸 → 同值 recipe_update 挂卡 → **穿越 150s 空闲巡检窗卡片仍 pending** → 批准正常固化(非「回合已被中止」);总闸复原 auto。
- **X 恢复演练(5)**:最新备份重组数据目录 → AW_DATA_DIR 第二实例(:3100)健康 → 恢复库 admin 登录 → **36 条产线在册** → 现场清理。

## 四、全量回归

| 套件 | 结果 |
|---|---|
| 专项生产化第二轮(新) | **39/39** |
| api-full-loop | **53/53** |
| 加固专项 L13(ACK 鉴定+总闸) | **34/34** |
| L11 多源异构只读探针 | **12/12** |
| Agent 产线多任务 e2e | **23/23** |
| PIPELINE 一键基准 S0-S12 | **92/92**(`docs/benchmarks/benchmark-20261009024141/`;T7 基线锚 v43 复原,S6 规格占比达标) |
| docs:check | **91/91** |
| typecheck / eslint(改动面) | 0 错误 |

合计 **253 项断言全绿**(39+53+34+12+23+92)。

## 五、测试过程发现与处置(缺陷三问)

1. **toUser 列别名错(真缺陷,已修)**:`findById` 等查询 `SELECT must_change_password AS mustChangePassword`,而 `toUser` 读 `row.must_change_password` → 强制标记恒 false。修复:双形状兼容读取。可复现(建号→登录标记丢失);根因如上;回归 M2/M3/M9。
2. **PUT 改密未吊销会话(真缺陷,已修)**:`resetPassword` 服务方法存在但无端点接线,实际走 `userService.update`,密码变更后旧 token 仍有效。修复:update 密码路径统一置强制标记 + `revokeAllTokens`。回归 M7/M8/M9。
3. **存量配置覆盖(部署事实)**:runtime-settings.json 显式 `"security.allowRegistration": true`(历史测试轮所置),schema 缺省翻转对新装生效但存量覆盖仍在 —— 已经设置 API 把本部署切 false 并实证。**提醒:其他已部署实例升级后需在设置面确认此键。**
4. **测试脚本形状三例(非缺陷)**:test-driver 响应包裹在 `data.test`;daq 节点创建必绑 `templateRef`(用 `daq-temp-tc`);mqtt 无 jsonPath 时报文契约是**裸数字**(发 JSON 不配 jsonPath = 提取失败不入库,表现为"假断流")。均已入 skill L14 速查。

## 六、上线部署清单(随本轮文档化)

README「部署(生产)」章:反代 TLS(caddy/nginx 样例,WS Upgrade 头)→ systemd/nssm 服务化 → `NUXT_SESSION_PASSWORD` 随机化(默认值拒启)→ 注册闸 false → HSTS → 备份确认 + **恢复演练通过**(本轮已实测演练一遍)→ `/api/health`+`/api/metrics` 接监控 → `AW_RATE_LIMIT_OFF` 不设。

**遗留(已记录待排)**:审批离线外呼(webhook/邮件,等用户接入方式)、四眼原则可选双人复核、mes-rest 运行时设置 token TODO(当前 env 生效)、OPC UA 订阅模式与 Double 写类型、modbus FC06/直连串口。对接真实 PLC/MES 的现场映射(byteOrder/unitId/证书/historyMap)按 `aw-line-onboarding` skill 执行。
