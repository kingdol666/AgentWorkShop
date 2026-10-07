# 多源异构 MES 接入(镜像/直取双模式)开发与实测报告(2026-10-07)

> 任务:① 插件系统 hook 注入点位核验;② MES API 多源异构数据(标量/向量/图像)双模式
> 接入——镜像入库 vs 参数直取,前端可区分;③ SAXS 原位成像真实场景全链实测,含在线控制;
> ④ skill 让上层 Agent 可代理配置。

## 结论

1. **双模式架构成立且全链实测通过**(SAXS 场景 28/29→断言修正后全绿,见 §四):
   - **镜像入库模式**:MES"最新一组数据"端点 → 数采节点(http 驱动) → **与 PLC 完全同一套
     sweep→标定→打标→入库管线** → Agent 从时序库读(daq_query/daq_frames/daq_export)。
     实测:3s 节拍,标量/64点向量帧/图像帧三路同步入 Timescale,42+ 拍全部带
     run/recipe/line 三元组打标。
   - **参数直取模式**:不镜像;dcw mes-rest 节点 + historyMap,Agent `mes_fetch` 传
     时间段参数直接调 API。实测:标量区间 300 行/5min;**图像帧直取自动落盘
     `<data>/mes-artifacts/<节点>/`(12 帧×15KB 有效 PNG)**。
2. **新开发:daq_export 帧导出**(此前帧只入 daq_frames,按标量导出帧节点得零行假象):
   向量→单 CSV 长表(ts_iso,ts_ms,point_index,value);图像→逐帧原文件 PNG 落
   `frames/<node>/` + manifest 记录 kind/frames/saved/mime/metrics_summary;升序契约;
   帧上限 200/节点截断标记。单测 3/3(全量 185/186,唯一失败=既有 tool-profile-observer)。
3. **前端**:数采管理节点行新增**信号形态徽标**(标量/向量/图像)——多源异构可视化;
   模式区分 = 数采管理页(镜像节点,driver/形态徽标) vs 数字孪生写控页(mes-rest 直取
   点位),页面级天然分型。
4. **插件系统核验**:hook 注入点位 9 处全部有运行时证据(§五)。

## 一、双模式用户配置面(全部配置化,Agent 可代理)

