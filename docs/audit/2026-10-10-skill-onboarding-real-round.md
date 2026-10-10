# skill 产线接入真实投用轮报告(2026-10-10)

> 用户命题:①生产形态完整实测(零系统代码改动)——PLC 节点连接、MES API、Channel 数采、recipe 下发;②审阅 aw-line-onboarding skill 设计,验证「用户给文档 → skill 流程自动建线建频道 → 投入使用 → 完成任务」全路径。
> 方法:撰写《标准产线开发文档》(docs/onboarding/标准产线开发文档-连续退火线.md)作为用户输入面,严格按 skill 五阶段执行,全部操作走 skill 自带脚本(scripts/onboarding/)与 Agent 工具桥。

## 一、结论

**skill 全流程真实走通:五阶段合计 78 断言全绿 + 真实作业腿 9/9 = 87 断言零系统代码改动全绿。** 连续退火线(全新产线,anneal-line 预设增量共存)从一份开发文档出发,全自动完成:接入(5 协议族 19 点)→ 供给(线/节点/上下限/配方)→ 频道锻造(hitl_governed 闭环优化频道)→ V1-V6 验收 → 投用(MES 直取 1800 行取数 + 闭环步 HITL 下发读回一致)。

## 二、执行轨迹(全部按 skill 阶段)

| 阶段 | 脚本/动作 | 结果 |
|---|---|---|
| 0 连接检查 | 服务 :3001 健康;模拟器 :4010 / MES :15060 复活(本机模拟器进程周期退出,见 §四) | ✅ |
| 1 点位提取 | 设备 export 逐字段采集(anneal-exports.json:5 设备 19 点,5 协议族)→ 生成配置 JSON | ✅ 20 节点(9 DCW+11 DAQ) |
| 2 连通性预检 | test-connection.mjs(逐驱动 test-driver) | ✅ **8/8**(modbus 读 690℃/opcua 140m/min/rtu 400℃/mqtt 露点-42.4/http 134HV) |
| 3 产线供给 | provision-line.mjs(指纹幂等;量程/stepLimit/holdIntervalMs 显式) | ✅ **24/24**(线 ln-c67805a6,9 DCW+11 DAQ,产品/配方 rc-ef67af4e,批次 rr-d4ef706d 开跑) |
| 4 频道锻造 | forge-channel.mjs(scenario=optimize,chtpl-generic-optimize-default,hitl_governed,插件 idd+rag,绑定矩阵=工艺工程师 recipe manual + 分析师 daq auto) | ✅ **15/15**(频道 38a29212,种子任务 6ec4e996 派发) |
| 5 验收 | verify-line.mjs V1-V6 | ✅ **31/31**(11 节点数采落库/7 写控越界必拒+合法写回环/配方 7 参数映射/频道绑定/受保护线零扰动) |
| 投用 | 真实作业腿 real-task.mjs(Agent 工具桥) | ✅ **9/9**(见 §三) |

**合计 87 断言全绿。**

## 三、真实作业腿(9/9)

执行者 = 新频道内持配方绑定的 **工艺工程师**(Agent 工具桥直调,与自主作业同语义):

- **J0 基线固化**:文档基线(745/120)与设备现况(757/128)脱节时,**提案权被限界预检正确拒绝** —— 改由 Agent recipe_update 快照现况(757/762/760/128/410/65/9)→ 人工批准固化 v2(治理正确性实证)。
- **J2/J3 MES 直取**:mes_fetch 30 分钟窗 → **1800 行/点完整历史**(温度 mean 212.0℃ std 0.94;压力 mean 8.41 MPa std 0.14),分页/统计/采样齐全,零失败点。
- **J4-J6 闭环步**:线速 128→132→136→144 逐轮提案 → **治理窗拦截如实**(60s 锚/300s 节拍 166s/198s 等待重提)→ HITL 人工批准 → **整批下发全部设备证实**(readback 一致)→ runId 回执(rr-4d11b7f3 / rr-979707de 等)→ 设备读回=下发值。
- **J6/J7 读面分离**:数采查询走**数据分析师**(auto 绑定)—— 工艺工程师查数被权限模型正确拒绝(fail-closed 实证)。
- **J8 种子任务自主推进**:频道种子任务在册,lead 已自主派生「第一/第二观察窗」子任务(baseline→观察→寻优循环运转中)。

