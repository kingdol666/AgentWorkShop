# 冻结证据输入（复审工作件，非运行结论）

- 远端 `main` 基线：`cf9dfab35684b53f1af43b54f924d2c183387bb0`；全新克隆，独立 detached checkout。
- 送审计划原始字节 SHA-256：`e6ff0adcca52202c3d379523dbabaa3268092ac90383e1c7d5538b653999e190`。
- 仓库内资料的哈希来自该 SHA 的 Git blob 内容，不散列 checkout 换行；本地资料按捕获原始字节散列。哈希只做版本对账，不代表来源或测量已被独立验证。
- 此处没有复制原始报告、对话、环境变量值、账号、实例配置、控制目标、运行状态或业务响应。

| ID | 路径（仓库相对；本地路径不作链接） | 环境或资料性质 | 可获取性 | SHA-256 |
|---|---|---|---|---|
| T01 | `docs/audit/2026-11-15-doc-to-simulated-plc-closed-loop-acceptance.md` | 历史模拟产线 | `tracked-historical` | `1cf25a9b4c9206348c0bbe53363421a73f2a186132744490bae51ed3a6a1bbbd` |
| T02 | `docs/audit/2026-11-16-line-integration-memory-tools-acceptance.md` | 历史产线工具/模拟 | `tracked-historical` | `d986ed92f4f27aaf53b4a10f122e1e7f658dc7d0b8c8f224a5ecb1d8e85ebda8` |
| T03 | `docs/audit/evidence/2026-11-18-idd-rag-plugin-v1-contract/REPORT.md` | 历史外部桥接与模拟端 | `tracked-historical` | `c74b9bf38ce05529bfb922b838652685b39a6ba6812102806e2fc0b03e26da36` |
| T04 | `docs/audit/2026-11-15-gap-closure-final-acceptance.md` | 历史加固报告，混合验证 | `tracked-historical` | `b3136336ca49fab5abd006df941232d4204f54fe1a439be04e7c65106401e99f` |
| T05 | `docs/audit/2026-11-16-round2-fixes-full-acceptance.md` | 历史回归，混合验证 | `tracked-historical` | `fe75a5b4d4198316e11a70794f161217d74674a84f3f4864d54db1d54ce2effe` |
| L01 | `docs/audit/evidence/2026-11-19-three-system-acceptance/phase-c-c2-readback.json` | 三端轮 / 影子孪生回读 | `historical-local / unavailable` | `0d54d078e7a4b2409c5a5ab089b67026822400e9acd831990916c77b0feaf2fd` |
| L02 | `docs/audit/evidence/2026-11-19-three-system-acceptance/phase-c-c2-journal.json` | 三端轮 / 影子孪生日志 | `historical-local / unavailable` | `3c0ebd5fe21db467b2a589ba44ea420cb9d3748bda46cf589d7368fc021d1f68` |
| L03 | `docs/audit/evidence/2026-11-19-three-system-acceptance/REPORT.md` | 三端轮 / 真实模型与隔离模拟联合记录 | `historical-local / unavailable` | `b18a798f5a875f19d0ee339364f9a7bda21488b072ba2a2a6223d1576861a481` |
| L04 | `docs/audit/evidence/2026-11-19-three-system-acceptance/final-verification.json` | 三端轮 / 选定口径，不是全矩阵 | `historical-local / unavailable` | `29ce1d84fe88c2490c2a4707b65076200518aea2a4e9cc1a7196b3cefe0e6087` |
| L05 | `docs/audit/evidence/2026-11-19-three-system-acceptance/model-provenance.json` | 三端轮 / 模型回合证据索引 | `historical-local / unavailable` | `3d493fe9ea6658b818ee1c4ccecab573bc590234422f97bcf35a198ac81c039b` |
| L06 | `docs/audit/evidence/2026-11-19-integrated-live-round/REPORT.md` | 集成轮 / 真实模型与隔离模拟联合记录 | `historical-local / unavailable` | `26bb05477dd39f9e1937edccb7adaeb1a28ee0691e907a774648476dcb12a5d0` |
| L07 | `docs/audit/evidence/2026-11-19-integrated-live-round/phase-c2-c5-reply.json` | 集成轮 / 模型回报，不能单独证明数据库范围 | `historical-local / unavailable` | `4ef015d1c14e56512fc27ad2555078b16db0eb4970908562dead27c2daa19623` |
| L08 | `docs/audit/evidence/2026-11-19-integrated-live-round/phase-c2-c4-candidates.json` | 集成轮 / 影子孪生经验候选 | `historical-local / unavailable` | `56c18eb00267ee6e147de6c78de7cb99ecef8efa2dc0f76feb5399bd0f7b0914` |
| L09 | `docs/audit/evidence/2026-11-19-integrated-live-round/phase-c2-c4-merge.json` | 集成轮 / 影子孪生候选合并回执，不等于独立复验 | `historical-local / unavailable` | `cd95e7f3fdbc5bfbf5f6f6190f5d419a58c1cbdcd85d7b00be040f4013ab66e8` |
| L10 | `docs/audit/evidence/2026-11-19-integrated-live-round/phase-s-settings-patch.json` | 集成轮 / 隔离配置的历史记录 | `historical-local / unavailable` | `d1992d8e731b631023ab09db5076ab542cbaa70ee7f1f4c149be7042f3759685` |
| L11 | `docs/audit/2026-11-19-system-completeness-final-report.md` | 历史完整度汇总，混合验证 | `historical-local / unavailable` | `8cdc56ab2a112570f1960d986ad52df8ace95a39e2d680f4ba46d09bb5853db1` |

本地原件须由持有人通过受权取证通道访问；不能经远端验收脚本自动读取或发布。近期历史 run 不支持把旧 `validated` 当复验，不支持把模拟设备结果填入物理准入，不支持把选定口径的通过推广到未完成任务。生产数据盘点、硬件验证、新前瞻效果实验均尚未执行；未知数量记 `null`，不记 `0`。
