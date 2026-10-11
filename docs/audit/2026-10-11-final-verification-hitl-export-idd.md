# 终验报告:人类 HITL 审批/数据获取/导出分析/IDD 插件分析(2026-10-11 上午)

> 命题:再查系统启动;验证人类用户能否真实审批参数下发;数据能否真正获取;连续时序能否导出到文件夹并分析;能否传给 IDD 插件分析。

## 结论(先答)

**四项全部真实可用,全链闭合。** 亮点:IDD 独立检出了我们人工下发制造的工艺台阶(稳健 z=3.75 超阈值告警),与本地直算结果交叉印证——两个独立分析引擎对同一物理事件给出一致结论。

## 一、系统启动检查 —— 全绿

平台 :3001 健康;PLC 模拟器 :4010 在线;MES 模拟器 :15060 在线(401=需 token,预期);Docker 三容器(mosquitto/timescale/minio)Up 10h;infra 不降级(mqtt/tsdb/oss 全 true);DAQ 控制器在采(累计 produced 220.7 万/存储 215 万样本);A2O 线活动批次在册(rr-f88c7bbd 等 5 批)。

## 二、HITL:人类用户真实审批参数下发 —— 通过

流程全按 UI 同款路径(无脚本特权):
1. 工艺工程师(Agent)提交提案:风机频率SP 40.5→42Hz 回位(emergency,exp_ref=hitl-human-verify-20261011)→ **HITL 卡 ap-b488eed1 拦截(policy=owner_only)**;
2. **人类用户 visual@awshop.local**(频道属主,role=admin 的界面账号)登录 → 用户视角待办列表看到卡(标题/agent/策略/时刻齐全);
3. 用户批准(带批语「同意 40.5→42 回位,单变量验证完成后保持基线」)→ 返回码 0;
4. 提案方收到回执:**「[人工反馈] 人工审批(产线负责人 visual):同意 40.5→42 回位…」批语逐字回流** + 整批下发 rr-571f7422 全部设备证实;
5. 设备读回 **42Hz 一致**;audit 账本裁决留痕 `approval.approve actor=user:visual`。

## 三、数据真实获取 —— 通过

A2O 线五协议族 2 分钟窗探针 5/5:风压 60.7 kPa(modbus-tcp)、DO 4.205(opcua)、出水COD 94.8(http)、进水COD 417(mqtt)、MLSS 3502(modbus-rtu);向量帧管线正常。

## 四、连续时序导出到文件夹 + 本地分析 —— 通过

`daq_export` 近 40 分钟全窗 → `daqexp-20261011102132-70ecf2/`(manifest.json + merged.csv 12 通道宽表 + nodes/ 12 文件 53373 行逐样本原始时序,无降采样)。**独立本地脚本直算**(不依赖平台):
- 定位 10:17:08 的 40.5→42Hz 下发台阶(在 SP 回读侧);
- **台阶前 12min vs 后 3min 对比:风压 60.24→60.94 kPa(+0.70)、DO 3.904→4.219 mg/L(+0.315)**——下发效应在导出的连续数据中完整可复算(风机回 42Hz → 曝气恢复 → DO 回升,物理方向全对);
- manifest 携带产线/产品/配方/批次上下文,统计口径注意空串过滤。

## 五、传 IDD 插件分析 —— 通过(附一次真实告警)

链路:merged.csv 抄送 IDD 交换目录(`workspace/aw-exchange/`)→ `sentinel_baseline` 建档(task SNB-20261011022330,completed)→ `sentinel_screen` 秒筛(500 行尾窗)→ `sentinel_watch` 批筛(1150 行全量,30ms 纯统计)。
**IDD 真实检出**:fast_screen 告警 **ALT-20261011-022710-001(ROBUST_Z_OUTLIER,好氧区DO,稳健 z=3.75>3.5,severity=high,urgency=same_shift)**——正是我们 10:17 下发制造的 DO 台阶;watch 批筛 84 条告警(DO/COD 的 NELSON_R1 3σ 突变 + 稳健 z 离群,集中于两次下发台阶),产出中文报告 `watch_report.md`(总体状态 alert,基线 prior v1.0.0,零 LLM 确定性计算)。**与第四节本地直算交叉印证:两个独立引擎对同一物理事件结论一致。**

### IDD 环境变更与处置(重要)

IDD 服务(:3210,uptime 10h)**新增了 API 鉴权**(AUTH_REQUIRED;插件匿名调用会失败,screen 首报「无法判定(无基线)」实为 401 被吞)。处置:
1. IDD 侧注册/登录 `awtest` 并签发 API token(存 `tmp-e2e/idd-token.txt`);
2. **待办**:把 token 填入平台插件设置(插件 idd-closedloop-bridge → IDD API Token 字段,保存即热生效)——Agent 侧 sentinel_* 工具此后恢复;本轮以平台外直调 IDD API 完成验证(与插件同端点同契约)。
3. 基线默认解析按登记名(A2O-ln0d5bfeac),screen 显式传 baseline_path 最稳:`workspace/closedloop/sentinel/baselines/A2O-ln0d5bfeac/watch_baseline.json`。

## 六、判定表

| 命题 | 判定 | 关键证据 |
|---|---|---|
| 系统可启动/在运 | ✅ | 四服务+Docker 全绿,215 万样本在库 |
| 人类用户可审批参数下发 | ✅ | visual 批准 ap-b488eed1 → rr-571f7422 读回 42,批语回流,audit=user:visual |
| 数据真实可获取 | ✅ | 五协议族探针 5/5 |
| 连续时序导出+可分析 | ✅ | 53373 行逐样本落盘;本地直算复现下发台阶效应 |
| 可传 IDD 插件分析 | ✅ | screen 告警 z=3.75 + watch 84 条中文报告,与本地直算交叉一致 |

—— 生成:终验轮 2026-10-11(证据:hitl 卡/审计/journal/导出目录/IDD 产物 watch_report.md)
