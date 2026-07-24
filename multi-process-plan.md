# OMP-UI 多 omp 进程池 · 实施计划

> 目标：实现"切换会话不中断之前的会话"，每个活跃会话绑定独立 omp 进程，进程池上限 5（可配），懒加载。

## 1. 现状与痛点

当前（v0.1.18）是**单 omp 进程**架构：

- `main.ts` 全局唯一 `omp: OmpProcess | null` + `router: FrameRouter`。
- 所有 RPC 命令经 `IPC.RpcSend` 发到这唯一进程。
- omp 是**单进程单 agent 模型**：agent run 绑定 current session。`switch_session` / `new_session` 切换 current 会**丢弃正在生成的会话**（2026-07-24 probe 实测确认）。
- renderer 侧用 `ompCurrentPath` "猜"帧属于哪个会话——是 hack，因为帧本身不带会话标识。

**痛点**：切会话 = 丢会话。v0.1.18 的"看历史不中断"只解决了"查看历史不切 omp current"，但**对目标会话发消息**那一刻仍会 `switchSession` → 中断旧会话。要真正并发多任务生成，必须多进程。

## 2. OMP 多实例可行性（已验证）

查 `omp --help`：

- omp **没有**"最多 5 个实例"的内置硬限制。每个进程独立 spawn、独立 stdin/stdout、独立 current session，互不干扰。
- 多个进程默认共享 `~/.omp/agent/sessions/` 目录，但各写各的 `.jsonl` 文件，**无竞争**。
- `--profile` 会隔离 sessions（反而看不到），**不需要**用。默认 profile 共享 sessions 正好——用户在一个 workspace 能看到所有会话。
- "5 个实例懒加载"是**上层 OMP-UI 自己实现的进程池上限**，不是 omp 的限制。

**结论：完全可行。** omp 本身支持任意数量并发进程，5 是我们设的资源上限。

## 3. 目标架构

```
┌─────────────────────────────────────────────────────────┐
│ Renderer (React)                                        │
│  currentSessionPath = B（显示指针）                      │
│  sessionsMap[A] / sessionsMap[B] / sessionsMap[C]（缓冲）│
│  procStateMap[A/B/C] = online|offline|evicted          │
└───────────────┬─────────────────────────────────────────┘
                │ rpc:send(sessionPath, cmd)
                │ acquire(sessionPath, cwd)
                ▼
┌─────────────────────────────────────────────────────────┐
│ Main: OmpProcessPool (≤ 5)                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐    │
│  │proc A    │ │proc B    │ │proc C    │ │...(LRU)  │    │
│  │OmpProcess│ │OmpProcess│ │OmpProcess│ │          │    │
│  │+Router   │ │+Router   │ │+Router   │ │          │    │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └──────────┘    │
│       │            │            │                        │
│       └──── 帧带 __sessionPath 标记 ────┐                │
│                                         ▼                │
│              sendToRenderer(RpcEvent, {..frame, __sp})   │
└─────────────────────────────────────────────────────────┘
                │
                ▼
         ~/.omp/agent/sessions/
```

**核心不变式**：每个会话绑定一个独立 omp 进程，该进程的 current session 就是这个会话。切会话 = 切"跟哪个进程说话" + 切显示指针，**不切任何进程的 current**。

## 4. 分层改造

### 4.1 主进程（main.ts + 新增 omp-pool.ts）

**新增 `OmpProcessPool`**：

```ts
interface PoolEntry {
  sessionPath: string;
  cwd: string;
  approvalMode: ApprovalMode;
  proc: OmpProcess;
  router: FrameRouter;
  lastActiveAt: number;   // LRU 用
  state: 'spawning' | 'online' | 'evicted';
}
const MAX_POOL = 5;       // 可配
const pool = new Map<string /* sessionPath */, PoolEntry>();
```

**关键方法**：

- `acquire(sessionPath, cwd, approvalMode): Promise<PoolEntry>`
  - 池里有且 online → 更新 lastActiveAt，返回。
  - 池里有但 evicted → 重新 spawn（带 `-c` 续接该 session），ready 后返回。
  - 池里没有 → 若池满，LRU 淘汰最久未活跃的 idle 进程（kill 带 -c）；spawn 新进程（带 `-c` 续接），ready 后返回。
  - spawn 时 `cwd` 用该会话的 cwd（从 SessionSummary 拿）。
- `send(sessionPath, cmd): Promise<RpcResponse>` → 路由到对应 entry 的 router。
- `evict(sessionPath)` → 主动淘汰（用户关闭会话时）。
- `killAll()` → app 退出时清理所有。

**每个 entry 的事件帧带 sessionPath 标记**：

```ts
pushEvent: (frame) => sendToRenderer(IPC.RpcEvent, { ...frame, __sessionPath: entry.sessionPath })
```

**每个进程独立 onExit**：只标记该 entry `state: 'evicted'`，推 `OmpExit(sessionPath, code)` 给 renderer。**不影响其他进程**。不再有全局 `scheduleRespawn`——renderer 决定是否重新 acquire。

### 4.2 IPC 通道（ipc-channels.ts / preload.ts）

