# 幽灵工作区启动崩溃 — 修复方案（v3）

> 事故：`omp:acquire` 报 `工作目录不存在: D:\code\OMP-UI\.temp\scratch-ws`，omp 进程拉不起来、UI 卡死。
> 已完成的数据修复见 `.workbuddy/memory/2026-09-12.md`。本文档只讨论**代码侧根治**。
>
> **版本演进**：
> - v1 → v2：`upsertWorkspace` 直接去隐式抢焦点（弃 `ensureWorkspace`）；批次 2 弃级联回退改 stale-aware；补「无可用工作区」提示。
> - **v2 → v3（本轮，重要）**：**修正 v2 的致命漏洞 —— `staleCwds` 判定对象错误导致 R2 实际未修复**。
>   改为在 `SessionSummary` 上加 `cwdExists`（主进程算）来治幽灵生成；`staleCwds` 仅服务 currentId 回退。两者并存，缺一不可。
>   另：reconcile 判定抽成纯函数以便单测；补 `upsertSessionPlaceholder` 改动点；首次启动提示降级为 info。
> - **v3 → v3.1**：修正规格文字里的**域混淆**（`currentId` 是 id、`staleCwds` 是 cwd，不可直接比较，须先 id→cwd 映射）；
>   `doNewSession` 的 `!targetCwd` 分支补显式 `return false`；标注验收项 2 为手工集成测试；写明两次 reconcile 的分工与不可挪动性。
> - **v3.1 → v3.2（更正）**：**v3.1 关于「id/cwd 域混淆」的结论已被实测推翻并撤回** —— `Workspace.id === cwdKey(cwd)`，
>   两者是同一值域，v3 原文直接比较是正确的。改为保留最简比较 + 文档声明不变量 + 单测守护。
>   保留 v3.1 的其余修正（返回契约、验收项标注、reconcile 分工）。

## 一、三个根因（均已代码级验证）

| # | 缺陷 | 位置 |
|---|---|---|
| R1 | **`upsertWorkspace` 无条件把 `currentWorkspaceId` 设成它** —— 加个工作区不该抢焦点 | `src/renderer/store.ts:733-740` |
| R2 | **reconcile 会为任何「磁盘上有会话、但工作区列表里没有」的 cwd 自动造工作区**，且从不清理目录已消失的条目 | `src/renderer/App.tsx:252-279` |
| R3 | **启动路径强依赖 `currentWorkspace().cwd` 有效**：cwd 无效 → `onNewSession` → `acquire` reject → `ready` 恒 false → 卡死，无任何回退 | `src/renderer/App.tsx:628-653` |

R1 + R2 联手就是「幽灵生成器」；R3 把「数据脏」升级成「应用无法启动」。

## 二、⚠️ v2 的致命漏洞（本轮核心发现，必须理解）

v2 用 `staleCwds`（**已注册工作区**的 cwd 集合）去过滤 reconcile（遍历的是**会话** cwd）：

```ts
const all = [...file.workspaces, ...(file.archived ?? [])];  // 工作区 cwd
const stale = new Set(staleCwds.map(cwdKey));
for (const s of st.sessions) {
  if (stale.has(cwdKey(s.cwd))) continue;   // ← 拿会话 cwd 查工作区 cwd 集合，永远查不到
```

事故现场复核：20:38:06 清理后 scratch-ws **已不在** `workspaces` 里 → `staleCwds` 为空集
→ `stale.has(scratch-ws 会话 cwd)` = false → **过滤器放行，幽灵照旧生成**。即 v2 批次 1 对本次事故是 no-op。

**教训：两个判定需要两份数据，不能用一份顶替。**

| 判定目的 | 数据来源 | v2 | v3 |
|---|---|---|---|
| reconcile 该不该为某个**会话 cwd** 造工作区 | 会话 cwd 是否有效 → `SessionSummary.cwdExists` | ❌ 缺 | ✅ |
| currentId 指向失效**工作区**时回退 | 工作区 cwd 是否有效 → `WorkspacesLoadResult.staleCwds` | ✅ | ✅ 保留 |

## 三、复现矩阵

