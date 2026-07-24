# oh-my-pi Windows GUI 接入实施计划

> 目标：为 oh-my-pi（omp）打造一个仿 Codex 风格的 Windows 桌面 GUI，基于 Electron + React + TS，通过 `omp.exe --mode rpc-ui` 的 NDJSON over stdio 协议接入。
> 项目位置：`D:\code\OPENCODEUI\omp-gui`
> 技术栈：Electron 28+ / React 18 / TypeScript 5 / Vite（构建）
> 研究依据：`D:\code\OPENCODEUI\opencode_windows_webui_research.md`、oh-my-pi 仓库 `rpc-types.ts` / `docs/rpc.md` / `docs/sdk.md` / `docs/session.md`

---

## 一、总体方案

### 1.1 接入方式：`omp --mode rpc-ui`

omp 提供 5 个对外接入面（RPC / Node SDK / Python / ACP / TUI）。评估后**选 RPC 模式**：

- 进程隔离：GUI 崩溃不杀 agent，agent 崩溃不杀 GUI
- 零运行时拖累：仅依赖 `omp.exe`，不引入 Bun（Node SDK 内部 `spawn("bun", ...)`，给 Windows 分发增加负担）
- 完整 UI 交互帧：`--mode rpc-ui` 下发出 11 种 `extension_ui_request`，可还原 TUI 的卡片/diff 预览/权限体验
- 语言无关：协议在 `rpc-types.ts` 强类型定义，NDJSON over stdio，Node 主进程天然适配

### 1.2 启动参数（默认）

```
omp.exe --mode rpc-ui --approval-mode write [--cwd <由 spawn 的 cwd 选项指定>]
```

- **权限默认 `yolo` 的坑（最重要）**：omp 默认 approval 模式是 `yolo`（read/write/exec 全部自动批准、不弹窗）。要出现 Codex 式审批弹窗，spawn 时**必须显式带 `--approval-mode write`**（read/write 自动、exec 弹窗）或 `always-ask`（write/exec 都弹）。漏带这个 flag = agent 静默执行所有危险操作，UI 完全拦不住。这是 RPC 权限模型最主要坑点，开发期极易踩。
- `--approval-mode write`：read/write 工具自动执行，exec 类（bash/browser/ssh/task）才弹窗 → 既有审批又不打断常规读写
- GUI 设置项「Auto-approve exec tools」勾上 → 改为 `--yolo`（或 `--auto-approve`）重启，进入无人值守
- `--cwd` 不走显式 flag，由 `child_process.spawn(..., { cwd })` 指定（与 OMP 会话目录编码逻辑一致）
- 调试期可加 `--no-session` 先验证握手（内存会话、不写盘），正式版按 cwd 自动 resume

### 1.3 架构

```
+----------------------------------------------+
|  React + TS 前端（WebView）                   |  聊天流/工具卡/diff/状态栏/边栏
+----------------------------------------------+
|  Electron 主进程（Node）                       |  spawn omp + 帧路由 + IPC
|   +-- OmpProcess   : spawn / ready / stdio   |
|   +-- FrameRouter  : 按 id 关联 req/resp     |
|   +-- SessionStore : 扫盘会话列表             |
|   +-- PermBridge   : UI帧 <-> 前端 modal     |
+----------------------------------------------+
|  omp.exe --mode rpc-ui（子进程）              |  agent 引擎 + 32 工具
+----------------------------------------------+
```

数据流：
- 命令（renderer→main→omp.stdin）：`ipcMain.handle` 接收，主进程赋 `id` 后写 stdin
- 事件（omp.stdout→main→renderer）：`readline` 逐行 parse，按帧 type 分发，经 `webContents.send` 推渲染层
- 权限：`extension_ui_request` → 推前端 React modal → 用户操作 → renderer→main→stdin 的 `extension_ui_response`

---

## 二、通信契约要点（实现参考）

### 2.1 握手
- 子进程启动后先输出 `{"type":"ready"}` 才处理命令
- 收到 ready 后立即发 `get_state` + `get_available_models` 填充 UI
- stdin 关闭时 omp 拒绝 pending 的 host_tool/host_uri 调用，进程 exit code 0

### 2.2 id 关联
- 命令帧可选 `id?: string`，响应帧回显同 `id`
- `prompt`/`abort_and_prompt` 立即 ack，但同 id 的异步错误可能稍后才发
- 未知命令的响应 `id: undefined`（即使请求带 id）；解析/处理器异常 emit `command: "parse"` 且 `id: undefined`

