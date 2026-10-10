# skill 优化轮:一键接入编排器 + 对产线负责铁律(2026-10-10)

> 用户命题:skill 继续优化 —— 用户给真实场景需求(文档),**不需要手动在项目里配置**,skill 直接创建出:连接节点、MES API(含自动连通测试)、recipe 创建/绑定、Channel 与 lead/worker 对节点和 recipe 的绑定、场景提示词与频道编排;**不确定必问用户**(写入 skill);测试期自动 HITL,**投用必须用户 judge & taste**。

## 一、交付内容

| # | 交付 | 说明 |
|---|---|---|
| 1 | **`scripts/onboarding/onboard.mjs`(新增,一键编排器)** | 一份统一配置 JSON → 五阶段流水:连通预检(未全绿不供给)→ 产线供给 → 频道锻造 → V1-V6 验收 →(`--smoke`)冒烟闭环步**自动 HITL 裁决** → 交接声明(落袋 id + 投用复核清单)。任一阶段红即停,不进入下一步。 |
| 2 | **provision-line.mjs 增强修复** | mes-rest 的 readMap/writeMap/historyMap/headers 输入面允许对象,**脚本自动 JSON 字符串化**(消灭上一轮实测的最大编码坑)。 |
| 3 | **forge-channel.mjs 增强** | ①`mesFetchGrants`:history-only mes 节点的**授权配方自动创建+绑定**(可见面正道,kind='dcw' 绑定已废弃);②`scene`/`promptVariables` 透传模板实例化(场景提示词定制面)。 |
| 4 | **SKILL.md 双副本增补**(skills/ + .agents/skills/,已同步) | ①「对产线负责的两条铁律」置于步骤之上:**不确定必问**(必问清单:量程/步限缺失、SP-PV 判定、MES 认证、场景目标、治理档位)+ **测试自动裁决、投用用户裁决**(skill 只到"可投用",不得代用户宣告投产);②一键用法与统一配置 schema 指引。 |
| 5 | **新产线标准文档 + 统一配置** | `docs/onboarding/标准产线开发文档-污水线.md` + `tmp-e2e/wwtp-onboarding/wwtp-onboard.json`(A²O 污水线,20 点五协议族,含向量模板 daq-ct-d4b27cfc 的 DO 剖面)。 |

## 二、端到端实证(全新 wwtp 产线,一条命令)

`node scripts/onboarding/onboard.mjs tmp-e2e/wwtp-onboarding/wwtp-onboard.json --smoke` → **exit 0**:

| 阶段 | 结果 |
|---|---|
| 连通性预检 | **5/5**(modbus 读 90%/mqtt 进水 COD 423/http 出水 360) |
| 产线供给 | **24/24**(线 `ln-0d5bfeac`,7 DCW + 13 DAQ,配方 `rc-b45b9ada`,批次 `rr-77e96337` 开跑) |
| 频道锻造 | **17/17**(频道 `344a6282`,14 条绑定含向量 DO 剖面,种子任务派发) |
| V1-V6 验收 | **33/33**(全数采落库/越界必拒/写回环/配方映射/插件/受保护线零扰动) |
| 冒烟(自动 HITL) | **✅** 风机频率步提案 → 自动裁决批准 → **整批下发设备证实**(`rr-0c2dd92f`) |
| 编排器断言 | **6/6** |

一条命令合计 **~85 断言全绿**,全程零手工配置。产物:`tmp-e2e/wwtp-onboarding/onboard-result.log`(全程留痕)。

## 三、设计要点(为什么这样优化)

1. **自动但不越权**:onboard 到"可投用"为止;冒烟阶段用 `--smoke` 显式声明测试语义(自动 HITL),交接声明强制输出"投用需产线负责人 judge & taste"+复核清单 —— 把"对产线负责"固化进产物而不是口头承诺。
2. **把上一轮的实战坑变成脚本能力**:historyMap 字符串化进 provision(输入面友好)、授权配方进 forge(权限模型正道)—— 用户不再需要知道这些坑。
3. **闸门语义保持**:连通未全绿不供给、验收未全绿不交付,编排器逐级 fail-fast 并输出修正指引。

## 四、遗留(如实)

- `--smoke` 的自动裁决写死 recipe_propose 单参步;多参数整包冒烟沿同结构扩展即可(未做,当前用例无需)。
- 场景提示词深定制(逐角色 system prompt 级)依赖模板 promptVariables 面,本轮只做透传;模板自身的提示词优化属模板资产迭代,不在本轮。
- 模拟器/MES 进程周期退出(环境级)依旧,上轮的看门狗脚本(tmp-e2e/anneal-onboarding/sim-watchdog.cjs)仍是最优现场手段。

## 五、提交

- `scripts/onboarding/`:onboard.mjs(新)+ provision-line.mjs / forge-channel.mjs(增强)
- `skills/aw-line-onboarding/SKILL.md` + `.agents/skills/aw-line-onboarding/SKILL.md`(双副本同步)
- `docs/onboarding/标准产线开发文档-污水线.md` + 本报告 + `tmp-e2e/wwtp-onboarding/`
- 落袋台账:wwtp 线 `ln-0d5bfeac` · 配方 `rc-b45b9ada` · 频道 `344a6282`