| 场景 | 现状 | 只修批次1 | 只修批次2 | v3 全修 |
|---|---|---|---|---|
| 探针在临时目录造会话 | 自动变当前工作区并落盘 | ✅ 不再抢焦点 | ❌ 仍幽灵化 | ✅ |
| 目录被删后重启 | 启动卡死 | ❌ 条目仍会生成 | ✅ 能启动 | ✅ |
| 外接盘临时离线 | 启动卡死 | ✅ 条目保留 | ✅ 能启动 | ✅ |
| 手工改 userData 留脏 currentId | 启动卡死 | ❌ 仍卡死 | ✅ 能启动 | ✅ |
| 全部工作区失效 / 无工作区 | 静默卡死（无提示） | ❌ 仍静默 | ✅ 明确提示 | ✅ |

## 四、改动清单（4 处必须 + 1 处可选，分 2 批提交）

### 批次 1：断掉幽灵生成（R1 + R2）

#### 1.1 `upsertWorkspace` 去掉隐式抢焦点

`src/renderer/store.ts:733-740`

```ts
upsertWorkspace: (ws) =>
  set((s) => {
    const idx = s.workspaces.findIndex((w) => w.id === ws.id);
    const next = idx >= 0
      ? s.workspaces.map((w, i) => (i === idx ? { ...w, ...ws } : w))
      : [...s.workspaces, ws];
    // v2：不再隐式改 currentWorkspaceId —— 「发现/更新一个工作区」与「聚焦它」是两件事。
    return { workspaces: next };
  }),
```

接口注释（`store.ts:304-305`）改为：`/** 新增/更新工作空间。**不改变当前选中**；需要聚焦请显式调 setCurrentWorkspaceId。 */`

**唯一需补显式聚焦的调用点** —— `App.tsx:888-910 onAddWorkspace`：

```ts
} else {
  st.upsertWorkspace({ id, cwd, displayName: basename(cwd), collapsed: false, createdAt: Date.now(), approvalMode: 'write' });
  st.setCurrentWorkspaceId(id);   // ★ 显式聚焦，不依赖 doNewSession 的内部副作用
}
```

#### 1.2 【v3 新增·治 R2 的真正手段】`SessionSummary.cwdExists`

`src/shared/ipc-channels.ts:161-169`

```ts
export interface SessionSummary {
  path: string;
  id: string;
  cwd: string;
  title: string;
  mtime: number;
  /** cwd 在磁盘上**存在且为目录**（注意不是 existsSync 语义：文件也算无效）。
   *  由主进程算出；reconcile 用它挡掉「为已消失目录自动造工作区」。 */
  cwdExists?: boolean;
}
```

`src/main/session-store.ts`（`listSessions`，:108-158）—— 在返回前对 unique cwd 批量 stat：

```ts
const cwdExists = new Map<string, boolean>();
await Promise.all([...new Set(out.map((s) => s.cwd))].map(async (cwd) => {
  try { cwdExists.set(cwd, (await fs.promises.stat(cwd)).isDirectory()); }
  catch { cwdExists.set(cwd, false); }
}));
return out.map((s) => ({ ...s, cwdExists: cwdExists.get(s.cwd) ?? false }));
```

> 字段设为**可选**（`?`）而非必填：`SessionSummary` 有两个构造点，
> `store.ts:602-610 upsertSessionPlaceholder`（占位会话，cwd 刚由用户选定、必然有效）
> 也应补 `cwdExists: true`；用可选字段可让"漏补"不阻断编译，但**仍要补**（见 §六）。

#### 1.3 `WorkspacesGet` 返回 `staleCwds`（服务 currentId 回退）

`src/shared/ipc-channels.ts`

```ts
export interface WorkspacesLoadResult {
  file: WorkspacesFile;
  /** **任务区**工作区中 cwd 已失效（不存在或非目录）的 cwd 列表；渲染层自行 cwdKey 归一 */
  staleCwds: string[];
}
```

`OmpApi.getWorkspaces` 返回类型改为 `Promise<WorkspacesLoadResult>`（`ipc-channels.ts:394`）。

`electron/main.ts:480`

```ts
ipcMain.handle(IPC.WorkspacesGet, async (): Promise<WorkspacesLoadResult> => {
  const file = await loadWorkspacesFile();
  // 只 stat，不写盘、不删条目：外接盘临时离线时由渲染层「标记/提示」而非静默删除
  const uniq = [...new Set(file.workspaces.map((w) => w.cwd))];   // 只需任务区（归档不参与回退）
  const staleCwds: string[] = [];
  await Promise.all(uniq.map(async (cwd) => {
    try { if (!(await fs.promises.stat(cwd)).isDirectory()) staleCwds.push(cwd); }
    catch { staleCwds.push(cwd); }
  }));
  return { file, staleCwds };
});
```

