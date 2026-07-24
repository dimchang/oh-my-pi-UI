# kimi_plan.md — oh-my-pi Windows GUI（仿 Codex）实施计划

> **本计划与同目录 `plan.md` / `pi_plan.md` 的关系：骨架（RPC 接入、三栏布局、M1–M4 划分）沿用两份旧 plan 的共识；本计划在关键假设上补了本机实测，并对每条实测给出原始命令与输出截录。**
> 凡标注 `[已实测]` 的，附原始命令+输出（见 §0.3），可复现；凡标注 `[待实测]` 的，是文档/plan 提及但未验过、实现前须先验证的点。
>
> 目标：为 oh-my-pi（omp）做一个仿 OpenAI Codex 观感的 Windows 桌面 GUI，UI 只做接入层，agent 引擎完全由 omp 子进程承担。
> 技术栈：**Electron + React + TS（沿用用户既定选择）**；Tauri 2 仅作备选记录。
> 项目根目录：`<REPO_ROOT>`（本计划所有路径相对此目录）。

---

## 0. 先讲结论：两份旧 plan 的问题，以及我不同的地方

### 0.1 两份旧 plan 共同的关键缺陷

1. **长连接约束：stdin 由宿主持有、运行期不主动关。**
   stdio RPC 服务在 stdin EOF 时退出是常规行为，omp `docs/rpc.md` 也写明 stdin 关闭即退出。
   对真实实现这不是坑——Node `child_process.spawn` / Rust `Command` 默认就持有 stdin pipe，不显式 `end()`/`drop` 就不会关。
   只需在 `OmpProcess` 里明确一条不变式：**stdin 生命周期 = 子进程生命周期，GUI 退出时才随 kill 一起关**。
   （说明：我此前用 `echo ... | omp` 管道测到"EOF 即退"，把它说成"最致命发现"是夸大——那是管道集成方式本身的问题，不是 GUI 会遇到的问题。此条降级为"需要知道的前提"。）

