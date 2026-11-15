# 受保护线验收夹具（V6 非空基线）

> 目的：让 `verify-line.mjs` 的 V6 断言在 fresh home 中**非空、可失败**，而不是“没有保护线所以 0/0 恒真”。

## 步骤（隔离 home，admin token）

1. 在 `AW_HOME/data/dcw-lines.json` 预置产线 `ln-d7e0a2a2`（平台启动前写入，避免运行期直接改文件）：
   ```json
   {
     "id": "ln-d7e0a2a2",
     "name": "Protected Demo Line (acceptance fixture)",
     "color": "#ff6b6b",
     "description": "PROTECTED DEMO LINE - read-only acceptance redline",
     "controlMode": "manual",
     "simulated": true,
     "createdAt": "2026-11-15T16:29:34.447Z"
   }
   ```
2. 启动平台后，在受保护线上创建一个 mock DCW（示例）：
   ```http
   POST /api/workshop/dcw
   { "name":"protected-fixture-SP", "lineId":"ln-d7e0a2a2", "driver":"mock",
     "templateRef":"dcw-pressure-sp", "unit":"MPa", "min":0, "max":100,
     "stepLimit":1, "holdIntervalMs":0 }
   ```
3. 对该 DCW 写入一次 42，产生历史锚点（示例 `anc-5946458d`）：
   ```http
   POST /api/workshop/dcw/<dw-id>/write  { "value": 42 }
   ```
4. 运行 `verify-line.mjs`。V6 现在要求：
   - 受保护线运行前存在；
   - 运行后仍存在；
   - `protectedBeforeKeys.size > 0`；
   - 受保护线 journal 新增锚点 = 0。

## 本次结果

- 受保护线：`ln-d7e0a2a2`；夹具 DCW：`dw-2a97d525`；历史锚点：`anc-5946458d`；
- `verify-line-6.log`：25/25；V6=`受保护线存在=true->true 本线锚点=77 受保护线新增=0 基线=1`。

> 该夹具只用于隔离验收；不连接任何真实产线，也不代表真实受保护线配置。