### 2.3 关键输入帧（client→omp，约 50 种，列出 M1-M4 用到的）
- **Prompting**：`prompt` / `steer` / `follow_up` / `abort` / `abort_and_prompt` / `new_session`
- **State**：`get_state` / `get_available_commands` / `set_todos` / `get_subagents` / `get_subagent_messages` / `set_subagent_subscription`
- **Model**：`set_model` / `cycle_model` / `get_available_models`
- **Thinking**：`set_thinking_level` / `cycle_thinking_level`
- **Compaction**：`compact` / `set_auto_compaction`
- **Retry**：`set_auto_retry` / `abort_retry`
- **Session**：`get_session_stats` / `export_html` / `switch_session` / `branch` / `get_branch_messages` / `get_last_assistant_text` / `set_session_name` / `handoff`
- **Messages**：`get_messages`
- **Login**：`get_login_providers` / `login`

### 2.4 关键输出帧（omp→client）
- `ready` —— 握手
- `response` —— 带 `id` 的命令响应，`command`/`success`/`data`|`error`
- `AgentSessionEvent`（22 种）：
  - 生命周期：`agent_start` / `agent_end` / `turn_start` / `turn_end`
  - 消息：`message_start` / `message_update` / `message_end`
  - 工具：`tool_execution_start` / `tool_execution_update` / `tool_execution_end`
  - 压缩：`auto_compaction_start` / `auto_compaction_end`
  - 重试：`auto_retry_start` / `auto_retry_end` / `retry_fallback_applied` / `retry_fallback_succeeded`
  - 规则：`ttsr_triggered`
  - Todo：`todo_reminder` / `todo_auto_clear`
  - 其他：`irc_message` / `notice` / `thinking_level_changed` / `goal_updated`
- `extension_ui_request`（11 种 method）：
  - 需应答：`select` / `confirm` / `input` / `editor` / `cancel`
  - 单向通知：`notify` / `setStatus` / `setWidget` / `setTitle` / `set_editor_text`
  - OAuth：`open_url`
- `subagent_lifecycle` / `subagent_progress` / `subagent_event`（需 `set_subagent_subscription`）
- `available_commands_update` / `prompt_result` / `host_tool_call` / `host_uri_request` / `extension_error`

### 2.5 权限机制（RPC 特有）
- RPC **不走** ACP 的 `session/request_permission`
- 危险工具触发 `extension_ui_request` 的 `confirm`/`select`/`input`/`editor`，宿主回 `extension_ui_response`
- 响应格式：`{value: string}` / `{confirmed: boolean}` / `{cancelled: true, timedOut?: boolean}`
- 子代理内部以 yolo 跑，不再为子代理弹权限（只有外层 `task` 工具自身可能 trigger 一次 confirm）
- 超时由 omp 端用默认值兜底
- **前提（重要）**：必须 `--approval-mode write`（或 `always-ask`）才会出现这些审批帧；默认 `yolo` 下上述 `confirm`/`select`/`input`/`editor` 帧**完全不出现**，agent 静默执行所有工具
- **tool tier 与 mode 的关系**（来自 `docs/approval-mode.md`）：tool 声明 `read`/`write`/`exec` tier；`yolo` 全自动，`write` 仅 exec 弹，`always-ask` write+exec 都弹；per-tool 策略 `tools.approval.<tool>` 可 override（allow/deny/prompt）
- RPC 不提供 pre-tool 钩子，approval 模式是唯一拦截机制；若某工具在 `write` 模式下仍走自动批准而 UI 想拦截，退路是改用 `always-ask`

### 2.6 会话持久化（M3 实现）
- 存放：`~/.omp/agent/sessions/<dir-encoded>/<timestamp>_<sessionId>.jsonl`
- `<dir-encoded>`：cwd 在 home 内 → `-<relative>`（`/\:` 替换为 `-`）；在 OS tmp 内 → `-tmp-<relative>`；其他 → legacy `--<cwd>--`
- 格式：JSONL，第 1 行 `SessionHeader`（version 3，含 `id`/`cwd`/`title`/`parentSession`），其余 12 种 `SessionEntry`（append-only，分支只移 leaf 指针）
- 附属：blob store `~/.omp/agent/blobs/<sha256>`、terminal breadcrumb、`history.db`(SQLite)
- RPC 无 `list_sessions` 命令 → 宿主自己扫盘，读 4KB header 拿标题/时间，读 32KB tail 拿 leaf 状态
- RPC 默认禁用标题自动生成 → 标题 fallback 到首条 user 消息前 N 字
- ⚠️ **不确定项待 P0 核实**：上述 `<dir-encoded>` 规则、4KB header、32KB tail、12 种 SessionEntry 分类、SessionHeader 字段均为二手描述。P0 必须读 `docs/session.md` 与 `rpc-types.ts` 中 `SessionHeader`/`SessionEntry` 定义精确落实，**不要照抄本节**。JSONL schema 是 M3 实现的硬依赖，错了会话列表就废了。

