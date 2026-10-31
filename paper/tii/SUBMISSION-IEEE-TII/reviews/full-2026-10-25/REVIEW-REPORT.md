# IEEE TII 模拟审稿报告

**稿件：** *AgentWorkShop: A Modular Task-to-Device Integration Framework for Industrial Agents*  
**审查版本：** `main.pdf`，10 页；SHA-256 `195DBCDCFF6758811BB48FD30E8D1282D8866E854B0B1EAA306A3CF0C433AE11`  
**模式：** Full, five-seat, role-separated review; `NOT_CALIBRATED`  
**结论：** **Major Revision（大修）**。这是按审稿契约生成的模拟意见，不是 IEEE TII 的正式决定，也不是五名真实人类审稿人的意见。

## 总体判断

稿件的整体框架易辨认：引言提出工业智能体任务与设备接口之间的集成问题，相关工作定位邻近架构，第三章给出设计约束、系统架构和执行流程，第四章说明模块职责，第五章分开报告历史过程响应、当前路由集成和软件契约测试，最后讨论证据边界。Fig. 1 与 Fig. 2 分页呈现；检查的页面未见裁切或明显的图文碰撞。系统对命令回执、readback 和后续过程观测的区分也清楚。

目前的主要审稿风险不是“读不懂架构”，而是**这项实现相对于相近工业智能体/工厂集成工作的增量和重要性尚未充分建立**。实验谨慎地证明了特定配置下的路由与记录链路，也明确承认没有证明过程改善、跨部署可移植性或平台优势；但因此还需要更直接地解释这项软件集成契约为什么构成足够独特且有意义的 TII 贡献。

## 审稿契约结果

```text
dimension_verdicts: [D1=warn, D2=warn, D3=pass, D4=warn, D5=warn, D6=block]
fired_conditions: [F1=false, F2=true, F3=true, F4=false, F5=true, F0=false]
da_critical_adjudications: []
editorial_decision=major_revision
```

D6 的可修复阻塞触发大修；D1、D2 和 D6 也使 F3 成立。没有 fatal block，反方审稿席没有提交 CRITICAL 或 MAJOR 项。当前没有作者确认的 TII 目标标准绑定清单，因此 D6 是基于用户指定的 TII 目标及公开指南所作的审稿判断，不能视为绑定标准的正式合规认证。

## 必须处理的审稿意见

1. **建立或收窄贡献。** Table I 已比较邻近工作，但目前仍未清楚展示 AgentWorkShop 的功能组合相对最近架构的具体增量，也没有实验证据说明共享 operation handler 等设计带来何种超出该实现案例的意义。补充基于原文证据的逐项差异分析和能支持增量的证据；若没有这类证据，应将贡献和标题/摘要进一步限定为所报告实现的案例研究。

2. **补足运行记录的可追溯信息。** 实验章使用“archived seed-42 campaign”和“local v0.8.0”，但正文未给出历史构建/源码修订、归档数据标识或可复现的测试输入和断言输出位置。为报告的运行补充稳定版本/归档标识及复现说明；如果不能公开完整产物，至少给出固定状态、测试向量和期望结果，使读者能审计表格中的计数。

3. **消除摘要中样本结果的范围歧义。** 摘要的“All reported samples remained outside target bands”紧接当前版本路由测试，但第五章前半又报告四个历史场景的终端值均在目标带内。应明确摘要说的是“当前版本路由样本”，以免读者将其理解为整篇文章所有样本。

## 其他需要修正或说明的内容

- **移除未解释的内部测试编号。** `R20`、`R21`、`R22` 仍出现在 Fig. 1 图注以及系统/模块/机制说明中。它们是内部运行编号，不是审稿人可理解的系统概念。改成“direct REST check”“test-runner follow-up probe”等描述性名称，或集中定义；尤其不要让图注承担内部证据包导航功能。
- **说明历史四场景曲线在论文中的作用，或压缩该部分。** 文中已区分 seed-42 历史轨迹与当前版本路由测试，并指出两者不是前后对照；但历史场景对 task-to-device 集成主张的作用仍需说得更直接。
- **修正局部语法。** §IV-G 的 “An recipe_trial call” 应改为语法正确且读者能识别为代码接口的表述，例如 “A `recipe_trial` call”。
- **统一摘要术语。** 摘要约 157 词，低于 IEEE Author Center 的 250 词上限；但 `OMP` 与 `CLI` 未在摘要中展开。建议在摘要中改成描述性名称，或按期刊要求处理缩写。

## 实验章节评估

实验章节的叙述顺序总体清楚：先说明历史多场景任务的目标偏差定义和设定值变化，再报告当前 v0.8.0 路由集成测试，最后报告软件契约与上下文保护测试。不同证据类型没有被包装成同一组对照结果。图中历史曲线使用归一化目标偏差而不是内部优化器分数，并明确说明没有跨场景统一的逐轮 (J)；这一处理诚实且可解释。