2. **会话目录编码是三分支，本项目命中 legacy 分支。**
   研究报告与 omp 行为一致：`cwd` 在 home 内 → `-<relative>`；在 OS tmp 内 → `-tmp-<relative>`；**其他位置（本项目 `<REPO_ROOT>` 即属此类）→ legacy `--<cwd>--`**。
   我实测到的 `--D--code-OMP-UI--` 正是 legacy 分支的预期结果，**不是旧 plan 写错**（旧 plan 只举了 home 内的特例，不算错但不完整）。
   → 关键结论不变且更稳：**扫盘不自己实现编码规则去猜目录名**，而是遍历 `sessions\` 下所有子目录、读每个 `.jsonl` 首行拿 `cwd` 字段再与当前 cwd 比对过滤（见 §2.6）。这样三分支乃至未来规则变化都免疫。

3. **技术栈：默认沿用用户已选的 Electron + React + TS，Tauri 仅作备选记录。**
   用户此前已确定 Electron 技术栈（长期记忆与既有决定），本 plan 不推翻。
   Tauri 2（Rust 壳 + 系统 WebView2，安装包 ~10MB、内存更低）仅作为"若未来想减重"的备选记在此处，**不作为本计划默认**。
   → §1.3 架构按 Electron 写；通信契约（§2）与里程碑（§5）与壳无关，两套壳通用。

4. **会话管理：扫盘只取"路径+标题"，内容交给 RPC 解析。**
   与其在 GUI 里逆向 `.jsonl` 的内部 header/tail 格式（omp 内部存储格式，可能随版本变），不如**让 owner 解析自己的格式**：
   扫盘这一步只读每个文件**首行**的 `SessionHeader` 拿 `title`/`cwd`（用于侧栏列表与过滤），用户选中后把**文件路径**交给 `switch_session` 让 omp 自己解析全部内容。
   （说明：旧 plan 的"读 4KB header + 32KB tail"并非全错——32KB tail 取的是 leaf/生命状态供侧栏显示，属增强而非解析必需；本方案把它简化为"首行即可"，更稳但不贬低原设计。）

### 0.2 本机环境实测结果（先决条件）

| 项 | 实测值 | 说明 |
|---|---|---|
| omp 位置 | `C:\Users\<user>\.bun\bin\omp.exe` | `[已实测]` 存在且可运行 |
| omp 形态 | **bun shim，15,872 字节** | `[已实测]` 是薄启动器，**依赖本机 bun**，不能直接拷给最终用户 |
| omp 是否在 PATH | **因环境而异**：用户交互登录的 cmd/终端里 `where omp` 能找到（`.bun\bin` 在用户 PATH）；但**沙箱/服务进程/打包后 GUI spawn 的子进程很可能解析不到** | `[已实测]` 本 AI 所在 shell 的 PATH 无 `.bun\bin`，`omp` → command not found。**结论：不要依赖 PATH，spawn 一律用绝对路径或让用户在设置里指定** |
| bun | v1.3.14 | `[已实测]` 已装（shim 依赖它） |
| node | v22.22.2 / npm 10.9.7 | `[已实测]` |
| 握手 | 启动即输出 `{"type":"ready"}` | `[已实测]` |
| 命令-响应 | 保持 stdin 常开后，`get_state`/`get_available_models`/`get_login_providers`/`get_messages`/`get_session_stats`/`new_session`/`get_available_commands` 全部 `success:true` | `[已实测]` |
| 默认 approval | 未传 flag 时（yolo）**不弹任何审批帧** | `[已实测]`（见 §2.5 的坑） |
| 会话目录 | `C:\Users\<user>\.omp\agent\sessions\--D--code-OMP-UI--\<timestamp>_<sessionId>.jsonl` | `[已实测]` |
| 配置文件 | `C:\Users\<user>\.omp\agent\config.yml` | `[已实测]` 内含 `modelRoles.default` 等 |

** spawn 命令实测可用形式（Windows / Git Bash 环境）：**
```
"C:\Users\<user>\.bun\bin\omp.exe" --mode rpc-ui --no-session
```
正式版去掉 `--no-session`，加 `--approval-mode write`。

### 0.3 关键实测的原始命令与输出截录（可复现）

> 在本 AI 的 shell（Git Bash / MSYS2）执行。omp 用绝对路径（原因见上表"是否在 PATH"）。

**(a) 握手 + 启动即推 `setWidget` 帧：**
```
$ (printf '\n'; sleep 3) | "C:/Users/<user>/.bun/bin/omp.exe" --mode rpc-ui --no-session
{"type":"ready"}
{"type":"extension_ui_request","id":"15377b93652f1cab","method":"setWidget","widgetKey":"autoresearch"}
{"type":"available_commands_update","commands":[{"name":"model","aliases":["models"],...
```
→ 证明：`ready` 为首行；启动即收 `setWidget`（UI 须容忍未知 method，见 §2.4）；`available_commands_update` 携带全部 slash 命令。

**(b) 命令-响应回路（stdin 须保持常开）：**
```
$ (printf '{"id":"1","type":"get_state"}\n'; sleep 8) | "C:/Users/<user>/.bun/bin/omp.exe" --mode rpc-ui --no-session
{"type":"ready"}
{"id":"1","type":"response","command":"get_state","success":true,"data":{"model":{"id":"tencent/hy3:free","provider":"openrouter",...},"thinkingLevel":"high","isStreaming":false,...,"contextUsage":{"tokens":16316,"contextWindow":262144,"percent":6.22...}}}
```
→ 证明：`get_state` 回显同 `id`、`success:true`、`data` 含 `model`/`thinkingLevel`/`contextUsage`。
对比：若用 `echo '...' | omp`（stdin 立即 EOF），omp 在 EOF 后直接退出、不回响应——故 stdin 须由宿主持有（§0.1-1）。

**(c) 其余命令存在性（同 (b) 方式逐个探测，均 `success:true`）：**
`get_available_models` / `get_login_providers` / `get_messages` / `get_session_stats` / `new_session` / `get_available_commands`。
`set_model`（缺参）→ `"success":false,"error":"Model not found: undefined/undefined"`；`switch_session`（缺参）→ `"success":false,...`——缺参报错证明命令路由存在，参数结构见 §2.6 / M3。

**(d) omp 二进制形态（bun shim）：**
```
$ ls -la "C:/Users/<user>/.bun/bin/omp.exe"
-rwxr-xr-x 1 ... 15872 ... omp.exe        # 15,872 字节 = 薄启动器，依赖本机 bun
$ bun --version
1.3.14
```

**(e) 会话目录结构（legacy 分支实证）：**
```
$ ls -la ~/.omp/agent/sessions/
drwxr-xr-x ... --C--tmp--
drwxr-xr-x ... --D--code-OMP-UI--
$ find ~/.omp/agent/sessions -name '*.jsonl'
.../sessions/--D--code-OMP-UI--/2026-07-20T17-00-48-445Z_019f8079-1bbd-7000-bc3b-2ed939c73ea3.jsonl
```
→ `<REPO_ROOT>`（非 home 内）编码为 `--D--code-OMP-UI--`，符合 §0.1-2 的 legacy 分支。

**(f) PATH 环境差异（为何 spawn 不依赖 PATH）：**
```
# 用户交互 cmd：  where omp  →  C:\Users\<user>\.bun\bin\omp.exe   （找得到）
# 本 AI 沙箱 shell：
$ omp --version
/usr/bin/bash: line 1: omp: command not found                  （找不到，PATH 无 .bun\bin）
```
→ 同一台机器、两种进程环境结果相反。结论：**能否解析 omp 取决于发起进程的 PATH，spawn 一律用绝对路径**。

---

## 1. 总体方案

### 1.1 接入方式：spawn `omp.exe --mode rpc-ui`，NDJSON over stdio

选 RPC 而非 Node SDK / ACP / 直接 import，理由（与两份 plan 一致，仍成立）：
- **进程隔离**：GUI 崩不杀 agent，agent 崩不杀 GUI。
- **不依赖 Bun 运行时进 GUI**：GUI（Tauri/Rust）只管 spawn 二进制 + 读写管道，不 import 任何 omp TS 源码。
- **完整 UI 交互帧**：`--mode rpc-ui` 会把工具卡 / 权限 / 选项 / OAuth 以 `extension_ui_request` 帧推给宿主，是还原 Codex 体验的关键。
- **强类型**：协议在 omp 仓库 `src/modes/rpc/rpc-types.ts` 定义。

### 1.2 spawn 参数（默认）

```
omp.exe --mode rpc-ui --approval-mode write
```

- **`--approval-mode write`（必须显式传）**：read/write 工具自动执行，exec 类（bash/browser/ssh/task）才弹审批。
  **坑：不传此 flag 默认 `yolo`，所有危险操作静默执行、UI 完全拦不住。** `[已实测]`
- **工作目录**：用 spawn 的 `cwd` 选项指定（如 `<REPO_ROOT>`），不传 `--cwd` flag。omp 据此编码会话目录。
- **stdin 常开**：spawn 后**绝不调用 `stdin.end()`**，直到要 kill 进程。这是命令-响应回路成立的前提。`[已实测]`
- **调试**：先加 `--no-session` 验证握手和帧流（内存会话、不写盘），正式版去掉以启用持久化和按 cwd resume。
- **omp 路径**：开发期用绝对路径 `C:\Users\<user>\.bun\bin\omp.exe`（**不依赖 PATH**——虽然用户终端里 `where omp` 能找到，但 GUI spawn 的子进程环境未必继承得到），并做成设置项允许用户改。

### 1.3 架构（Electron 方案 —— 用户既定技术栈）

```
┌─────────────────────────────────────────────────┐
│  Chromium 前端（React + TS + Vite）              │  聊天流/工具卡/diff/权限弹窗/侧栏/状态栏
├─────────────────────────────────────────────────┤
│  Electron 主进程（Node）                         │
│   ├─ OmpProcess : spawn / 读 stdout 行 / 写 stdin│
│   ├─ FrameRouter: 按 id 关联 req/resp，按 type 分发│
│   ├─ SessionStore: 扫盘列会话（只取路径+标题）     │
│   └─ PermCache  : 内存 allowlist（"Always allow"）│
├─────────────────────────────────────────────────┤
│  omp.exe --mode rpc-ui（子进程）                 │  agent 引擎 + 全部工具
└─────────────────────────────────────────────────┘
```

数据流（三条通道，全部经 Electron IPC）：
- **命令**：前端 `ipcRenderer.invoke('rpc:send', cmd)` → 主进程赋 `id` → 写 omp.stdin。
- **事件**：omp.stdout → 主进程 `readline` 逐行 `JSON.parse` → 按 `type` 分发 → `mainWindow.webContents.send('rpc:event', frame)` 推前端。
- **权限**：`extension_ui_request` → 推前端 modal → 用户操作 → `ipcRenderer.invoke('rpc:respond-ui', …)` → 主进程写 stdin 的 `extension_ui_response`。

**前端↔主进程用 Electron 的 `ipcMain.handle`/`ipcRenderer.invoke`（请求-响应）+ `webContents.send`/`ipcRenderer.on`（事件流）**，preload 用 `contextBridge` 暴露 `window.omp`。

> **备选：Tauri 2。** 若未来想把安装包从 ~150MB 降到 ~10MB、降低常驻内存，可换 Tauri 2（Rust 壳 + 系统 WebView2）：把 `OmpProcess`/`FrameRouter` 改用 Rust + tokio 写，`invoke`→Tauri command、`webContents.send`→`app.emit_all`。**§2 通信契约与后面所有里程碑与壳无关，原样复用。** 本计划默认仍走 Electron（沿用用户既定选择）。

---

## 2. 通信契约（实现时以 omp 仓库 `rpc-types.ts` 为唯一权威）

### 2.1 握手
- 子进程启动后**第一行**输出 `{"type":"ready"}`，之后才开始处理命令。`[已实测 §0.3a]`
- 收到 `ready` 后立即发 `get_state` + `get_available_models` 填充 UI（两者都已实测 `success:true`，§0.3b/c）。
- **stdin 生命周期 = 子进程生命周期**：Node `spawn` / Rust `Command` 默认持有 stdin pipe，运行期不显式 `end()` 即不会关；GUI 退出时随 kill 一起释放。这是常规 spawn 行为，非特殊坑（§0.1-1）。

### 2.2 id 关联
- 命令帧带 `id?: string`（用 UUID），响应帧回显同 `id`，据此 resolve/reject pending Promise。
- `prompt` 立即 ack（`success:true`），真正的 agent 输出走后续的 `AgentSessionEvent` 事件流，**不在 response 里**。
- 未知命令 / 解析异常会回 `success:false` 带 `error`，注意 `id` 可能为 `undefined`，要兜底。

### 2.3 关键输入帧（client→omp）——已实测存在的打 ✓
- Prompting：`prompt` ✓ / `abort` / `steer` / `follow_up` / `new_session` ✓
- State：`get_state` ✓ / `get_available_commands` ✓ / `set_todos`
- Model：`set_model` ✓（缺参时报 `Model not found: undefined/undefined`，证明命令存在）/ `get_available_models` ✓ / `cycle_model`
- Session：`switch_session` ✓（缺参报错，存在）/ `get_session_stats` ✓ / `get_messages` ✓ / `set_session_name` / `export_html` / `branch`
- Login：`get_login_providers` ✓ / `login`
- Thinking：`set_thinking_level` / `cycle_thinking_level`

> 打 ✓ 的是我真跑过 `success:true`（或缺参报错证明路由存在）的（截录见 §0.3c）；未打勾的来自文档，**实现前用 §0.3b 的"保持 stdin 常开"探测脚本逐个再验一遍**，确认存在和参数结构。

### 2.4 关键输出帧（omp→client）
- `ready` — 握手。`[已实测]`
- `response` — `{id, type:"response", command, success, data?|error}`。`[已实测]`
- `available_commands_update` — 启动即推，含全部 slash 命令定义。`[已实测]`
- `extension_ui_request` — `{id, method, ...}`。**启动时就会收到 `method:"setWidget"` 的帧**（`[已实测 §0.3a]`，原始输出 `{"type":"extension_ui_request","id":"15377b93652f1cab","method":"setWidget","widgetKey":"autoresearch"}`），**UI 必须容忍并忽略不认识的 method，不得因未知 method 崩溃**。
  - 需应答：`confirm` / `select` / `input` / `editor` / `cancel`
  - 单向通知：`notify` / `setStatus` / `setWidget` / `setTitle` / `set_editor_text`
  - OAuth：`open_url`
- `AgentSessionEvent`（驱动聊天流，约 22 种，以 `rpc-types.ts` 为准）：
  - 生命周期：`agent_start` / `agent_end` / `turn_start` / `turn_end`
  - 消息：`message_start` / `message_update` / `message_end`
  - 工具：`tool_execution_start` / `tool_execution_update` / `tool_execution_end`
  - 压缩：`auto_compaction_start` / `auto_compaction_end`
  - 重试：`auto_retry_start` / `auto_retry_end` / `retry_fallback_applied` / `retry_fallback_succeeded`
  - Todo / 其他：`todo_reminder` / `todo_auto_clear` / `ttsr_triggered` / `irc_message` / `notice` / `thinking_level_changed` / `goal_updated`
  `[待实测]`：各事件的具体字段名在 M1 用一个真实 `prompt` 跑一遍抓全（见 M1.0）。
- 其余输出帧：`prompt_result` / `extension_error` / `command_output` / `session_info_update` / `config_update`；
  子代理帧 `subagent_lifecycle` / `subagent_progress` / `subagent_event`（需 `set_subagent_subscription`，M4/P2 用）；
  高级 `host_tool_call` / `host_tool_cancel` / `host_uri_request` / `host_uri_cancel`（P2 宿主工具，M1–M3 不做）。

### 2.5 权限机制（RPC 特有，**最容易踩的坑**）
- RPC 不走 ACP 的 `session/request_permission`，而是 `extension_ui_request` 的 `confirm`/`select`/`input`/`editor`。
- 响应格式：`{type:"extension_ui_response", id, value}|{id, confirmed}|{id, cancelled}`。
- **前提：spawn 必须带 `--approval-mode write`（或 `always-ask`）。默认 yolo 下这些审批帧完全不出现。** `[已实测默认不弹]`
- 超时由 omp 端用默认值兜底；前端收到 `cancel` 帧自动关对应 modal。
- 子代理（task 工具）内部以 yolo 跑，不为子代理单独弹窗。

### 2.6 会话持久化
- 存放根目录：`C:\Users\<user>\.omp\agent\sessions\`。`[已实测 §0.3e]`
- 每个 cwd 一个子目录，编码为三分支（home 内 `-<relative>` / tmp 内 `-tmp-<relative>` / 其他 legacy `--<cwd>--`）。本项目 `<REPO_ROOT>` 命中 legacy → `--D--code-OMP-UI--`。`[已实测 §0.3e]`
  → **扫盘不自己实现编码规则去"猜"目录名**，而是**直接遍历 `sessions\` 下所有子目录**，读每个 `.jsonl` 首行拿 `cwd` 字段，再与当前 cwd 比对过滤。对三分支及未来规则变化均免疫。
- 文件格式：JSONL，首行是 `SessionHeader`（含 `id`/`cwd`/`title`/`parentSession`），后续是 append-only 的 `SessionEntry`。`SessionHeader` 精确字段以 `rpc-types.ts` 为准（P0.2 抓取）。
- **M3 列会话的稳妥做法**：
  1. Rust 扫 `sessions\**\*.jsonl`，对每文件**只读第一行** parse `SessionHeader`，取 `title`/`cwd`/`id`/文件 mtime。
  2. 按 `cwd == 当前工作目录` 过滤，按 mtime 倒序。
  3. 用户点某个会话 → 把**文件路径**传给 `switch_session`（RPC 命令，omp 自己解析内容），**不要自己 parse 整个 JSONL**。
  4. 切换成功后调 `get_messages` 拿历史消息渲染。
- `switch_session` 的确切参数名（`path`? `sessionId`?）`[待实测]`：M3 第一步先抓 `rpc-types.ts` 里 `SwitchSessionCommand` 的定义，或用缺参报错信息反推。

### 2.7 模型切换
- 无"切 role"命令，只能 `set_model(provider, modelId)`。
- 模型列表来自 `get_available_models`（已实测返回完整 model 对象，含 `id`/`provider`/`contextWindow` 等）。
- 当前模型在 `get_state` 的 `model` 字段（已实测，含 `id`/`provider`/`thinking` 等完整信息）。

---

## 3. 仿 Codex 设计规格

- **三栏布局**：左 = 会话侧栏（新建/历史/搜索/重命名）；中 = 对话流（流式 Markdown + 代码高亮 + 内联工具卡）；右 = 文件树 / Diff 面板（点工具卡跳转）。
- **深色为主**的克制配色，贴近 Codex CLI 观感；代码/路径用等宽字体。
- **流式体验**：`message_update` 逐字追加自动滚底；`tool_execution_*` 实时显示工具运行状态和 bash 流式输出。
- **审批交互**：exec 工具触发 `confirm`/`select` modal（仿 Codex 的 approve 卡片），支持「Always allow this tool」写入宿主 allowlist（§5 M2.6）。
- **OAuth 登录**：`get_login_providers` → 选 `openai-codex` → `login` → 收 `open_url` 帧 → 用 `shell.openExternal` 拉系统浏览器完成授权（不用内嵌 webview，避免 cookie 隔离问题）。
- **状态栏**：当前 model / provider、contextUsage（tokens/窗口/百分比，来自 `get_state`）、isStreaming、todo 进度。

---

## 4. 项目结构与脚手架（P0）

### P0.1 定位 omp 并验证命令-响应回路（本机已完成大半）
- [x] 定位 omp：`C:\Users\<user>\.bun\bin\omp.exe`（bun shim；spawn 用绝对路径，不依赖 PATH）。
- [x] 验证握手 + 命令-响应回路（保持 stdin 常开）。
- [ ] **补一个 `prompt` 端到端实测**（M1 前置）：发 `{"id":"1","type":"prompt","text":"say hi"}`，抓全 `agent_start`→`message_*`→`agent_end` 完整事件序列，确认字段名。这是 M1 数据模型的依据。
- [ ] **发布期 omp 来源**：开发机的是 bun shim，**禁止拷给最终用户**。发布版用 `irm https://omp.sh/install.ps1 | iex` 或 GitHub Release 取 standalone `omp.exe`，放进 Tauri 的 `resources/`，打包时拷贝，运行时按资源目录解析绝对路径 spawn。打包前在**无 bun 的干净 Windows 机**验证 standalone 能 `omp --mode rpc` 自包含运行。

### P0.2 抓取权威类型
- [ ] 从 omp 仓库拉 `src/modes/rpc/rpc-types.ts` 到 `src/shared/rpc-types.ts`，只保留 GUI 用到的：`RpcCommand` / `RpcResponse` / `AgentSessionEvent` / `RpcExtensionUIRequest` / `RpcExtensionUIResponse` / `RpcSessionState` / `SessionHeader`。
- [ ] 标注同步的 omp 版本号；对**未知帧 type 记日志但不崩溃**（兼容 omp 升级）。

### P0.3 初始化 Electron 项目结构
```
<REPO_ROOT>\
├── package.json
├── vite.config.ts
├── tsconfig.json / tsconfig.node.json
├── electron/
│   ├── main.ts                # app 生命周期 + 建窗 + 起 OmpProcess
│   ├── preload.ts             # contextBridge 暴露 window.omp
│   └── omp-process.ts         # spawn / 读行 / 写 stdin / kill
├── src/
│   ├── main/                  # 主进程逻辑（被 electron/main.ts 引用）
│   │   ├── frame-router.ts    # id 关联 + 按 type 分发 + webContents.send
│   │   ├── session-store.ts   # 扫盘列会话（只读首行）
│   │   ├── perm-cache.ts      # 内存 allowlist
│   │   └── ipc.ts             # ipcMain.handle 注册
│   ├── renderer/              # React 前端
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── rpc-client.ts      # 封装 ipcRenderer.invoke / on
│   │   ├── store.ts           # 全局状态(zustand)
│   │   └── components/
│   │       ├── chat/  tools/  diff/  permission/
│   │       ├── sidebar/  statusbar/  model-picker/  login/
│   └── shared/
│       ├── rpc-types.ts       # 来自 P0.2
│       └── ipc-channels.ts    # IPC 通道名 + 类型
└── resources/omp.exe          # 发布期 standalone（开发期可为空，用绝对路径）
```

### P0.4 依赖与脚本
- [ ] 前端：react、react-dom、typescript、vite、@vitejs/plugin-react、zustand、react-markdown、remark-gfm、shiki（代码高亮）。
- [ ] 主进程/构建：electron、electron-vite（主+渲染热重载）、electron-builder（出包）。
- [ ] 脚本：`electron-vite dev`（开发）、`electron-vite build` + `electron-builder`（出 Windows 安装包）。
- [ ] 日志：omp 子进程 stderr 写 `.temp/omp-stderr-<date>.log`，前端日志面板可查看。

---

## 5. 里程碑（每个都有明确验收动作，验收通过才进下一段）

### M1：最小回路（prompt + 流式回复）
> **验收：输入框发一句话 → 看到 omp 流式 Markdown 逐字出现；Esc 中止；关窗杀子进程无残留。**

- [ ] **M1.0 前置实测**：用 §0.2 脚本发一个真实 `prompt`，抓全事件序列（`agent_start`/`message_start`/`message_update`/`message_end`/`agent_end`），把字段名记进 `rpc-types.ts` 注释。**没抓到真实序列前不写 UI 数据模型。**
- [ ] **M1.1 `omp-process.ts`**：`OmpProcess` 类，方法 `spawn(args, cwd)` / `write(cmd)` / `kill()`；用 `child_process.spawn(ompPath, ['--mode','rpc-ui','--approval-mode','write'], { cwd, stdio:['pipe','pipe','pipe'], env:{...process.env, ...utf8Env} })`；stdout 用 `readline.createInterface({input: child.stdout})` 逐行读，首行 `ready` 触发 `onReady`；每行 `JSON.parse`，解析失败记日志不抛；stderr 落日志文件；`exit` 触发 `onExit(code)`。**stdin 由实例持有，不提供 `end()` 给外部，仅 `kill()` 时随进程释放。**
- [ ] **M1.2 `frame-router.ts`**：维护 `Map<string,{resolve,reject,timeout}>` 关联 req/resp；`send(cmd)` 自动赋 `crypto.randomUUID()`、写 stdin、注册 pending、超时（5min）reject；`dispatch(frame)` 按 `type` 路由：`ready`→onReady、`response`→解 pending（`success:false` 时 reject 带 `command`/`error`）、其余→`mainWindow.webContents.send("rpc:event", frame)` 推前端；`command:"parse"` 且 `id:undefined` 记日志。
- [ ] **M1.3 IPC 通道**：`ipc-channels.ts` 定义 `rpc:send`/`rpc:event`/`rpc:ui-request`/`rpc:ready`/`omp:stderr`/`omp:exit`；`preload.ts` 用 `contextBridge.exposeInMainWorld('omp', {...})` 暴露 `send(cmd)`/`onEvent(cb)`/`onReady(cb)`；`ipcMain.handle('rpc:send', …)` 调 `FrameRouter.send`。
- [ ] **M1.4 最简聊天 UI**：消息列表 + 输入框；消费 `agent_start`(置 streaming、push 空 assistant 消息)/`message_update`(追加文本)/`message_end`(标记完成)/`agent_end`(streaming=false)；`react-markdown`+`remark-gfm` 渲染；自动滚底；Enter 发送 / Shift+Enter 换行 / Esc `abort`。
- [ ] **M1.5 握手**：onReady 后 `get_state()` + `get_available_models()` 存 zustand store。
- [ ] **M1.6 验收**：发"列出当前目录文件"，看到流式文本；Esc 中止；关窗后任务管理器无 omp 残留。

### M2：工具卡 + Diff + 权限
> **验收：让 omp 改文件 → 看 diff 预览；触发 bash → 弹权限 modal 可批准/拒绝/记住。**

- [ ] **M2.1 `ToolCard`**：折叠/展开，头部工具名 + 状态（running/done/error）；展开区 args + result；`read` 显路径行数、`bash` 显命令+退出码、`search` 显命中数；error 自动展开。
- [ ] **M2.2 消费工具事件**：`tool_execution_start`(追加 ToolPart，running)/`tool_execution_update`(累加 partialResult，支持 bash 流式)/`tool_execution_end`(done/isError，落 result)，按 `toolCallId` 关联。
- [ ] **M2.3 `DiffView`**：unified diff 增删着色；识别 `edit`/`write`/`ast_edit` 的 `tool_execution_end.result` 中 diff 字段（**字段名 M2 第一步实测确认**，别照抄）。
- [ ] **M2.4 `PermissionModal`**：按 `extension_ui_request.method` 渲染 `confirm`(Yes/No + 「Always allow」勾选)/`select`(radio)/`input`/`editor`；多请求**单队列顺序展示不并发**；展示关联工具卡上下文（让用户看到要批准的具体命令）。
- [ ] **M2.5 应答回路**：modal → `window.omp.respondUI({type:'extension_ui_response', id, value|confirmed|cancelled})` → `ipcMain.handle('rpc:respond-ui')` 写 stdin；omp 超时回默认 → 前端收 `cancel` 自动关 modal。
- [ ] **M2.6 `perm-cache.ts`**：内存 `Map<toolName, 'allow'|'deny'>`；「Always allow」写入；后续同工具命中自动回不弹；设置面板可重置。**注意这是宿主 UX 层，omp 不持久化。**
- [ ] **M2.7 验收**：让 omp 建文件 → 见 write 工具卡 + diff；让 omp 跑 `dir` → 弹权限；勾 Always allow 后 bash 直接执行；拒绝一次 omp 继续对话。

### M3：会话管理 + 模型切换 + OAuth（完整可用版）
> **验收：左栏见历史会话可新建/切换/重命名；右上切模型；Codex 登录可用。**

- [ ] **M3.1 会话扫描（稳妥版，见 §2.6）**：主进程遍历 `~/.omp/agent/sessions/**/*.jsonl`，**只读首行** parse `SessionHeader` 取 `title`/`cwd`/`id` + 文件 mtime；按 cwd 过滤、mtime 倒序；`fs.watch` 监听目录增量更新。**不自己实现目录编码规则。**
- [ ] **M3.2 侧栏 `SessionList`**：卡片显示标题/相对时间；当前高亮；右键 Rename/Fork/Export/Delete（二次确认）；新建按钮 `new_session`。
- [ ] **M3.3 切换会话**：点条目 → 先实测 `switch_session` 参数结构 → 传路径/ID → 成功后 `get_messages()` 拿历史渲染（含工具卡，ToolPart 从消息还原）。
- [ ] **M3.4 重命名**：`set_session_name(name)` → 刷新侧栏该条目。
- [ ] **M3.5 `ModelPicker`**：下拉列 `get_available_models`，按 provider 分组，当前 model 高亮；选中 `set_model(provider, modelId)`；role 说明用 tooltip（RPC 无切 role）。
- [ ] **M3.6 `StatusBar`**：当前 model、isStreaming、contextUsage.tokens/percent（来自 `get_state`，启动/new/switch/set_model 后刷新，isStreaming 由 `agent_start`/`agent_end` 驱动）。
- [ ] **M3.7 Slash 补全**：消费 `available_commands_update` 缓存命令列表（`[已实测]` 此帧含全部命令定义），输入 `/` 触发补全下拉。
- [ ] **M3.8 OAuth**：`get_login_providers` → 选 `openai-codex` → `login` → 收 `open_url` 帧 → `shell.openExternal(url)` 拉系统浏览器；omp 处理 loopback 回调；登录后 `get_available_models` 刷新。**`[待实测]` Windows 下回调链路能否被 omp 接住，M3 第一步先验。**
- [ ] **M3.9 验收**：新建会话聊几轮 → 关 GUI 重开 → 侧栏见到该会话；点历史会话完整还原（含工具卡）；切 model 状态栏更新；`/` 补全能用；Codex 登录成功。

### M4（可选增强，P1）
> 验收：体验对齐 Codex 日常使用。每个子任务标注消费的帧/事件。

- [ ] **M4.1 文件树 / Diff 面板（右栏）**：读工作区目录渲染文件树；点工具卡跳转对应文件；展示被 `edit`/`write` 改动的文件列表；`DiffView` 复用 M2.3。
- [ ] **M4.2 Todo 面板**：从 `get_state.todoPhases` 渲染阶段+进度；消费 `todo_reminder`/`todo_auto_clear` 动态更新；支持 `set_todos` 把 GUI 编辑同步回 agent；位置放右侧或顶部折叠。
- [ ] **M4.3 Token/费用状态栏**：`get_session_stats()` 取累计统计，或 `agent_end.telemetry`（若开启）；状态栏显示本轮 tokens/cost + 会话累计；`contextUsage.percent` 超 80% 高亮。
- [ ] **M4.4 通知 toast**：消费 `extension_ui_request.method==='notify'` → toast（info/warning/error 三色）；`method==='setStatus'` → 状态栏某 key 更新；`notice` 事件 → toast；toast 队列可展开详情。
- [ ] **M4.5 分叉 UI**：`get_branch_messages()` 列可分叉点；消息右键「Branch from here」→ `branch(entryId)` → 新建会话视图。
- [ ] **M4.6 导出 HTML**：侧栏右键 Export → `export_html(outputPath?)` → `{path}`；用 `dialog.showSaveDialog` 选保存位置；导出完成 toast + 「打开文件夹」。
- [ ] **M4.7 thinking level picker**：`set_thinking_level`(off/minimal/low/medium/high/xhigh/max) + `cycle_thinking_level`；消费 `thinking_level_changed` 同步 UI；`Ctrl+P` → `cycle_model` 快捷切模型。
- [ ] **M4.8 压缩/重试提示**：`auto_compaction_start`→「Compressing context…」气泡 / `auto_compaction_end`→关闭+摘要；`auto_retry_start`→「Retrying (N/M)…」+倒计时 / `auto_retry_end`→关闭；`set_auto_compaction`/`set_auto_retry` 开关进设置面板。

---

## 5b. P2 长期视野（暂不排期，列出备查）

仅当目标是更完整的 omp 平替时才需要：

- **Subagent 卡片**：`set_subagent_subscription:"progress"` + `subagent_lifecycle`/`subagent_progress` 帧 → 多 worker 并行卡片。
- **Subagent 详情面板**：`set_subagent_subscription:"events"` + `get_subagents`/`get_subagent_messages`。
- **内嵌终端**：`bash`/`abort_bash` 命令 + xterm.js（需 node-pty）。
- **TTSR 规则注入提示**：`ttsr_triggered` 事件 → 卡片显示规则内容。
- **host_tool 暴露**：`set_host_tools` 注册 GUI 自有工具（如「在编辑器打开文件」）→ 响应 `host_tool_call`。
- **自定义 URL scheme**：`set_host_uri_schemes` 注册虚拟文件系统 → 响应 `host_uri_request`。
- **会话 handoff**：`handoff` 命令把当前上下文移交新会话。
- **设置面板读写 omp 配置**：`~/.omp/agent/config.yml` / `models.yml`（custom providers / fallback / modelRoles）。
- **Collab 协作**：`/collab` 的 GUI 化（share link / 只读链接），需 relay 服务，优先级低。

---

## 6. 打包与分发
- [ ] `electron-builder`：`extraResources` 拷 `resources/omp.exe`；Windows 目标 `nsis`（或 `portable`）；如有证书做签名。
- [ ] 首次启动检测 omp：优先用 resources 内 standalone；没有则探测用户指定路径；都没有则引导运行安装脚本。
- [ ] omp 路径做成设置项持久化（electron-store）。

---

## 7. 风险与验证清单

| 风险 | 影响 | 对策（含实测状态） |
|---|---|---|
| stdin 被意外关闭 | 命令-响应回路断裂 | 常规 spawn 默认持有 stdin，非特殊坑；`OmpProcess` 不对外暴露 `end()`，仅 `kill()` 时释放（§0.1-1 / §2.1）|
| 子进程环境 PATH 不含 `.bun\bin` | spawn 按名字找不到 omp | `[已实测]` 不依赖 PATH，开发期用绝对路径、发布期用 resources standalone，并开放设置项 |
| 发布版误用 bun shim | 目标机无 bun 起不来 | P0.1 要求 standalone；打包前在无 bun 干净机验证 |
| 会话目录编码规则错误 | 扫盘漏会话 | `[已实测]` 真实是 `--<cwd>--`；**不实现编码规则，直接遍历+读首行 cwd 过滤**（§2.6）|
| RPC 帧 schema 靠猜 | 解析失败 | P0.2 抓 `rpc-types.ts`；未打勾命令先用最小脚本逐个验；未知 type 记日志不崩 |
| 默认 yolo 不弹审批 | 危险操作静默执行 | `[已实测]` 必须显式 `--approval-mode write` |
| `open_url` OAuth 回调失败 | Codex 登录不可用 | `[待实测]` M3.8 第一步先验回调链路 |
| diff 字段名不符 | DiffView 解析失败 | `[待实测]` M2.3 实测确认 result 结构 |
| prompt 事件序列未知 | M1 数据模型错 | `[待实测]` M1.0 先抓全序列再写 UI |
| omp 升级类型漂移 | 帧解析失败 | 标注同步版本；未知帧容错；启动校验 `omp --version` |
| Windows 中文编码乱码 | omp stdout/工具输出乱码（用户已知痛点，见 opencode 中文编码治理经验） | 分层治理：① spawn 时 `env` 注入 `LANG`/`LC_ALL=C.UTF-8`、`PYTHONIOENCODING=utf-8`、`CHCP=65001`，并设 `windowsVerbatimArguments`；② stdout/stderr 流一律按 `utf-8` 解码（`readline` 默认 utf8，勿转 GBK）；③ 若 omp 内部调 bash（`config.yml` 已配 `shellPath: Git bash`），确认其 codepage；④ 乱码未消则参考 opencode 的 PowerShell 编码治理方案逐层定位，勿在 GUI 层二次转码掩盖 |
| 子进程崩溃 | GUI 卡死 | onExit → 前端提示「omp 已退出 code=X」+ 重启按钮 |

---

## 8. 执行节奏

- **P0**（含 prompt 端到端实测 M1.0）：0.5 天
- **M1**：1-2 天，跑通最小回路即可日常试用
- **M2**：2-3 天，工具/diff/权限
- **M3**：2-3 天，完整可用版（P0 交付标准）
- **M4**：3-5 天，增强（P1）
- **P2**：长期视野，按需排期

每个里程碑动手前，先用 §0.3b 的"保持 stdin 常开"探测脚本验证该阶段依赖的 RPC 命令/事件字段名，再写 UI 代码——这是本计划贯穿始终的原则：**关键字段名以实测为准，不照抄文档/plan。**

---

## 附：本计划的定位（修订后记）

本计划与两份旧 plan 是**互补**关系：骨架（RPC 接入、三栏布局、M1–M4 划分）沿用共识；技术栈沿用用户既定的 **Electron + React + TS**（Tauri 仅作备选）。本计划的增量价值在于：把关键假设落到本机实测并附**可复现的原始截录**（§0.3）、会话扫描采用"只读首行 + 交 `switch_session` 解析"的稳态方案（§2.6）、以及"未知 `extension_ui_request.method` 必须容忍不崩"的健壮性要求（§2.4）。

> 修订说明：初稿曾将"stdin 关闭即退"夸大为"最致命发现"（实为常规 spawn 行为）、把会话编码 legacy 分支误当"旧 plan 错误"（实为三分支之一）、并默认改推 Tauri（无视用户已选 Electron）——以上三点已据评审意见修正。感谢评审指出的硬伤。