### 2.7 模型切换（M3 实现）
- RPC 无切 role 命令，只能 `set_model(provider, modelId)` 或起时用 `--smol`/`--slow`/`--plan` flag
- role picker = 先 `get_available_models` 列全模型让用户直选具体 model
- 模型切换触发 `model_change` entry 写盘 + `notice` / `thinking_level_changed` 事件

---

## 三、准备工作

### P0 准备步骤
- [ ] **P0.1** 确认 `omp` 在 PATH 并**识别它是 standalone 还是 bun shim**：
  - PowerShell 跑 `where.exe omp` + `(Get-Item <path>).Length`
  - 文件 < 100KB → 多是 `~/.bun/bin/omp.exe` 薄启动器（依赖本机 bun，开发能用但**不能用于分发**）；文件 > 50MB → standalone 自包含二进制
  - 记录路径与版本（`omp --version`），M3/M4 与打包阶段依赖此信息
- [ ] **P0.2** 手动测试 RPC 握手（实测意识，不靠想象）：
  ```powershell
  '{}' | omp --mode rpc-ui --no-session
  ```
  观察首行 `{"type":"ready"}`，以及是否推送 `extension_ui_request`/`available_commands_update` 帧。
  再对照测试 `--approval-mode write`：跑一次会触发 exec 的 prompt，确认 `confirm` 帧出现；不带该 flag（默认 yolo）时不弹——**验证权限默认值坑点**。
- [ ] **P0.3** 抓取 `rpc-types.ts` 最新版到 `src/shared/rpc-types.ts`（同步核心类型：`RpcCommand` / `AgentSessionEvent` / `RpcExtensionUIRequest` / `RpcExtensionUIResponse` / `RpcSessionState` / `RpcResponse`）
- [ ] **P0.4** 初始化项目结构：
  ```
  omp-gui/
  +-- package.json
  +-- tsconfig.json / tsconfig.node.json
  +-- vite.config.ts
  +-- electron/main.ts
  +-- electron/preload.ts
  +-- src/
  |   +-- main/          # 主进程逻辑（由 electron/main.ts 引用）
  |   |   +-- omp-process.ts
  |   |   +-- frame-router.ts
  |   |   +-- session-store.ts
  |   |   +-- ipc.ts
  |   |   +-- perm-cache.ts
  |   +-- renderer/      # React 前端
  |   |   +-- App.tsx
  |   |   +-- rpc-client.ts
  |   |   +-- chat/  tools/  diff/  permission/  sidebar/  statusbar/  model-picker/  todo/
  |   +-- shared/
  |       +-- rpc-types.ts
  |       +-- ipc-channels.ts
  ```
- [ ] **P0.5** 安装依赖：electron、react、react-dom、typescript、vite、@vitejs/plugin-react、electron-vite（或等价脚手架）、electron-builder（打包）
- [ ] **P0.6** 配置 dev 脚本：`electron-vite dev`（主进程热重载 + 渲染层 Vite HMR）
- [ ] **P0.7** 建立日志：子进程 stderr 写 `D:\code\OPENCODEUI\omp-gui\.temp\omp-stderr.log`（按日期分文件），前端日志面板可查看
- [ ] **P0.8** **发布版 omp 取得方案**（开发期可跳过，打包前必须落地）：
  - 开发机的 omp（P0.1 识别的那个）若是 bun shim，**禁止直接拷给最终用户** —— 目标机没 bun 会炸
  - 发布版通过 `irm https://omp.sh/install.ps1 | iex` 或 GitHub Release 取得 **standalone 自包含 `omp.exe`**（README 强调 "same omp binary runs on macOS/Linux/Windows — no WSL bridge"）
  - 放入项目 `resources/omp.exe`，由 `electron-builder` 的 `extraResources` 拷到运行目录，主进程按 `process.resourcesPath` 解析绝对路径 spawn
  - 打包前在**无 bun 的干净 Windows 机器**（或新用户 profile）验证 `omp --mode rpc` 可自包含运行（native addon 加载、无 WSL 依赖）