方法审稿席认为，确定性软件集成测试不需要为了形式而增加推断统计；真正的问题是运行来源和复现路径不够明确。当前路由测试每场景复用一个模拟器，OMP 任务顺序执行且每项任务只有一个采样点；Pi 是本地 fixture，审批为 synthetic，MQTT/Timescale 不可用时通过 SQLite fallback 查样本。因此，这些数据只支持指定路由下的记录关联和软件契约检查，不支持过程改善、跨场景收敛或真实在线 DAQ 效果。论文大体已作此限定，摘要的范围表述需与之保持一致。

## TII 投稿格式与图表检查

- 当前 PDF 是 IEEE 双栏 US Letter，共 **10 页**；符合 TII 官方清单列出的新研究稿件 10 页上限和双盲匿名稿要求。检查到无作者姓名，但 PDF 仍含 Acknowledgment。
- Fig. 1、Fig. 2 位于不同页，四个在用图形均无文字碰撞或裁切。Fig. 1、Fig. 2、Fig. 4 使用 9 pt Arial；Fig. 5 使用 5.9、7.0、7.5 和 8.5 pt 字体，并混用 Arial 与 DejaVu Sans。IEEE 对图中文字的建议约为 9–10 pt，属于建议值而非硬性页数规则；建议放大 Fig. 5 文字并统一字体，特别检查 5.9 pt 标记在实际打印尺寸下是否易读。矢量 PDF 图形格式本身符合 IEEE 接受格式。
- **双盲与 AI 使用披露存在需要作者确认的冲突。** 当前 PDF 在致谢中披露了 ChatGPT 和图像生成的使用；IEEE AI 政策要求在 Acknowledgments 中披露 AI 生成的文字、图、图像或代码，但 TII 双盲投稿清单又要求匿名稿不包含 acknowledgments。提交前应按当前 TII portal 的指示向编辑部确认如何处理匿名评审稿与 AI 使用披露；不要在未经确认时把带有该致谢的版本当作满足双盲检查的最终稿，也不要悄然永久删除 AI 披露。
- `tools/audit.py` 通过：10 页、US Letter、31 个引用键解析成功、图形路径完整。LaTeX 日志有若干 Underfull \\hbox/\\vbox 提示，没有 Overfull 提示；抽查页面未见明显异常词距或非末页大块空白。参考文献中有 1 项未被正文引用，建议确认是否应删除或补引。

公开指南： [TII 投稿清单](https://www.ieee-ies.org/pubs/jestie/17-publications/tii), [IEEE 文章结构指南](https://journals.ieeeauthorcenter.ieee.org/create-your-ieee-journal-article/create-the-text-of-your-article/structure-your-article/), [IEEE AI 生成内容政策](https://journals.ieeeauthorcenter.ieee.org/become-an-ieee-journal-author/publishing-ethics/guidelines-and-policies/submission-and-peer-review-policies/), [IEEE 图形尺寸与分辨率指南](https://journals.ieeeauthorcenter.ieee.org/create-your-ieee-journal-article/create-graphics-for-your-article/resolution-and-size/).

## 修订路线图

以下顺序用于追溯原始审稿项，不表示工作优先级。

### 必须修订

| Ref | 内容与验收标准 | 来源 |
|---|---|---|
| R1 | 通过直接、证据化的功能差异比较建立贡献；或将贡献收窄为所测实现案例，并同步修改主张。 | Journal-Fit W3 |
| R2 | 提供历史版本、归档运行和当前测试的稳定标识及可复现输入/输出或测试向量。 | Methodology W1 |
| R3 | 把摘要中的样本范围明确限定为当前版本路由样本。 | Domain W1 |

### 建议修订

| Ref | 内容与验收标准 | 来源 |
|---|---|---|
| S1 | 解释历史多场景轨迹与本研究集成贡献的关系，或压缩这一部分。 | Journal-Fit W1 |
| S2 | 修正 `An recipe_trial call` 的冠词/代码接口写法。 | Journal-Fit W2 |
| S3 | 将 `R20`、`R21`、`R22` 等内部编号改成描述性文字或集中定义。 | Perspective W1 |

## 面板报告索引

Phase 1 paper-blind 预承诺和五张 Phase 2 审稿卡、契约及版本信息均与本报告分开保存于本目录。审稿角色互相不可见对方意见；工具未提供可验证的实际模型/provider/人类评审身份，因此不能宣称审稿错误过程独立。技能目录未安装其文档提及的自动 sprint-conformance 检查脚本，结构、触发语句与锚点按现有规范人工核对。