| 通道 | 现在 | 改成 |
|------|------|------|
| `RpcSend` | `(cmd)` | `(sessionPath, cmd)` |
| `RpcEvent` | `frame` | `frame + __sessionPath` |
| `RpcReady` | `()` | `(sessionPath)` |
| `OmpExit` | `(code)` | `(sessionPath, code)` |
| `OmpStderr` | `(line)` | `(sessionPath, line)` |
| `OmpCwd` | 全局 `(cwd)` | 删除（per-session cwd 由 SessionSummary 提供） |
| `OmpRestart` | `(cwd, mode, cont)` | `(sessionPath, cwd, mode, cont)` |
| **新增** `OmpAcquire` | — | `(sessionPath, cwd, approvalMode)` 懒拉起 |
| **新增** `OmpRelease` | — | `(sessionPath)` 主动释放 |

### 4.3 Renderer（store.ts / App.tsx / ChatView.tsx）

**store.ts**：

- **删除 `ompCurrentPath`**——不再需要猜。帧按 `frame.__sessionPath` 路由。
- `applyAgentEvent(frame)`：`targetPath = frame.__sessionPath`（不再 `?? currentSessionPath ?? ''`）。
- `sessionsMap[path] → ChatMessage[]` 保留（per-session 缓冲，已实现）。
- **新增** `procStateMap[path] → 'online' | 'offline' | 'evicted'`：每个会话的进程状态，驱动 Stop 按钮和侧栏指示。
- **新增** per-session `isStreaming` / `isAborting`：存到 `procStateMap[path]` 里，不再全局。Stop 按钮按当前会话状态。
- `loadSessionMessages` 保留（进程未拉起时显示磁盘历史）。

**App.tsx**：

- `onSelectSession(s)`：
  1. `setCurrentSessionPath(s.path)`。
  2. `messages = sessionsMap[s.path] ?? []`（已缓冲直接显示）。
  3. 若 `procStateMap[s.path] !== 'online'` → `loadSessionMessages(s.path)` 显示磁盘历史 + **可选** `acquire(s.path, s.cwd)` 预拉起进程（看是否要预热）。
  4. **不中断任何其他会话**。
- `onSend(text)`：
  1. `acquire(currentSessionPath, currentCwd)` 确保进程在线（lazy）。
  2. `appendUserMessage(text)`。
  3. `rpc.prompt(currentSessionPath, text)` → 路由到该会话进程。
  4. 帧带 `__sessionPath` 路由回 `sessionsMap[currentSessionPath]`，ChatView 实时显示。
- `onAbort()`：`rpc.abort(currentSessionPath)` → 只停当前会话进程，不影响其他。
- `onNewSession(cwd)`：创建新 session 文件 + spawn 新进程 + 设 currentSessionPath。
- 工作空间切换：每个会话独立 cwd，不再全局 restart。跨 cwd 会话天然支持（不同 cwd 不同进程）。

**ChatView.tsx**：基本不变，仍读 `messages`（已派生自 `sessionsMap[currentSessionPath]`）。

## 5. 关键交互流程

### 5.1 切会话（不中断）

```
用户点会话B → setCurrentSessionPath(B)
            → 显示 sessionsMap[B]（或磁盘历史）
            → A 的进程继续后台跑，帧 → sessionsMap[A]
            → B 若有在线进程，显示实时；否则显示磁盘历史
```

### 5.2 对会话B发消息（A 不受影响）

```
onSend(text) → acquire(B, B.cwd) [lazy spawn 若需]
             → appendUserMessage(text) → sessionsMap[B]
             → rpc.prompt(B, text) → B 进程
             → 帧带 __sessionPath=B → sessionsMap[B] → ChatView 实时
             [A 进程完全不受影响，继续后台跑]
```

### 5.3 新建会话

```
onNewSession(cwd) → rpc.newSession(新进程) → 拿到新 sessionPath
                  → acquire(newPath, cwd)
                  → setCurrentSessionPath(newPath), resetChat
```

### 5.4 LRU 淘汰（池满 5 个时开第 6 个）

```
acquire(F, ...) → 池满 → 找 lastActiveAt 最小的 idle 进程（如 E）
               → evict(E): kill(E) 带 -c（E 的 session 已 flush 到磁盘）
               → 推 OmpExit(E, 'evicted') → renderer 标 E 为 evicted
               → spawn(F) → entry F online
               → 用户下次点 E → acquire(E) → 重新 spawn 带 -c 续接 E 的历史
```

### 5.5 进程意外退出

```
proc A 崩溃 → onExit(A, code) → 推 OmpExit(A, code)
            → renderer 标 A 为 offline，保留 sessionsMap[A] 缓冲
            → 用户下次交互 A → acquire(A) → 重新 spawn 带 -c 续接
```

## 6. 数据结构变化