---

## 四、里程碑 M1：最小回路（prompt + 流式回复）

> 验收：在输入框敲一句话，点发送，看到 omp 流式返回的 Markdown 文本逐字出现。

### M1.1 主进程 omp-process.ts
- [ ] 封装 `OmpProcess` 类：`spawn(args, cwd)` / `onReady` / `onFrame` / `onExit` / `onError` / `write(cmd)` / `kill()`
- [ ] 用 `child_process.spawn('omp.exe', ['--mode','rpc-ui','--approval-mode','write'], { cwd, stdio:['pipe','pipe','pipe'] })`
- [ ] stdout 用 `readline.createInterface({input: child.stdout})` 逐行 `JSON.parse`
- [ ] 第一帧 `{"type":"ready"}` 触发 `onReady` 回调
- [ ] stderr 累积到日志文件 + 触发 `onError`（带 stderr 片段）
- [ ] `exit` 事件触发 `onExit(code)`，主进程决定重连或报错

### M1.2 主进程 frame-router.ts
- [ ] 维护 `Map<string, {resolve, reject, timeout}>` 关联 request/response
- [ ] `send(cmd): Promise<RpcResponse>` —— 自动赋 `id`（`crypto.randomUUID()`），写 stdin，注册 pending，5min 超时
- [ ] `dispatch(frame)` —— 按 frame.type 分发：
  - `ready` → OmpProcess.onReady
  - `response` → FrameRouter 查 pending Map，resolve/reject
  - 其他（event / extension_ui_request 等） → 经 IPC 推渲染层
- [ ] 处理异常帧：`command:"parse"` 且 `id:undefined` → 记日志

### M1.3 IPC 通道（preload + main）
- [ ] `src/shared/ipc-channels.ts` 定义通道名 + 类型：`rpc:send` / `rpc:event` / `rpc:ui-request` / `rpc:ready` / `omp:stderr` / `omp:exit`
- [ ] `electron/preload.ts` 通过 `contextBridge.exposeInMainWorld` 暴露 `window.omp` API：`send(cmd)` / `onEvent(cb)` / `onUIRequest(cb)` / `onReady(cb)` 等
- [ ] `ipcMain.handle('rpc:send', ...)` 调 FrameRouter.send
- [ ] FrameRouter dispatch 时 `mainWindow.webContents.send('rpc:event', frame)` 推事件

### M1.4 渲染层 rpc-client.ts
- [ ] 封装 `RpcClient` 单例，方法：
  - `prompt(text)` / `abort()` / `getState()` / `getAvailableModels()` / `getMessages()` 等
  - `on(eventType, cb)` 订阅 `AgentSessionEvent`
  - `onUIRequest(cb)` 订阅 `extension_ui_request`
- [ ] 内部调 `window.omp.send(cmd)`，返回 Promise
- [ ] 统一错误处理：response.success === false 抛带 `command`/`error` 的 Error

### M1.5 最简聊天 UI
- [ ] `App.tsx`：左侧栏放占位（M3 填会话列表），右侧主区聊天
- [ ] `chat/ChatView.tsx`：消息列表 + 底部输入框 + 发送按钮
- [ ] 状态：`messages: ChatMessage[]`、`isStreaming: boolean`、`draft: string`
- [ ] `ChatMessage`：`{role: 'user'|'assistant', parts: Array<TextPart|ToolPart|...>}`
- [ ] 消费事件合成消息流：
  - `agent_start` → 置 isStreaming=true，push 一条 assistant 空消息
  - `message_start`（assistant）→ 追加空 assistant 消息
  - `message_update`（text_delta）→ 追加文本到当前 assistant 消息
  - `message_end` → 标记消息完成
  - `agent_end` → isStreaming=false
- [ ] Markdown 渲染：用 `react-markdown` + `remark-gfm`，代码块用 `react-syntax-highlighter`（或 shiki）
- [ ] 流式追加自动滚动到底部
- [ ] Esc 触发 `abort()`
- [ ] 输入框：Enter 发送，Shift+Enter 换行

### M1.6 启动握手
- [ ] App 挂载时 `window.omp.onReady(() => { rpc.getState(); rpc.getAvailableModels(); })`
- [ ] `get_state` 响应存全局 store（model / isStreaming / sessionFile / messageCount / contextUsage）
- [ ] `get_available_models` 响应存 model 列表（M3 picker 用）

