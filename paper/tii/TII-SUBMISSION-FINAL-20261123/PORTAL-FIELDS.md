# IEEE Author Portal 字段粘贴稿

> 用途：在 IEEE Author Portal 提交 TII 稿件时，直接复制下面的英文，避免手打出错。
> 内容与 `TII-SUBMISSION-PACKAGE-FINAL-latex.pdf` 第 1 页逐字一致（2026-11-23 核对）。
> 这些字段只进门户表单，**不要**并入审稿 PDF。

## 文章类型

```
Regular Research Paper
```

## 上传的稿件文件

```
TII-SUBMISSION-PACKAGE-FINAL-latex.pdf
```

## Title

```
A Configuration-Driven Runtime for Integrating Industrial Agents With Online Data Acquisition and Governed Setpoint Operations
```

## Abstract（单段，220 词，纯文本）

```
Industrial agents that acquire process data and propose setpoint changes need an execution path that preserves production context, separates reading from writing, and distinguishes command acceptance from later process evidence. We present such a configuration-driven runtime. A production scene binds line, product, recipe, and run context to direction-specific acquisition and control mappings, registered protocol drivers, and configured write limits. Task-mediated and direct calls share a dispatcher that checks access; write handlers apply limits and revalidate approved requests as required by the route. Command outcomes and setpoint readbacks are kept separate from subsequent process measurements. In direct-interface probes of 55 writable endpoints across four simulated scenes and five protocols, all 220 prespecified admissible requests were accepted as expected, all 219 collected structurally out-of-range requests were rejected, and all 216 available simulator readbacks matched the requested values. These mapping probes used direct interfaces and did not exercise an agent harness. An injection-twin governed write changed the holding-pressure setpoint from 60 to 63.7 bar with matching simulated readback. In an exploratory comparison, the scripted policy had lower integrated absolute error than a no-write condition in all nine valid blocks of the selected batch; the batch-selection rule remains unresolved. Three language-model-driven episodes were canceled before reaching the target. These results characterize governed application-level behavior; a complete correlated agent-to-device trace and physical-plant performance remain unverified.
```

## Keywords（6 个，按稿件顺序）

```
Industrial agents, online data acquisition, agent-mediated control, governed setpoint writing, industrial communication, simulation-based evaluation
```

如门户要求逐个填写：

1. Industrial agents
2. online data acquisition
3. agent-mediated control
4. governed setpoint writing
5. industrial communication
6. simulation-based evaluation

## 稿件规模（门户或编辑部询问时使用）

| 项 | 值 |
|---|---|
| 页数 | 10（初投上限 10） |
| 图 | 6 |
| 表 | 4 |
| 算法 | 1 |
| 参考文献 | 24 |
| 摘要 | 单段 220 词 |
| 文件 | PDF，IEEE 双栏，US Letter，约 2.63 MB，字体全部嵌入 |

## Data availability（门户如有该字段）

```
Selected simulator records and run summaries are available on reasonable request; complete service snapshots, raw twin samples, and row-level server journals were not retained. No human participants, personal data, or physical-plant data were involved.
```

## Competing interests（门户如有该字段，作者核实后使用）

```
The authors declare no competing interests.
```
