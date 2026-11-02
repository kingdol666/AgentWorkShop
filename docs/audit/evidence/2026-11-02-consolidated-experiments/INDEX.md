# 实验与验收结果总索引(2026-11-02 收敛)

**用途**:一份文件回答"哪些是最新有效结果、哪些进了论文补充材料、哪些已归档"。

---

## 1. 论文补充材料(S7,权威包)

`paper/tii/SUBMISSION-IEEE-TII/Supplementary-File-S7-data-2026-11-02.zip`(68 条目,60 文件,~248 KB)

| 目录 | 内容 | 是否用于论文 |
| --- | --- | --- |
| `01-paper-evidence/` | 2026-11-01 最终批次:双跑 77/0/0、E1 探针、10 份 C0/C1 CSV、四臂/五层消融、审批/授权、图与 HTML 报告 | **是**(论文所有数字) |
| `02-c3-pilot-negative/` | 2026-11-02 C3 活体 Agent 4 次 pilot(0 写/超时/工具缺失)、fail-closed 假 PASS 证据、流水线缺陷报告 | **否**(仅作完整性说明) |
| `03-system-validation-not-used/` | 五层验收 + 实机演示报告 | **否**(平台验证,非论文实验块) |
| `manifest.json` | 每个文件的 SHA-256/大小 | — |

S7 正文已更新为 2026-11-02 版(`Supplementary-File-S7.tex/pdf`,4 页),明确 C3 负结果不进入任何主张。

**论文可用数字(与 01 逐项一致)**:
- 集成流水线 77/0/0 ×2(commit `da627d21`,`agentHarness=(none)`);
- E1:220/220 受理、219/219 结构拒绝、216/216 回读(4 场景子集);
- E2:C0 **0/15** vs C1 **15/15**;C1 150.41–172.90 s/seed;12/17、56/59、41/50 写/轮;
- E4:full 18/18 拒、0/6 越窗;no-interlock 12/18、6/6;legal 9/9、boundary 9/9;P 态五层各自拒绝;
- E3:manual 202→204.8 / 216→216;auto 202→204.8 / 216→218.8;授权三用例全按预期。

## 2. 2026-11-02 负结果(不得写入阳性主张)

- C3 活体 Agent:4 次尝试;最好一次 15 min 完成取证但 **0 次受治理写入**,`BUDGET_TIMEOUT`,PV 31.23 g 未入带;
  另一次 0 写被平台隐式 `COMPLETED`(goalCriteria 未校验)。
- 平台阻塞:D3 lead 队列续消费、D4 task artifact 协议、D6 goal 收口校验。
- 详见 `docs/audit/evidence/2026-11-02-experiment-pipeline-v2/REPORT.md`。

## 3. 系统验证(不进论文实验块)

| 报告 | 内容 |
| --- | --- |
| `docs/audit/evidence/2026-11-02-prod-acceptance/REPORT.md` | 五层验收:T0/T1 全绿,T2 四套全绿(线治理 44、本体 57/87、优化器 105),T3 三套全绿;模型闭环 51/53(既有 E-3);HITL 26/28(TUI 时序) |
| `docs/audit/evidence/2026-11-02-live-demo-rerun/REPORT.md` | F-1/F-3 修复后实机:群聊答复、OPC 63 bar 写穿→克重入窗、停/开线 11 参 readback-verified |
| `docs/audit/evidence/2026-11-02-paper-evidence-audit/REPORT.md` | 论文数字与 S7 逐项对账(通过) |

## 4. 清理记录(2026-11-02)

- **提交目录**:旧 S3/S6、10-27 证据、`build-*`、`qa*`、`revision-*`、`reviews`、旧 `figure-options-*`、根级 build/QA 截图、旧 source-package zip、旧 S7 4 文件包 → 全部移到
  `paper/tii/_archive-submission-2026-11-02/`(约 466 MB;可回溯,不删除);
- **提交目录保留**:`main.tex/pdf`、`sections/`、`resources/`、S7 新包、论文过程文档、当前 11-02 图工作目录;
- **FILE-MANIFEST.json**:重生成(revision 2026-11-02,176 文件,含 S7 sha256);
- **bench/results**:仅保留 2026-11-01 最终批 + 2026-11-02 C3 负结果;无效假 PASS 运行移到
  `docs/audit/evidence/2026-11-02-experiment-pipeline-v2/invalid-false-pass-run/`;新增 `bench/results/README.md` 索引。

## 5. 复现入口

- 论文批次:`bench/PIPELINE/EXPERIMENT-RUNBOOK.md`(S0–S7);
- 实验合同:`bench/PIPELINE/EXPERIMENT-PIPELINE.md`(E1–E5,含 C3 协议);
- C3:`node bench/experiment/agent-multiround.mjs --scenarios injection --runs 5 --budget 30`;
- 假 PASS 防护:探针/优化 runner 已 fail-closed(未知场景/零分母直接退出)。

## 6. 一句话

**论文只能引用 S7 的 `01-paper-evidence/`;`02/03` 是诚实归档,不是结果。**