### M1.7 实测验收
- [ ] 启动 GUI，看到握手完成的日志
- [ ] 输入 "列出当前目录的 .ts 文件"，看到：
  - 工具被调用（暂以折叠占位显示，M2 细化）
  - assistant 文本流式追加
  - Esc 能中止
- [ ] 关闭窗口时 omp 子进程被 kill，无残留

---

## 五、里程碑 M2：工具卡 + Diff + 权限

> 验收：让 omp 改一个文件，看到 diff 预览和 Accept/Reject；触发 bash 命令时弹权限 modal，可批准/拒绝/记住。

### M2.1 工具卡组件
- [ ] `tools/ToolCard.tsx`：折叠/展开，头部显示工具名 + 状态（running/done/error）
- [ ] 展开区显示 args（JSON 或 prettified）+ result
- [ ] 特殊工具定制渲染：`read` 显示文件路径+行数、`search` 显示命中数、`bash` 显示命令+退出码
- [ ] 折叠默认，error 自动展开

### M2.2 消费工具事件
- [ ] `tool_execution_start`：在当前 assistant 消息内追加 `ToolPart`，状态 running
- [ ] `tool_execution_update`：更新 ToolPart 的 partialResult（支持流式 bash 输出）
- [ ] `tool_execution_end`：置 done/isError，落 result
- [ ] 按 `toolCallId` 关联，在同一卡片上累加

### M2.3 Diff 预览组件
- [ ] `diff/DiffView.tsx`：unified diff 渲染，增删行着色
- [ ] 识别 edit / write / ast_edit 的 `tool_execution_end.result` 中 diff 字段（具体字段名实测确认）
- [ ] 卡片底部 Accept/Reject 按钮（M2.5 权限联动的替代路径：若 omp 已自动执行则 Accept 仅做 UI 确认；若需审批则对接权限 modal）
- [ ] ast_edit 的 `*(proposed)*` 卡片 + `resolve` 调用（可选，M2 阶段先显示即可）

### M2.4 权限 modal 组件
- [ ] `permission/PermissionModal.tsx`：根据 `extension_ui_request.method` 渲染：
  - `confirm`：标题 + 消息 + Yes/No + 「Always allow this tool」勾选
  - `select`：标题 + 选项列表（radio）+ 确定/取消
  - `input`：标题 + 输入框 + 确定/取消
  - `editor`：多行编辑器 + 确定/取消（罕见，先支持基本功能）
  - `cancel`：关闭 targetId 对应的 modal
- [ ] modal 排队：同时多个 UI 请求时按 id 顺序显示（不并发，避免误操作）
- [ ] 展示关联的工具卡上下文（让用户看到要批准的具体 bash 命令/diff）

### M2.5 UI 请求应答回路
- [ ] renderer 收到 `extension_ui_request` → 推 modal 队列 → 用户操作 → `rpc.respondUI({type:'extension_ui_response', id, value|confirmed|cancelled})`
- [ ] 主进程 `ipcMain.handle('rpc:respond-ui', ...)` 写 stdin
- [ ] 超时兜底：若用户长时间不操作，omp 端默认超时回默认值，前端 modal 收到 `cancel` 帧自动关闭

### M2.6 宿主侧 allowlist 缓存
- [ ] `main/perm-cache.ts`：内存 Map `<toolName, 'allow'|'deny'>`
- [ ] 「Always allow this tool」勾选时写入缓存
- [ ] 后续同工具的 `confirm` 请求：命中 allow → 自动回 `confirmed:true`，不弹 modal；命中 deny → 自动回 `confirmed:false`
- [ ] 设置面板提供「重置工具权限」清缓存
- [ ] 注意：这是宿主 UX 层优化，omp 服务端不持久化每工具 allowlist

### M2.7 实测验收
- [ ] 让 omp 创建一个新文件 → 看到 write 工具卡 + diff 预览
- [ ] 让 omp 跑 `dir` → 看到 bash 工具卡 + 权限 modal（--approval-mode write 下 exec 类需确认）
- [ ] 批准一次 bash，勾「Always allow」→ 后续 bash 直接执行不弹
- [ ] 拒绝一次 → omp 收到拒绝结果并继续对话

---

## 六、里程碑 M3：会话管理 + 模型切换（完整 P0）

> 验收：左侧能看到历史会话列表，能新建/切换/resume/重命名；右上角能切换模型。