`electron/preload.ts:47` 原样透传；调用方已验证仅 `App.tsx:253`（`rpc-client.ts:86` 是透传）。

#### 1.4 【v3 新增】把 reconcile 判定抽成纯函数（可单测）

新建 `src/renderer/utils/workspace-reconcile.ts`（与仓库既有 `utils/*.test.ts` 惯例一致）：

```ts
export interface ReconcilePlan {
  toAdd: Workspace[];            // 需要新建的工作区条目
  nextCurrentId: string | null;  // 与传入相同表示无需变
  changed: boolean;
}

export function planWorkspaceReconcile(input: {
  sessions: Pick<SessionSummary, 'cwd' | 'cwdExists'>[];
  workspaces: Workspace[];
  archived: Workspace[];
  removedCwds: string[];
  staleCwds: string[];
  currentId: string | null;
}): ReconcilePlan
```

规则（全部集中在此，App.tsx 只做副作用）：
1. 会话 cwd **已注册 / 已归档 / 在 removedCwds** → 跳过；
2. 会话 `cwdExists === false` → 跳过（**R2 的真正修复点**）；
3. 其余 → `toAdd`（`displayName: basename(cwd)`、`createdAt: Date.now()`）；
4. **currentId 是否失效：直接查即可** —— `staleCwds` 过 `cwdKey()` 后**就是对应工作区的 id**
   （见下文「不变量」）。v3.2 实测更正：v3.1 曾断言"id 与 cwd 是两个域、直接比较恒为 false"，
   **该结论错误**（23 个工作区实测 `id === cwdKey(cwd)` 全部成立，`staleSet.has(currentId)` 返回 true）。

   ```ts
   const staleSet = new Set(input.staleCwds.map(cwdKey));   // = 失效工作区的 id 集合
   const curStale = input.currentId !== null && staleSet.has(input.currentId);
   if (curStale) nextCurrentId = input.workspaces.find((w) => !staleSet.has(w.id))?.id ?? null;
   ```

   > **不变量（务必遵守）**：`Workspace.id === cwdKey(Workspace.cwd)`（`path-key.ts:22-24
   > makeWorkspaceId = cwdKey`，注释明示"id 与 cwd 一一对应"）。`setWorkspacesFile` 的
   > `migrateWs` 负责迁移老数据、维持该不变量；新增 id 一律用 `makeWorkspaceId`。
   > **不要**为了"稳妥"再自行 `workspaces.find(w => w.id === currentId)` 反查 cwd —— 那绕开了
   > `path-key.ts` 立下的统一归一化约定（该文件注释明确要求 cwd 当 Map 键 / `Workspace.id` /
   > `sessionsByWs` 索引都走同一份归一化）。**该不变量的存在由单测守护**（见 §七 6）。

5. `changed = toAdd.length > 0 || nextCurrentId !== input.currentId`。

`src/renderer/App.tsx:252-279` 改为调用该纯函数 + 执行副作用：

```ts
const loadAndReconcileWorkspaces = useCallback((): void => {
  void window.omp.getWorkspaces().then(({ file, staleCwds }) => {
    useApp.getState().setWorkspacesFile(file);
    applyAppearance(useApp.getState().appearance);
    const st = useApp.getState();
    const plan = planWorkspaceReconcile({
      sessions: st.sessions, workspaces: st.workspaces, archived: st.archived,
      removedCwds: st.removedCwds, staleCwds, currentId: st.currentWorkspaceId,
    });
    for (const ws of plan.toAdd) useApp.getState().upsertWorkspace(ws);
    if (plan.nextCurrentId !== st.currentWorkspaceId) {
      useApp.getState().setCurrentWorkspaceId(plan.nextCurrentId);
      const fb = plan.nextCurrentId
        ? st.workspaces.find((w) => w.id === plan.nextCurrentId) : null;
      pushToast(fb ? `上次的工作区目录不存在，已切换到「${fb.displayName}」`
                   : '上次的工作区目录不存在，请重新打开一个文件夹', 'error');
    }
    if (plan.changed) useApp.getState().persistWorkspaces();
  }).catch(() => undefined);
}, [pushToast]);   // ★ 原本是 []，需补 pushToast
```

**时序已验证（两次 reconcile 分工不同，均不可挪动）**：
- **第一次 reconcile（mount，`App.tsx:410`）**：此时 `st.sessions` **为空** → `toAdd` 必为空；
  但 `staleCwds` 已可用 → **currentId 回退在这里完成**，且先于 `workspacesLoaded` 触发的启动 pick。
