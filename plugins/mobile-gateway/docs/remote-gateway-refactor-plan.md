# Remote Gateway 重构实施计划

## 目标

在保持移动端 `dsh-mobile-v1`、配对流程和现有消息字段不变的前提下，移除对 DSH `APIProxy` 的依赖，改为只通过 Host 侧 `typertGateway` 访问 DSH v0.1.2-rc.1 Remote API。所有上游协议差异集中在插件内部适配层，后续 DSH 发生破坏性更新时不要求移动端同步升级。

## 稳定边界

- 对移动端：继续协商 `dsh-mobile-v1`，`hello.protocol` 保持 `3`，已有请求和响应帧保持兼容。
- 对 DSH：仅 `lib/dsh-host-adapter.mjs` 知道 Remote namespace、method、严格参数名、stream opening frame 和错误形态。
- 对业务编排：`lib/index.mjs` 只调用语义化 Host Adapter，不拼装 Remote 描述符。
- 对错误：上游带 `code/message` 的错误映射为既有移动端错误帧；未知异常稳定映射为 `internal`。
- 对历史：适配层把 RC 版压缩的 `chunkrow/*` 记录还原为 v1 已支持的 `assistant/chunk` 事件。

## 实施阶段

### 1. Host Adapter 与普通 RPC

- 封装 `invoke()` / `stream()`，校验关键返回值。
- 迁移 Session、Workspace、Settings、Commands、Skills、Agent Presets、LLM、Goals。
- Session 历史通过 `session.follow` 获取快照游标和 projections；旧页通过 `session.page` 读取。
- Workspace 列表通过 `workspace.follow` 的 baseline 获取。
- Host 信息由插件本地能力和 Remote catalog 合成，不再依赖已删除的 `host.describe`。

### 2. 实时与 Human-in-the-loop

- 普通实时会话事件继续使用 Host 内部 `session/event`，保持移动端事件帧不变。
- projection 更新从 `session.control` stream 转发，替代旧 `api.events.mux()` 中的投影帧。
- approval/question 改为 Cordis waterfall listener；生成插件自有不透明 `rpcId`，等待移动端回答。
- 只有存在匹配会话的已认证移动连接时才认领 waterfall；否则立即 `next()`，保留 WebUI 回退路径。
- 连接断开、请求 signal 取消或插件卸载时释放等待者并回退/取消，禁止悬挂 Promise。

### 3. 兼容性测试与门禁

- 使用假的 `typertGateway`，按 RC 的精确 namespace/method/args 测试，不再模拟 APIProxy。
- 添加 Host Adapter 单元测试，覆盖 direct value、throw、stream baseline、历史 chunk 展开和严格参数形状。
- 保留现有 WebSocket v1 端到端用例，验证移动端请求/响应字段没有改变。
- 增加静态门禁：生产代码不得出现 `apiProxy`、旧 `{ rpcId, payload }` Remote 调用或 `api.events.mux()`。

### 4. 配置与文档

- 删除 `apiProxy` 注入声明。
- 更新 README、PROTOCOL 和 bundle patch 注释，明确移动协议与 DSH Remote 的分层。
- 保留 `session-query-sqlite` 的按需搜索配置，但将其标记为可选能力，避免它成为插件启动前提。

## 验收标准

1. 插件可在 DSH v0.1.2-rc.1 组合中加载，且不请求 `apiProxy`。
2. 当前移动端无需修改即可完成配对、会话列表、历史、发送消息、命令、模型、设置、任务、Goal、文件和交互审批。
3. 全量测试通过；Remote 调用参数均由适配层测试锁定。
4. 上游 namespace 或数据结构未来变化时，改动范围原则上限定于 Host Adapter 及对应契约测试。