```ts
// store.ts
interface ProcState {
  status: 'online' | 'offline' | 'evicted' | 'spawning';
  isStreaming: boolean;
  isAborting: boolean;
  cwd: string;
  approvalMode: ApprovalMode;
  lastActiveAt: number;
}

interface AppState {
  // 删除: ompCurrentPath
  sessionsMap: Record<string, ChatMessage[]>;      // 保留
  procStateMap: Record<string, ProcState>;         // 新增
  currentSessionPath?: string;                       // 保留（显示指针）
  messages: ChatMessage[];                           // 保留（= sessionsMap[currentSessionPath]）
  // 全局 isStreaming/isAborting 删除 → 改读 procStateMap[currentSessionPath]
}
```

## 7. 风险与边界

| 风险 | 说明 | 对策 |
|------|------|------|
| 内存 | 每个 omp 进程 ~80-150MB（bun + agent）。5 个 ~500-750MB | 上限 5 可配；LRU 淘汰 idle 进程 |
| 冷启动延迟 | lazy spawn 有 ~1.5s ready 延迟 | Phase 2 加预热（hover 会话卡片预拉起） |
| 会话文件竞争 | 多进程写同一 sessions 目录 | 各写各的 .jsonl，无竞争；listSessions 扫盘不受影响 |
| 模型配置共享 | `~/.omp/agent/models.yml` 全局 | 多进程只读不写，无冲突 |
| 权限模式 per-session | 不同会话可能要不同 approvalMode | spawn 时带 `--approval-mode`，每个会话独立 |
| abort 跨进程 | 用户点 Stop 只应停当前会话 | `abort` 路由到 currentSessionPath 的进程，不影响其他 |
| 淘汰时正在 streaming | LRU 不应淘汰正在跑的进程 | 淘汰只选 `isStreaming=false` 的 idle 进程；全在跑则提示用户 |
| 进程退出残留 | 进程崩溃后 entry 状态 | onExit 标 evicted/offline，下次 acquire 重 spawn |
| Windows 进程清理 | kill 后 SIGTERM 可能不生效 | 复用现有 OmpProcess.kill() 的 SIGKILL 兜底逻辑 |

## 8. 兼容性

- v0.1.18 的 `sessionsMap` / `loadSessionMessages` / `resolveAndSelectNewSession` / `readSessionMessages` IPC **全部保留复用**。
- 删除的只有：`ompCurrentPath`（被 `__sessionPath` 取代）、全局 `isStreaming`/`isAborting`（改 per-session）、全局 `omp`/`router`/`ompCwd`（改进程池）。
- 现有的"看历史不中断"在多进程下**自然成立**——每会话独立进程。

## 9. 实施分期

### Phase 1 · 核心可用（必须）

- `electron/omp-pool.ts`：`OmpProcessPool` + `acquire`/`send`/`evict`/`killAll` + LRU。
- `main.ts`：替换全局 `omp`/`router` 为进程池；IPC 改造（RpcSend 带 sessionPath、RpcEvent 带 `__sessionPath`、RpcReady/OmpExit 带 sessionPath）。
- `ipc-channels.ts` / `preload.ts`：通道签名更新 + 新增 `OmpAcquire`/`OmpRelease`。
- `store.ts`：删 `ompCurrentPath`；`applyAgentEvent` 按 `__sessionPath` 路由；新增 `procStateMap`。
- `App.tsx`：`onSelectSession`/`onSend`/`onAbort`/`onNewSession` 改 per-session；`onReady` 改成 per-session ready。
- LRU 淘汰 + lazy 续接（带 `-c`）。
- 上限 5（硬编码，可配留 Phase 2）。

**验收**：A 流式中切到 B → A 继续跑；对 B 发消息 → A 不受影响；开 6 个会话 → LRU 淘汰最旧的 idle；淘汰后切回 → 续接历史。

### Phase 2 · 打磨

- per-session Stop 按钮状态（按 `procStateMap[current].isStreaming`）。
- 侧栏会话卡片进程状态指示（online/offline/evicted 小图标）。
- 预热（hover 会话卡片预拉起进程）。
- 进程池配置页（上限、淘汰策略）。
- 淘汰时全在 streaming 的提示。

### Phase 3 · 可选增强

- 多窗口（每会话独立 Electron 窗口）——单窗口多路复用已够用，按需。
- 跨会话引用（一个会话的工具结果给另一个用）——高级特性。

## 10. 工作量评估

- **Phase 1**：中大型改造。主进程进程池 ~350 行新代码、IPC 通道 ~60 行、renderer store 重构 ~180 行、App.tsx 适配 ~120 行。需仔细迁移 + 测试。没有不可逾越的技术障碍。
- 不是一两次小改能完工，但路径清晰、可分步验证。

## 11. 验证清单（Phase 1 完成后）

- [ ] A 流式中 → 切 B → A 继续吐字（sessionsMap[A] 持续增长）
- [ ] 切回 A → 看到完整最新内容（无断点）
- [ ] 对 B 发消息 → A 不中断
- [ ] 对 B 发消息 → A 的 Stop 按钮仍可按停 A
- [ ] 开 6 个会话 → 第 6 个 spawn 时最旧 idle 进程被淘汰
- [ ] 淘汰的会话切回 → 重新 spawn 带 -c 续接历史
- [ ] 进程崩溃 → 该会话标 offline，其他不受影响
- [ ] 关闭应用 → 所有进程清理