- **第二次 reconcile（`:631`，refreshSessions 之后）**：此时 `st.sessions` 已带 `cwdExists` → **幽灵防护在这里生效**；
  对启动 pick 而言是 no-op 安全网。
- 启动 pick（`:633`）同步读取 currentWorkspace —— 读到的是第一次 reconcile 修正后的 currentId。**无竞态。**
- ⚠️ 若把 reconcile 挪出 mount effect、或改成 await 串到 refreshSessions 之前，上述分工即被破坏 —— 改动时保持现状结构。

**保留行为声明**：目录**仍存在**的探针目录依旧会被发现成工作区条目 —— 既有的
「CLI 建会话自动出现」特性，有意不砍（需目录白名单，会伤害正常用法）。v3 后它只是出现在列表里、
不抢焦点；`removedCwds` 仍可彻底拦截。

### 批次 2：启动永不卡死（R3）

#### 2.1 `doNewSession` / `onNewSession` 返回成功与否

`App.tsx:599-625` → `Promise<boolean>`；成功 `true`，`catch` toast 后 `false`。
**三个返回点都要写全**：`!targetCwd` 早退（`:603-606`）→ `return false`（不写会返回 undefined，
boolean 契约有暗坑）；`catch` → `return false`；成功 → `return true`。
`onNewSession`（:586-597）透传返回值；「已在新建会话中」早退分支返回 `false`。

#### 2.2 启动兜底：只做「预切」，不做盲目级联

```ts
void refreshSessions().then(() => {
  loadAndReconcileWorkspaces();
  const st = useApp.getState();
  const cwd = st.currentWorkspace()?.cwd;
  if (!cwd) {
    // ★ 首次启动无工作区是正常状态 → info 级引导，不是 error
    pushToast('还没有工作区，请点击侧栏「打开文件夹」选择一个目录', 'info');
    return;
  }
  const newest = /* 原逻辑不变 */;
  if (newest) { /* 原逻辑：setCurrentSessionPath + loadSessionMessages + acquire（失败 toast） */ }
  else void onNewSession(cwd);
});
```

**为什么不做级联重试**：对**有效** cwd，acquire/newSession 失败大概率是 omp 瞬时问题
（二进制缺失、端口占用、spawn 超时）—— 级联会在**错误的工作区偷偷新建会话**（写新 .jsonl），
副作用大于收益。目录失效场景已由 1.4 预切解决；用户手动点别的工作区随时可恢复。

### 可选批次 3：侧栏标记失效工作区 + 一键移除（体验）

- `WorkspaceList`：stale 条目加灰点 + `title="目录不存在"`；
- 「从列表移除」→ 写入 `removedCwds`（复用 `deleteArchivedWorkspace` 机制；它目前只处理归档区，
  任务区需新增 action 或先归档再删）。
- 这是用户该有的正规清理入口，以后不用手改 JSON、也不会漏写 `removedCwds`。

## 五、提交与版本

- 每批改动后 `package.json` bump patch（`0.4.46` → 批次1 `0.4.47` → 批次2 `0.4.48`），conventional commits：
  - `fix(store,ui): upsertWorkspace 不再隐式抢焦点 + reconcile 跳过 cwd 已消失的会话（防幽灵工作区）`
  - `fix(ui): 启动对失效工作区预切回退并明确提示，坏 cwd 不再卡死`
- **冲突提醒**：`src/renderer/store.ts` 有另一 agent 未提交改动（+84 行，连接状态三色），改前确认收尾；
  `App.tsx`、`electron/main.ts`、`src/shared/ipc-channels.ts`、`src/main/session-store.ts` 当前干净。
  新测试放独立文件，不动 `store.test.ts`。
- **改完必须 rebuild**（`npm run build`）：当前运行的是 `out/main/index.js`，不重建测不到。

## 六、需连带修改的 `SessionSummary` 构造点（清单）

| 位置 | 处理 |
|---|---|
| `src/main/session-store.ts:144`（`listSessions`） | 补 `cwdExists`（1.2） |
| `src/renderer/store.ts:607`（`upsertSessionPlaceholder`） | 补 `cwdExists: true`（占位会话的 cwd 刚由用户选定） |

## 七、回归测试清单

