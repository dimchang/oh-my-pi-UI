# OMP-UI 对 omp v18.0.1 → v18.1.21 升级的影响分析

> 基线：内置 `resources/omp.exe` = **omp/17.0.6**；系统 PATH omp = **18.1.21**（2026-09-14）。
> `electron-builder.yml` 无 `extraResources` → 打包版不携带内置 exe，UI 实际使用用户机外部 omp。
> 所有"实测"结论均来自对两个版本 exe 的 RPC 探针（脚本在 `.temp/probe/`，可复跑）。

---

## 一、破坏性变更是否影响现有功能

### 1.1 RPC 命令面：兼容，无命令被删除

v17.0.6 → v18.1.21 的 RPC 命令集合只**新增**（`negotiate_protocol`、`get_messages_page`、`set_fast_mode`），未删除任何命令；UI 在用的 15 个命令（`prompt`/`steer`/`follow_up`/`set_model`/`switch_session`/`branch`/`export_html`/`get_session_stats`/`get_state`/`get_messages`/`login` 等）请求/响应形状不变。会话 JSONL 格式（`~/.omp/agent/sessions/*/*.jsonl`，`CURRENT_SESSION_VERSION = 3`）与 `type:'custom'` 行结构两版本一致 → UI 的读盘回放不受影响。

**结论：UI 的主链路不会被 18.x 破坏。** 真正的问题在下面三处。

### 1.2 实测受影响点（按严重度排序）

| # | 影响 | 证据（实测） | 涉及 UI 位置 |
|---|------|-------------|-------------|
| 1 | **v1 传输上限击穿模型目录**：18.1.21 默认配置下 `get_available_models` 响应 = 1,219,906 字节 > 1 MiB 帧上限 → v1 模式返回 `success=false, error="RPC response exceeded the transport limit", models=0` | 探针 `.temp/probe/v1-large.mjs`（系统 omp 18.1.21） | `electron/omp-process.ts:276-292` 帧泵只做 readline+JSON.parse，**无 `rpc_chunk` 重组**；UI 走 `available-models.ts` 预设回退 → 模型列表降级为预设 |
| 2 | **`agent_end` 语义变化（18.x 新增 `isTerminal`）**：17.0.6 的 agent_end keys = `{type,messages}`；18.x = `{type,messages,isTerminal}`。源码（v18.1.21 agent-session.ts）：`isTerminal: !options?.willContinue`，且排队续轮（queuedContinuation/ircContinuation）时发 `isTerminal:false` 后自动续跑 | 探针 `.temp/probe/final18.mjs` + 源码比对 | `store.ts:1102-1106` 把每次 agent_end 一律当轮次结束（`procStreaming=false`），不读 `isTerminal` → 自动续轮时 UI 提前解锁输入框/停止按钮，状态短暂错乱（排队消息场景未能在探针里复现到 `false` 帧，判定 `[INFERENCE]`，源自码为直接证据） |
| 3 | **外部技能目录 opt-in（18.1.5+）**：`~/.claude`、`~/.codex` 等用户级配置源改为 `enabledProviders` opt-in；`skills.enableClaudeUser`/`enableCodexUser` 默认 true→false | settings-schema 对比（17.0.6/18.0.4 = true，18.1.21 = false） | `electron/omp-skills.ts` 无条件扫描 `~/.claude/skills` 等 → 技能面板显示"已安装"，但 18.1.5+ 的 omp 不加载 → 面板与实际能力漂移 |

### 1.3 既有契约不匹配（与版本无关，18.x 下同样成立，实测确认）

| # | 缺陷 | 实测证据 |
|---|------|---------|
| A | **`get_state.todoPhases` 形状不匹配**：omp 实际返回 `[{name, tasks:[{content,status}]}]`（17.0.6 与 18.x 一致），UI 类型声明 `TodoPhase = {phase, items}`（`shared/rpc-types.ts:413`），`App.tsx:64` 原样透传 → `TodoPanel.tsx` 读 `phase.phase`/`phase.items` 全为 undefined → 面板显示空白 phase + "0 项" | 探针 `.temp/probe/todo-shape.mjs`：`get_state todoPhases = [{"name":"P","tasks":[...]}]` |
| B | **`todo_reminder` 帧载荷不匹配**：实际载荷 `{todos:[{content,status}], attempt, maxAttempts}`（扁平列表，两版本一致）；UI 读 `frame.todoPhases ?? frame.phases`（`store.ts:1302`）→ 恒为 undefined → 处理器是 no-op | 探针 `.temp/probe/rem17b.mjs` / `final18.mjs` |
| C | **`set_todos`/`login` 字段名错误但当前是死代码**：omp 要求 `phases`/`providerId`；UI 发 `{todos}`/`{provider}`（`rpc-client.ts:57,62`）→ 实测报错（`undefined is not an object (evaluating 'A.map')` / `Unknown OAuth provider: undefined`）。grep 确认**两者在 UI 中均无调用者** → 潜伏地雷，接线即炸 | 探针 + grep |
| D | **hashline diff 渲染缺失**：omp edit 工具的 `details.diff` 是 hashline 格式（` 382|…` / `-383|…` / `+383|…`，真实会话取证）。`DiffView.tsx` 的 `looksLikeDiff` 要求 `@@`/`---`/`+且-` → **纯新增** hashline diff 返回 null（vitest 探针实测）；含删除行时能取出文本但渲染只按 `@@`/`+`/`-` 前缀着色，行号语义丢失 | `npx vitest run` 探针用例（已删）；真实会话 `20260911*/20260914*` 的 `toolResult.details` |

