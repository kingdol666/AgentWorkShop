# AML 平台数据目录

本目录是 AgentWorkShop 自动建模(AML)平台的**全部资产根**,由服务自动创建与维护。

## 目录约定

| 路径 | 内容 | 可否手删 |
| --- | --- | --- |
| `.venv/` | uv 创建/管理的 Python 环境(依赖锁定在平台的 requirements.txt) | 可删,下次供给自动重建 |
| `datasets/<id>/` | 数据集实体:`spec.json` 取数规格、`manifest.json` 列定义、`report.json` 质量报告、`arrays/*.f32` 列式数组 | 先删元数据行,再删目录 |
| `jobs/<id>/` | 训练作业实体:`job.json` 提交契约、`workspace/`(train.py + amlkit.py)、`run.log`、`artifacts/`(产出模型) | 同上 |
| `models/<id>/` | 模型实体:`model.onnx` + `io_spec.json`(输入输出契约,不可变) | 同上 |
| `runtime/` | 平台运行时状态:uv 安装记录(`uv.json`)、环境探针快照(`env.json`) | 可删,自动重建 |
| `tools/` | 平台自动安装的 uv 二进制(免管理员、不改系统 PATH) | 可删,可重新一键安装 |

## 元数据与实体的关系

平台用 SQLite 四表保存**元数据**(数据集/作业/实验/模型),用本目录保存**实体**。
两者以 id 一一对应;REST 的 `/api/workshop/aml/*` 提供元数据 CRUD,
删除元数据时同步清理对应实体目录(有引用的数据集会被拒绝删除)。

## 迁移到别的机器

整个 `aml/` 目录可直接拷贝(含 `.venv` 与模型工件);目标机若无同版本 Python,
删掉 `.venv/` 让平台按本机解释器重建即可 —— 数据集与模型工件不受影响。