1. 造脏数据：`workspaces` 放不存在目录 + `currentId` 指向它 → 启动**必须能起来** + toast 提示已切换。
2. **造幽灵会话（本次事故的等价复现）**：往 `~/.omp/agent/sessions/` 放一个 cwd 指向**不存在且未注册**目录的 session
   → 启动**不得**出现该工作区条目。（v2 在此项会失败，v3 通过 —— **核心验收项**。
   ⚠️ 此项是**手工集成测试**，`npm run test` 盖不住它；自动化只覆盖第 6 条的纯函数。）
3. 正常路径：`onAddWorkspace` 打开文件夹后**必须**切到新工作区；双击防抖路径也不丢焦点。
4. 外接盘/网络盘离线：条目**保留**、启动不卡死、不被静默删除。
5. 全部工作区失效：启动必须有明确 toast；无工作区：info 级引导。
6. 新增单测 `src/renderer/utils/workspace-reconcile.test.ts`：已注册 / removedCwds / `cwdExists:false` / currentId 失效回退 / 全失效；
   **外加一条不变量守护用例**：`expect(makeWorkspaceId(cwd)).toBe(cwdKey(cwd))` 且 plan 的 `nextCurrentId` 与 `staleCwds` 比较走同一归一化。
7. `npm run test` + `npx tsc --noEmit` + `npm run build`。

## 八、运维纪律（非代码，防复发）

探针环境**光 `--user-data-dir` 不够** —— `~/.omp/agent/sessions` 是全局的
（`src/main/session-store.ts:15` 硬编码），隔离实例造的会话照样污染宿主实例。
跑探针：**独立 userData + 独立 cwd 目录，用完按三件套清理**
（删目录 / 删 workspaces 条目 / **把 cwd 写进 `removedCwds`**）。

## 九、审查记录

| 轮次 | 发现 | 严重度 | 处理 |
|---|---|---|---|
| v2 | 批次2 盲目级联会在错误工作区偷偷新建会话 | 高 | 改 stale-aware 预切 + 单次尝试，失败只 toast |
| v2 | 全部工作区失效时仍静默卡死 | 中 | 启动 effect 补明确提示 |
| v2 | v1 新增 `ensureWorkspace` 属设计冗余 | 低 | 直接删 `upsertWorkspace` 隐式抢焦点 |
| v3 | **`staleCwds` 判定对象错误 → R2 实际未修复（对本次事故是 no-op）** | **致命** | 新增 `SessionSummary.cwdExists` 作为 reconcile 过滤依据；`staleCwds` 保留但仅服务 currentId 回退 |
| v3 | reconcile 判定住在 hook 里，无法单测 | 中 | 抽纯函数 `planWorkspaceReconcile` + 独立测试文件 |
| v3 | `upsertSessionPlaceholder` 是 `SessionSummary` 第二构造点，未列入清单 | 低 | 见 §六 |
| v3 | 首次启动无工作区弹 error toast | 低 | 降为 info 引导 |
| v3 | `cwdExists` 命名歧义（≠ existsSync） | 低 | 注释写死「存在且为目录」 |
| v3 | `currentId=null` 是否会让 UI 崩 | 已排除 | 全部消费点均判空（`App.tsx:868` `if (!ws) return`、`:921` `if (cur) … else toast`、其余 `?.`） |
| v3.1 | ~~规则 4 的规格文字把 `currentId`（id 域）与 `staleCwds`（cwd 域）混比，回退会静默失效~~ | ~~高~~ | **⚠️ 已撤回：该结论错误**。v3 原文本就正确。实测 23 个工作区 `id === cwdKey(cwd)` 全部成立、`staleSet.has(currentId)` 返回 true —— id 与 cwd 是**同一归一化值域**（`path-key.ts:22-24`）。v3.1 的"修正"是把对的改成错的，并且未经验证即写成高严重度结论 |
| v3.2 | 真实风险：`id === cwdKey(cwd)` 是**靠迁移维护的隐式不变量**，被破坏时比较会静默失配 | 低 | 保持最简单比较；把不变量写进文档；新增不变量单测 `expect(w.id).toBe(cwdKey(w.cwd))` 守护（§七 6） |
| v3.1 | `doNewSession` 的 `!targetCwd` 分支返回 undefined，boolean 契约有暗坑 | 低 | 显式 `return false`，三个返回点写全 |
| v3.1 | 验收项 2 是手工集成测试，文档未标注 | 低 | 已标注：自动化只覆盖纯函数 |
| v3.1 | 两次 reconcile 分工（首次=currentId 回退、二次=幽灵防护）未写明，易被后人挪动破坏 | 中 | 已写进 §四 1.4 时序说明 |