### 1.4 明确不受影响的破坏性变更（grep 证实无引用）

- `inspect_image` 移除（UI 只传 `prompt.images`）；`designer`/`librarian` agent 移除；Ruby/Julia `eval` 与 `parallel()`/`pipeline()` 移除；`/rewind`→`/branch`（UI 用的是 `branch` RPC 命令，形状不变）；`yield` 签名变化；`task.isolation.mode` 拆分；`tui.*` 设置移除；`--hook` 别名化（UI 生成的 wrapper 与 extension 工厂签名兼容）；浏览器/computer 工具重写（UI 无相关面）。
- CLI 参数：`--mode rpc-ui`、`--approval-mode`、`--append-system-prompt`、`-c`/`-r`、`--no-session` 在 18.1.21 全部保留（逐版核对 args.ts）。

---

## 二、新增功能与修复：是否比现有实现更好

| omp 18.x 方案 | UI 现状 | 判定 |
|--------------|---------|------|
| **协议 v2 分块传输**（`negotiate_protocol` → `rpc_chunk`，1 MiB 物理帧 / 64 MiB 逻辑重组）。实测：协商后同一 1.22 MB 响应正常分成 5 块送达，`count=5, byteLength=1219906` 完全匹配 | `AddModelModal.tsx` + `available-models.ts`：把 discovery 模型**写死进 models.yml**（还会删掉 `discovery` 键，永久关闭该供应商的自动发现）+ 前端预设回退 | **omp 更优**。容量问题归协议层，UI 无需对用户配置做有副作用的写盘。注意：17.0.6 内置 exe 对 `negotiate_protocol` 返回 `Unknown command`（且响应**不带 id** 字段）→ UI 必须做"协商失败即回退 v1"的特性检测 |
| **`get_messages_page`**（256 条/页、页上限 768 KB、`session_busy`/`stale_cursor` 机器可读错误码） | `session-store.ts` 自己扫盘解析整份 JSONL + 读盘竞态防护（`store.ts:974-1000`） | **omp 更优**（对"当前会话"而言）；但 UI 的多会话读盘场景 omp 分页覆盖不了（`get_messages_page` 只服务进程当前会话），磁盘路径仍需保留 |
| **子代理订阅通道**：`set_subagent_subscription`（off/progress/events）+ `subagent_lifecycle/progress/event` 帧 + `get_subagents`（结构化 status/sessionFile/parentToolCallId）+ `get_subagent_messages`（fromByte 增量）。**该 API 17.0.6 就有**，不是升级红利 | UI 用三条来源拼合：`task` 工具 args 占位 + `hub.details.jobs` + `async-result` custom 消息里的 `<task-result status>` XML 正则，还要处理 omp 自动改名与临时 id 淘汰 | **omp 显著更优**。status/sessionFile 是结构化字段，免正则、免去重，还能直接增量读子代理转录 |
| **`get_state.tokensPerSecond` / `fastModeEnabled` / `fastModeActive`**（18.0.1+，实测键已存在，无数据时为 null）+ `set_fast_mode` | UI 完全未消费（grep 无命中）；无 /fast 支持 | 白捡的 UI 增强 |
| **`tool_stream_update`**（18.1.6：edit 流式 diff 预览） | UI 只在 `tool_execution_end` 后渲染 diff | **omp 更优**：编辑进行中即可预览。探针实跑未捕获到该帧（edit 太快），帧类型以 rpc-types 为准 |
| **`optionDetails`**（18.0.1：询问/权限选项附细节） | `PermissionModal` 只渲染 `options` 文本 | 小幅增强 |
| **会话级模式设置**（18.1.18：`set_steering_mode`/`set_follow_up_mode`/`set_interrupt_mode` 不再写全局 config.yml） | UI 有 guide/queue 输入行为，未用这三个 setter | 修复消除了"GUI 改会话设置污染全局配置"的顾虑，值得接 |
| 18.1.19 `/debug` 内存报告不再把原始堆快照写入 JS 字符串（含 provider/MCP 凭据）；18.1.3 会话重写 EPERM 回退；18.1.16 工作目录被删不崩溃 | UI 不涉及，但其安全基线可借鉴 | 记录在案 |

---

## 三、值得集成进 UI 的功能（优先级排序）

