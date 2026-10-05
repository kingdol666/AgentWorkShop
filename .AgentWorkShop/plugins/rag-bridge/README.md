# rag-bridge —— rag-knowledge 知识库桥接

把本地 [rag-knowledge](https://github.com/kingdol666) 服务集成为 AgentWorkShop 的团队知识库:
启动即确保 `aw-industrial` 知识库存在,向 Agent 注入 `kb_agent`(唯一入口,检索/入库/经验/图谱全部由知识库内部 Agent 处理)与 `kb_agent_status`。

## 三步接线(首次部署必读)

1. **启动两个组件**:FastAPI 后端(端口以 `backend/config.yml server.backend_port` 为准,缺省 8770;`cd backend && uv run python main.py`)与 Nuxt Web(缺省 6789);
2. **签发 API Token**:服务端 `server.auth.enabled: true` 时——`POST /api/v1/auth/register`(注意 **v1** 路径;首个用户自动 admin)→ `POST /api/v1/auth/login` 取 session token → `POST /api/v1/auth/tokens` 签发 `sk-` 前缀 token(read+write,明文仅返回一次);
3. **填插件 settings**:平台设置页「rag-knowledge 连接/鉴权」→ base_url(后端)+ web_url + token,保存即热生效(或 `PATCH /api/system/settings {"override":{"plugins.rag-bridge.token":"sk-..."}}`)。

## 用法

- **检索问答**(sync):`kb_agent {prompt:"检索 aw-industrial:...", mode:"sync"}` —— 知识库侧走 QDCVR 全流程,返回带引用与可信分级的答案;
- **文档入库**(async):`kb_agent {prompt:"入库到 aw-industrial。标题:...;正文(markdown):...", mode:"async"}` → `kb_agent_status {task_id}` 取结果(内部走 A0 去重→解析→标签→向量→图谱→A7 八项终检);
- **运维探查**:插件 API `/health`、`/search`、`/experience`。

## 搭配

分析结论入库约定:标题带工况场景(regime_key),如 `【演示线1|挤出主机PLC|稳态+SP阶跃窗】...`。
与 idd-closedloop-bridge 组成「数采→IDD 哨兵分析→结论入库→检索」全链。