### M3.1 会话存储扫描
- [ ] `main/session-store.ts`：
  - 定位 `~/.omp/agent/sessions/`（Windows: `C:\Users\<user>\.omp\agent\sessions\`）
  - 按 `<dir-encoded>` 子目录扫描 `.jsonl` 文件
  - 每文件读 4KB 前缀 parse `SessionHeader`（取 id/timestamp/cwd/title/parentSession）
  - title 为空时 fallback：读首条 `type:"message"` 且 `role:"user"` 的 content 前 40 字
  - 读 32KB tail 取最后 leaf entry（生命状态）
- [ ] 缓存扫描结果，监听目录变化（`fs.watch`）触发增量更新
- [ ] 按 cwd 过滤当前项目相关的会话

### M3.2 会话列表边栏
- [ ] `sidebar/SessionList.tsx`：卡片显示标题、时间（相对时间）、消息数（从 tail 估算）
- [ ] 当前活动会话高亮
- [ ] 右键菜单：Rename / Fork / Export HTML / Delete（Delete 仅删文件，需二次确认）
- [ ] 新建按钮触发 `new_session`

### M3.3 新建会话
- [ ] `rpc.newSession()` → 收 `response`（`{cancelled: boolean}`）
- [ ] 成功后清空当前聊天视图，`get_state` 刷新 sessionFile
- [ ] 边栏新条目由 `fs.watch` 增量插入

### M3.4 切换历史会话
- [ ] 用户点边栏条目 → `rpc.switchSession(sessionPath)` → `{cancelled: boolean}`
- [ ] 成功后 `rpc.getMessages()` → `data.messages: AgentMessage[]`
- [ ] 把 messages 同步渲染到聊天视图（含历史工具卡，ToolPart 从消息内还原）
- [ ] `get_state` 刷新当前 sessionFile / messageCount

### M3.5 重命名会话
- [ ] 边栏右键 Rename → 弹 input modal → `rpc.setSessionName(name)`
- [ ] 成功后刷新边栏该条目（扫盘或本地更新）

### M3.6 模型切换器
- [ ] `model-picker/ModelPicker.tsx`：下拉显示 `get_available_models` 的 model 列表
- [ ] 当前 model 高亮（从 `get_state` 的 `model` 字段）
- [ ] 选中 → `rpc.setModel(provider, modelId)` → response.data 是新 Model
- [ ] 分组按 provider 排序
- [ ] role 说明（default/smol/slow/plan）以 tooltip 形式展示（因 RPC 无切 role，只能选具体 model）

### M3.7 状态栏
- [ ] `statusbar/StatusBar.tsx` 显示：当前 model、isStreaming 状态、messageCount、contextUsage.tokens / contextWindow / percent
- [ ] `get_state` 触发刷新的事件源：启动、new/switch session、set_model、以及 `available_commands_update` / `notice`（可选 polling 每 5s 一次兜底）
- [ ] isStreaming 由 `agent_start`/`agent_end` 事件驱动，不依赖 polling

### M3.8 Slash 命令补全
- [ ] 消费 `available_commands_update` 帧，缓存 `RpcAvailableSlashCommand[]`
- [ ] 输入框 `/` 触发补全下拉
- [ ] 选中后填入输入框（命令文本仍作为 prompt 发送，omp 端解析 slash）

### M3.9 OAuth 登录（仿 Codex 核心体验）
> 定位：项目目标是"仿 Codex"，而 Codex 登录（`openai-codex` oauth provider）是 omp 原生支持的 provider 之一。没登录就不算可用版，故从 M4 提到 M3。

- [ ] `rpc.getLoginProviders()` → 列出可登录 provider，重点支持 `openai-codex`
- [ ] 用户选 provider → `rpc.login(providerId)`
- [ ] 消费 `extension_ui_request.method === 'open_url'` → 用 Electron `shell.openExternal(url)` 打开系统浏览器完成 OAuth（不用内嵌 webview，避免 CSP/cookie 隔离问题）
- [ ] omp 端处理 loopback callback（`launchUrl` 字段是短 loopback URL，302 重定向到 `url`），登录完成后前端 `get_available_models` 刷新
- [ ] 登录状态在状态栏显示（已登录 provider / 未登录）
- [ ] ⚠️ M3 实测验证 `openai-codex` oauth 在 Windows 的 `open_url` 浏览器回调能否被 omp 接住

### M3.10 实测验收
- [ ] 新建会话 → 聊几轮 → 关闭 GUI → 重开 → 边栏能看到该会话
- [ ] 点历史会话 → 聊天历史完整还原（含工具卡）
- [ ] 切换 model → 状态栏更新，后续回复来自新 model
- [ ] `/` 触发补全，`/help` 之类能跑
- [ ] `openai-codex` oauth 登录成功，model 列表刷新出 Codex 模型

---

## 七、里程碑 M4：P1 增强

> 验收：体验对齐 Codex CLI/Desktop 日常使用。

### M4.1 模型切换快捷键 + thinking picker
- [ ] `Ctrl+P` → `rpc.cycleModel()`，状态栏循环显示
- [ ] thinking picker：`set_thinking_level` (off/minimal/low/medium/high/xhigh/max) + `cycle_thinking_level`
- [ ] 消费 `thinking_level_changed` 事件同步 UI

### M4.2 Todo 面板
- [ ] `todo/TodoPanel.tsx`：从 `get_state.todoPhases` 渲染阶段列表 + 完成进度
- [ ] 消费 `todo_reminder` / `todo_auto_clear` 事件动态更新
- [ ] 支持 `set_todos` 让用户在 GUI 编辑后同步回 agent
- [ ] 位置：右侧面板或顶部折叠

### M4.3 上下文压缩提示
- [ ] 消费 `auto_compaction_start` → 显示「Compressing context...」气泡
- [ ] 消费 `auto_compaction_end` → 关闭气泡，显示 result 摘要
- [ ] 设置面板提供「自动压缩」开关（`set_auto_compaction`）+ 手动压缩按钮（`compact`）

### M4.4 重试 UI
- [ ] 消费 `auto_retry_start` → 显示「Retrying (attempt N/M)...」+ 倒计时（delayMs）
- [ ] 消费 `auto_retry_end` → 关闭提示，显示 success/failure
- [ ] 消费 `retry_fallback_applied` / `retry_fallback_succeeded` → toast 通知
- [ ] 设置面板：`set_auto_retry` 开关 + 手动 `abort_retry`

### M4.5 Cost/Token 状态栏扩展
- [ ] 从 `agent_end.telemetry`（若开了 AgentTelemetryConfig）取 token/cost
- [ ] 或 `rpc.getSessionStats()` 取累计统计
- [ ] 状态栏扩展：本轮 tokens / 本轮 cost / 会话累计
- [ ] contextUsage percent 超过 80% 高亮提醒

### M4.6 通知 toast
- [ ] 消费 `extension_ui_request.method === 'notify'` → toast（info/warning/error 三色）
- [ ] 消费 `method === 'setStatus'` → 状态栏某 key 更新
- [ ] 消费 `notice` 事件 → toast
- [ ] toast 队列，可点击展开详情

### M4.7 分叉 UI
- [ ] `rpc.getBranchMessages()` → 列出可分叉的消息点
- [ ] 聊天消息上右键「Branch from here」→ `rpc.branch(entryId)` → `{text, cancelled}`
- [ ] 分叉后新建会话视图（或提示用户新建）

### M4.8 OAuth 登录
> 已移至 **M3.9**（仿 Codex 核心体验，应在可用版就具备，不属 P1 增强）。
- [ ] 见 M3.9

### M4.9 会话导出
- [ ] 边栏右键 Export HTML → `rpc.exportHtml(outputPath?)` → `{path}`
- [ ] 用 Electron `dialog.showSaveDialog` 让用户选保存位置
- [ ] 导出完成 toast 提示路径，可「打开文件夹」

### M4.10 实测验收
- [ ] Ctrl+P 切换 model 流畅
- [ ] Todo 面板随对话动态更新
- [ ] 压缩/retry 提示按时出现消失
- [ ] 状态栏 cost 随对话累加
- [ ] toast 消息不漏
- [ ] 导出 HTML 能在浏览器打开
- [ ] （OAuth 验收已移至 M3.10）

---

## 八、P2 可选增强（不安排，列出备查）

仅当目标是完整 TUI 平替时才需要：

- **Subagent 卡片**：`set_subagent_subscription: "progress"` + `subagent_lifecycle`/`subagent_progress` 帧；多 worker 并行卡片
- **Subagent 详情面板**：`set_subagent_subscription: "events"` + `get_subagents` / `get_subagent_messages`
- **内嵌终端**：`bash` / `abort_bash` 命令，GUI 内 xterm.js 终端（需 PTY，Electron 侧用 node-pty）
- **TTSR 规则注入提示**：`ttsr_triggered` 事件 → 卡片显示规则内容
- **host_tool 暴露**：`set_host_tools` 注册 GUI 自有工具（如「在 IDE 打开文件」「打开外置预览」）→ 响应 `host_tool_call`
- **自定义 URL scheme**：`set_host_uri_schemes` 注册虚拟文件系统 → 响应 `host_uri_request`
- **会话 handoff**：`handoff` 命令把当前上下文移交给新会话
- **setting 面板**：读写 `~/.omp/agent/models.yml` / `config.yml`，展示 custom providers / fallback chains / path-scoped models / round-robin credentials
- **setWidget / setTitle / set_editor_text**：高级 UI 同步（完整对齐 TUI）
- **Collab**：`/collab` 的 GUI 化（share link 二维码、read-only 链接）——需额外 relay 服务，P2 优先级低

---

## 九、里程碑验收矩阵

| 里程碑 | 核心能力 | 关键帧/事件 | 验收动作 |
|---|---|---|---|
| M1 | prompt + 流式回复 | prompt / ready / message_* / agent_* | 发一句话看到流式文本，Esc 中止 |
| M2 | 工具卡 + diff + 权限 | tool_execution_* / extension_ui_request(confirm/select/input/editor) / extension_ui_response | 改文件见 diff，bash 弹权限可批准 |
| M3 | 会话 + 模型切换 + OAuth（P0 完整） | new/switch_session / get_messages / set_model / get_available_models / get_state / available_commands_update / login / open_url | 历史会话切换/新建/重命名，model picker 切换，Codex 登录可用 |
| M4 | P1 增强 | cycle_model / set_thinking_level / auto_compaction_* / auto_retry_* / todo_reminder / notice / export_html | 体验对齐 Codex 日常使用（OAuth 已在 M3） |

---

## 十、风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| omp.exe 不在 PATH 或路径变化 | GUI 启动失败 | 设置面板让用户指定 omp.exe 路径；启动时 `where omp` 探测，失败提示安装命令 |
| 发布版误用 bun shim | 目标机无 bun 时 omp 启动失败 | P0.8 已要求用 standalone；打包前在无 bun 干净机验证；shim 仅开发期用 |
| JSONL schema 照抄二手描述 | 会话列表解析失败 | P0.3 读 `docs/session.md` 与 `rpc-types.ts` 落实 SessionHeader/SessionEntry；不照抄 plan 描述 |
| openai-codex oauth 在 Windows 回调失败 | Codex 登录不可用 | M3.9 实测 `open_url` → `shell.openExternal` 回调链路能否被 omp 接住 |
| rpc-types.ts 类型漂移（omp 升级） | 帧解析失败 | shared/rpc-types.ts 标注同步版本；未知帧 type 记日志不崩溃；启动时 `omp --version` 校验 |
| Windows 中文编码（omp 子进程 stdout） | 乱码 | spawn 时设 `env.UTF-8`，stdout 默认 utf-8；若有乱码参考既有 PowerShell 编码治理经验（OPCODEUI 目录下的 opencode 中文编码研究） |
| extension_ui_request 并发 | modal 互斥错误 | 单队列顺序展示；cancel 帧强制关闭对应 id 的 modal |
| 会话扫盘性能（大量 jsonl） | 边栏卡顿 | 增量扫描 + LRU 缓存 + 虚拟滚动；首次扫描异步进行不阻塞 UI |
| RPC 无 list_sessions | 需手动扫盘 | M3.1 已实现；watch 目录变化增量更新 |
| omp 子进程崩溃 | GUI 卡死 | onExit 事件 → 前端提示「omp 已退出 code=X」+ 重启按钮；崩溃日志可复制 |
| 权限 modal 超时 | 用户未操作 omp 已默认 | modal 收到 cancel 帧自动关闭；UI 提示「已超时」 |
| diff 字段名实测与文档不符 | DiffView 解析失败 | M2.3 实测确认 edit/write/ast_edit 的 result 结构，按需兼容多种 diff 格式 |
| Electron 包体大（~150MB） | 分发负担 | 接受；后续可考虑 Tauri 重写（P2 之外） |

---

## 十一、执行节奏

- **M1**：1-2 天，跑通最小回路
- **M2**：2-3 天，补齐工具/diff/权限
- **M3**：2-3 天，完整 P0
- **M4**：3-5 天，P1 增强
- 总计：8-13 天到 P1 完整体

每个里程碑完成后实测验收，验收通过再进入下一阶段。M1 完成即可日常试用，M3 完成是 P0 可用版本。
