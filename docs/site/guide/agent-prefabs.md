# AgentPrefab、Skills 与外部 MCP

AgentPrefab 把「角色/场景提示词 + 多维插槽 + 受支持模型配置 + 工具/Skill/MCP 能力选择」封装成可复用专家配置，并以不可变 revision 绑定到 Channel 成员。它只**缩小**能力范围，不授予平台、Project 或工业写权限。

## 1. 系统设置 › 技能管理

- **发现目录**：内置 `skills/`、平台受管 `<configRoot>/skills`、`~/.agent/skills`（兼容）、`~/.agents/skills`、`$XDG_CONFIG_HOME/agents/skills`，以及 `AW_SKILL_ROOTS` 显式追加目录。
- 发现只读取 `SKILL.md` 元数据；不执行 `scripts/`，不读取 `references/`/`assets/`。
- 导入会创建不可变受管副本（`<configRoot>/skills/<name>/<hash>/`），**默认未启用**；启用只影响后续 AgentPrefab 选择。
- `allowed-tools` 是实验性 metadata，不会授予工具权限。
- 同名 Skill 保留全部来源并提示冲突，不静默覆盖。

## 2. 系统设置 › 外部 MCP

- 只支持 **Streamable HTTP**，endpoint 必须为 `https://`，不能内联凭据或查询参数。
- 凭据引用必须是 `AW_MCP_*` 环境变量名；服务端从环境变量解析，文件/界面/日志不保存值。
- 「发现工具」只生成 **pending** 列表。管理员必须显式标记：
  - `dataSharing=shared-safe`（数据可安全共享给所有获准绑定成员）；
  - 工具 `classification=read`。
  只有两者同时满足才可批准；首版不开放写工具。
- endpoint、凭据引用/代际、协议、工具名或 schema 变化，以及超过 `maxDiscoveryAgeMs`，都会使批准回到 pending。
- 调用时由服务端 broker 再校验成员、Channel/Project、Prefab allowlist、schema 与数据域；拒绝时不会访问上游。
- 出站只允许 HTTPS 公网目标，解析后的私网/环回/保留地址一律拒绝；重定向只允许同源且逐跳复核；超时不自动重试。

## 3. 系统设置 › Agent 预制件

1. 点「新建预制件」，填写名称后创建草稿；在列表的操作列点「编辑」打开已有预制件。拥有者或管理员可保存、发布和移除，其他获准用户可查看公开预制件。
2. 编辑角色/场景提示词、插槽和模型配置，从能力目录选择工具、插件工具、Skill revision、MCP 工具。锁定的插槽使用发布版本的固定值，绑定时不能覆盖。
3. 保存草稿，再单独发布不可变 revision。发布不会改变任何现有绑定。未发布的草稿可以删除；已发布的预制件归档后不再供新绑定，已有成员及历史快照仍按原版本运行。
4. 在「绑定到 Channel 成员」选择 Channel、成员和已发布 revision。每个成员实例只能绑定一份；再次提交会遇到 `409 PREFAB_ALREADY_BOUND`，更换须先明确解绑。未绑定的成员使用原有 Agent 配置与平台权限，照常工作。

运行时有效能力 = Prefab 选择 ∩ 系统启用/审阅 ∩ Channel/Project 策略 ∩ 角色/工业门 ∩ harness 受管能力。平台基础协作/任务工具始终保留（仍受 Channel/Project 策略约束）。

## 4. 版本、克隆与重试

- 成员绑定固定 `(prefabId, revision, slotValues, contentHash)`；发布新版本不会自动升级既有绑定。
- Session 创建时固定成员 binding 与快照 hash；Session clone 复制同一 revision，不追最新版。
- Project task instance 首次创建时固定快照；同一工作项重试复用原快照；新工作项读取当时 Channel binding。
- 必需能力缺失、revision 缺失、绑定损坏或 slot 必填为空时，新作业 fail closed；不会回退 legacy 工具面。
- 普通 revision 更新等待安全空闲边界，不强停忙碌任务/HITL。管理员撤销工具/Skill/MCP 或停用成员后，下一次调用立即被拒。

## 5. 边界与已知限制

- 首发完整端到端路径以 **OMP** 验证；其他 harness 在能力注册表中逐步声明受管范围。缓存/原生工具是否完全受控取决于 adapter，不能由一次目录过滤推断。
- 受管 Skill 只通过 `activate_skill` 以低信任文本注入；不会执行 Skill 内脚本。
- OMP 与服务进程同账号运行：凭据不进 harness 配置/环境，但本功能不宣称 OS/文件系统沙箱，不防同权限下已失陷的 harness。
- 模拟器/影子孪生证据不是物理 HIL、现场准入或生产批准。
- 旧 MCP HTTP/REST/bridge 入口的授权差异已在本轮加固；新功能不改变既有工业 HITL/DCW 权威。

## 6. 验收证据（v0.15.0）

- 隔离全新实例实机验收 **21/21**（`scripts/experiments/prefab-acceptance.mjs`）：全新 `~/.agent/skills` 全局发现、导入默认未启用、启用、预制体草稿/发布、成员固定 revision 绑定、工具目录收窄且含 `activate_skill`、低信任 Skill 正文注入、越权调用拒绝、Session 克隆绑定与快照哈希、发布 revision 2 不自动升级、Skill 撤销即时拒绝、MCP 非 HTTPS 拒绝/清单无密钥/发现失败有界。
- 合并主干门禁：unit 2185/2186（1 条件跳过）、MCP 14/14、skills 197/0、docs 101/0、i18n 3439/3439、lint/typecheck/build 全绿。
- 未验证项：公网 HTTPS 外部 MCP 正向联通、Prefab 约束下真实 OMP 模型作业、浏览器 UI 点击验收。见[全流程验收报告](https://github.com/kingdol666/AgentWorkShop/blob/main/docs/audit/evidence/2026-11-21-fullflow-round/REPORT.md)。