### P0 正确性修复（不做会在 18.x 上出错/降级）

1. **协议 v2 + `rpc_chunk` 重组**：`electron/omp-process.ts` 帧泵增加分块重组（校验 `chunkId/index/count/byteLength`，上限 64 MiB），ready 帧读 `supportedProtocolVersions`，发 `negotiate_protocol`；17.0.6 返回 `Unknown command`（无 id）→ 按 `command` 字段或短超时回退 v1。做完后模型目录超限问题从根上消失，可退休"写死 models.yml"绕行。
2. **`agent_end.isTerminal`**：`store.ts:1102` 增加 `frame.isTerminal === false` 分支——不置 `procStreaming=false`、不解锁输入。需先在真实 18.x 上用排队消息复现 `isTerminal:false` 帧确认症状边界（本次探针未捕获到 false 帧）。
3. **Todo 三处**：`App.tsx:64` 对 `get_state.todoPhases` 做归一化（`name→phase, tasks→items`，直接复用 `store.ts:1587` 的 `normalizeTodoPhases` 思路）；删除/修正 `store.ts:1302` 的 `todo_reminder` 死分支（实际载荷是 `{todos}` 扁平列表）；修 `rpc-client.ts:62` 字段名 `todos→phases`、`:57` `provider→providerId`（当前无调用者，接线前必须修）。
4. **技能面板对齐 18.1.5+**：`electron/omp-skills.ts` 读取用户 config 的 `skills.enableClaudeUser/enableCodexUser/enabledProviders`，未启用的外部目录标记为"omp 未加载"而非"已安装"。
5. **hashline diff**：`DiffView.tsx` 增加 hashline 分支——识别 `^\s*\d+\|` / `^[+-]\d+\|` 行；纯新增判定（`+N|` 存在即视为 diff）；渲染按行号语义着色。补 `DiffView.test.ts` 用例（纯新增/含删除/上下文三种）。

### P1 优雅替代现有绕行

6. **`set_subagent_subscription` + `subagent_*` 帧 + `get_subagents`/`get_subagent_messages`**：替换三源拼合 + XML 正则，顺带获得"点开子代理看转录"。
7. **`get_messages_page`**：当前会话的消息读取改分页（保留多会话磁盘路径）。

### P2 新功能

8. `tool_stream_update` → 编辑流式 diff 预览（DiffView 已有渲染器，只差数据源）。
9. `get_state.tokensPerSecond` → 状态栏 TPS；`fastModeEnabled/Active` + `set_fast_mode` → 模型选择器旁"快速模式"开关（18.x 的 `available_commands_update` 已带 `fast` 命令）。
10. `optionDetails` → 权限/询问弹窗渲染选项细节。
11. `set_host_tools` / `set_host_uri_schemes`（17.0.6 即有）：Electron 壳的结构性优势——把确认弹窗/文件树暴露为 agent 可调用工具与虚拟 URI。
12. `command_output`/`session_info_update`/`config_update` 帧：内置斜杠命令输出的正确渲染面（当前丢弃）。
13. `get_state.dumpTools`/`systemPrompt` → "会话检查器"面板。

### 附：内置 exe 是死资产

`resources/omp.exe`（145 MB，17.0.6）不被 `main.ts` 引用、不进打包 → 冗余；且项目兼容面取决于用户机 omp 版本，版本敏感行为（isTerminal、v2 协商、技能门控）必须特性检测而非假设。

---

## 验证记录

| 探针 | 结果 |
|------|------|
| `todo-shape.mjs`（内置 17.0.6） | `set_todos{todos}` → fail；`{phases}` → success；`get_state.todoPhases=[{name,tasks}]`；`login{provider}` → `Unknown OAuth provider: undefined` |
| `v1-large.mjs`（18.1.21） | v1 不协商 → `RPC response exceeded the transport limit`, models=0 |
| `v2b.mjs`（18.1.21） | 协商 v2 → 5 个 `rpc_chunk`，1,219,906 字节无损（客户端需自行重组） |
| `v2d.mjs`（两版本对比） | 17.0.6 ready=`{type:"ready"}`，negotiate → `Unknown command`（响应无 id）；18.1.21 ready 带 `supportedProtocolVersions:[1,2]` |
| `final18.mjs`（18.1.21） | `agent_end` keys 含 `isTerminal`；`todo_reminder={todos:[flat],attempt,maxAttempts}`；`set_todos{phases}` 成功 |
| `rem17b.mjs`（17.0.6） | `todo_reminder` 载荷与 18.x 一致（扁平 `todos`）；`agent_end` 无 `isTerminal` |
| `live18.mjs`（18.1.21） | `get_state` 含 `tokensPerSecond/fastModeEnabled/fastModeActive`；帧流含 `turn_start/turn_end/tool_execution_update`，未见 `tool_stream_update` |
| vitest 探针 | `extractDiff` 对纯新增 hashline diff → `null`；含删除行 → 取出但渲染丢行号语义 |