## 四、环境级发现(如实)

1. **模拟器/MES 进程周期性静默退出(本机老毛病,本轮 PLC 侧 4 次、MES 侧 1 次)**:日志无致命堆栈,进程整体消失。处置:分离式启动器 + **看门狗**(tmp-e2e/anneal-onboarding/sim-watchdog.cjs,20s 探活双护 PLC+MES,自动重启+boot 设备)。建议后续 P2:模拟器自身加 watchdog 模式或文档化服务化封装。
2. **单实例锁**:锁被占时新实例启动即自杀(上轮已录),本轮未复发。
3. 工艺工程师实例出现一次 enabled=0(停用)**无审计留痕**(P3):来源未明(疑似频道自主运营路径),已手工恢复并留痕;建议 P3:成员启停补审计。

## 五、skill 设计评审结论

**总体:设计成立且好用** —— 分工铁律(助手读文档/生成 driverConfig,脚本只吃配置 JSON)在实践中完全成立;五阶段闸门(连通未全绿不供给、V1-V6 未全绿不交付)两次真实拦住错误(连通 9/9 全挂时停下修环境;预检限界拒绝脱节基线)。契约坑章节价值极高(本轮三次被救)。

**本轮实证补入 skill 的契约坑(已回填双语位副本 .agents/skills 与 skills/)**:

1. historyMap/readMap/writeMap 必须是 **JSON 字符串**(传对象 → "[object Object]" 解析失败)。
2. history-only mes 节点的可见面授权 = **授权配方**(kind='dcw' 绑定已废弃;mes_fetch 可见面 = dcw 存量绑定 ∪ 绑定配方参数节点)。
3. **节点视图的 secretRef 是打码值**("******"):按视图回写 driverConfig 会覆盖真实 secretRef(401);PATCH 必须显式给真值。
4. secretRef→env 键 = `AW_MES_<REF 大写折叠>_TOKEN`,经 start.mjs 预载 .env 注入。
5. mes-test-read 只覆盖 readMap 面;historyMap-only 节点的连通验收走真实 mes_fetch。
6. mes_fetch 参数是 from/to(ISO),非 from_ms/to_ms;无窗 → 落当前值快照。
7. Agent 工具的节点引用一律用**节点 id**(传名报「节点已删除」误导错)。

**建议(skill 改进项,未在本轮实施,留待确认)**:
- P2:provision-line 对 mes-rest 节点的 historyMap 自动 JSON 字符串化(输入面接受对象,脚本内转换),消灭最常见的编码坑。
- P2:平台侧 mes_fetch 可见面增加 kind='mes' 读绑定(解耦"取数授权"与"配方参数"),或在文档明示授权配方模式。
- P3:secretRef 视图打码的同时,PATCH 端点应忽略掩码值(与密码字段同法)。
- P3:成员实例 enabled 翻转补审计。

## 六、产物与提交

- 标准产线开发文档:`docs/onboarding/标准产线开发文档-连续退火线.md`(标准模板 + anneal 实例)
- 接入配置与脚本:`tmp-e2e/anneal-onboarding/`(gen-configs/conn/provision/forge/verify/real-task/sim-watchdog + 各结果留痕)
- skill 增补:`.agents/skills/aw-line-onboarding/SKILL.md` + `skills/aw-line-onboarding/SKILL.md`(双副本同步)
- 报告:本文件
- 落袋 id:线 `ln-c67805a6` · 基线配方 `rc-ef67af4e`(v2)· 授权配方 `rc-fa543591` · 频道 `38a29212`