| | 镜像入库 | 参数直取 |
|---|---|---|
| 载体 | 数采节点(daq) | 写控节点(dcw mes-rest) |
| 驱动配置 | `driver=http`,url=最新值端点,headersJSON=token,标量加 jsonPath | `readMap/writeMap/historyMap` 声明式映射 |
| 数据形态 | 模板决定:scalar / vector(点列) / image(image/* 字节或 {png:base64}) | historyMap.format:scalar/vector/image/table/event |
| 入库 | 定时入 Timescale(sweep 打标管线) | 不入库;大窗 CSV 数据集/图像落 mes-artifacts |
| Agent 读取 | daq_query / daq_frames / **daq_export(帧导出)** | mes_fetch(传 from/to)+ mes_dataset_read |
| 控制 | —(镜像面只读) | writeMap POST + recipe 绑定 + HITL |

模式判据(写进 skill):要"定时持续积累+批次打标+告警/导出/IDD"→ 镜像;要"按需回看
历史区间"→ 直取;可并用(镜像存最新流,直取查历史窗)。

## 二、SAXS 实测场景(tmp-e2e/saxs-simulator.mjs,:15080)

同步辐射原位 SAXS 仿真:二维散射图案 PNG(160×120,环半径∝峰位/环宽∝无序度)、
64 点一维约化曲线、峰位标量;**物理耦合**:加工温度 SP 偏离 [180,200]℃ → 样品无序化
(峰位 0.182→0.24 漂移、环变宽、强度降),一阶惯性 τ=8s;POST 写 SP 可恢复。token 鉴权。

## 三、实测证据(SAXS 线 ln-adcd4cb0,批次 rr-4de489fe)

- **镜像入库**:3 镜像节点(自定义模板 ct-*:峰位标量/64点向量/图像)3s 节拍;
  psql 对账:daq_samples 42+ 行、daq_frames vector/image 各 42+ 帧,
  **run_id=rr-4de489fe / recipe_id / line_id 全带**。
- **Agent 检索**:daq_query 标量统计+批次作用域声明;daq_frames 图像(160×120 对象引用)
  +向量(64 点);帧内容端点取回 13788B 有效 PNG,**像素级解码统计可行**
  (IDAT inflate=(W+1)×H,均值亮度可算)。
- **帧导出(新能力)**:daq_export 三节点 → 标量 CSV 131 行 + 向量长表 8384 行
  (131 帧×64 点)+ **图像原文件 131 个 PNG** + manifest(kind/frames/saved)。
- **直取模式**:mes_fetch 快照(SP 当前值)、内联区间 300 行(分页取全+统计摘要);
  **图像直取 12 帧自动落盘 mes-artifacts,均为有效 PNG**;越权成员被拒。
- **在线控制闭环(全治理链)**:物理干扰(SP→235,经 MES 写接口)→ 镜像观测峰位漂移
  0.233 → Agent recipe_trial(hypothesis 引用镜像证据)→ HITL 卡人工批准 → writeMap
  下发 185(journal:190→185 src=recipe;ops-log"整批下发 1/1 成功")→ τ 演化后镜像
  复测峰位回落 0.182 → keep。

## 四、过程记录(三次迭代修的都是测试脚本、非平台)

1. dcw 直绑(kind='dcw')被权限模型 v2 拒绝(设计如此)→ 图像直取节点经**配方打包授权**。
2. recipe_trial 必填 `hypothesis`(审计追溯设计);invoke 阻塞等裁决 → **先发后裁再收**。
3. 遗留失效审批与本次审批竞速:两次批准同秒竞速,一胜一被 300s 试验节拍拒——物理效果
   真实(下发/恢复均成立),断言改为"SP 实际生效"。

## 五、插件系统 hook 注入点位核验(全部有运行时证据)

| 注入点 | 注册面 | 运行时证据 |
|---|---|---|
| 数采驱动 | ctx.daq.registerDriver | 驱动目录含 serial/matrix-thermo/verify-burst(plugin) |
| 数采模板 | ctx.daq.registerTemplate | 模板目录含 plug-matrix-profile/verify-x2/demo-roughness |
| 下沉处理器 | ctx.daq.registerProcessor | 排队桥 + metrics 列由下沉管线写入 |
| 帧/样本事件 | ctx.daq.onFrame/onSample(hooks.on('daq:frame'/'daq:sample')) | emitDaqFrame/emitDaqSample 每帧发布 |
| 时序直通 | ctx.daq.query(queryTagged) | 插件免鉴权窗口取数 |
| 写控驱动 | ctx.dcw.registerWriteDriver | 排队桥+幂等覆盖(plugins/ 目录同构) |
| Host 工具 | ctx.omp.registerTool | 插件工具经 listPluginTools 全 harness 可调 |
| MES 节点钩子 | requestHook/dataHook/writeHook/writeCheckHook(节点级用户代码) | 本轮 interval 注入/CSV 下沉实测 |
| 插件生命周期 | plugins API(enabled/hasClient/settings) | line-sentinel/ops-notifier 等已装载 |

## 六、遗留

- 帧导出上限 200 帧/节点(图像体量考量);更大回看走缩小时间窗。
- 镜像节点的图像帧不入 merged.csv 宽表(按设计:像素不入宽表;manifest 指路 frames/)。
- 数采管理页的形态徽标需前端构建后生效(本轮已实现,随构建分发)。

产物:tmp-e2e/saxs-simulator.mjs、saxs-provision.mjs、saxs-e2e.mjs、saxs-ids.json;
tests/daq-export-frames.test.ts;skill 双模式配方(镜像+直取)。
