/**
 * workspace-reconcile.ts — 工作区自动补全（reconcile）的纯判定函数。
 *
 * 背景（2026-09-12 幽灵工作区事故）：任何「磁盘上有会话、但工作区列表里没有」的 cwd 会被
 * 自动补成工作区，而 store.upsertWorkspace 曾隐式把 currentWorkspaceId 切过去 —— 探针在
 * 临时目录造的会话会把宿主的当前工作区劫持成一个后来被删除的目录，启动 acquire 失败 → UI 卡死。
 *
 * 全部判定收敛在此纯函数（可单测）；App.tsx 只负责执行副作用（upsert / setCurrent / persist / toast）。
 * 判定规则与改动动机详见仓库根 `plan-ghost-workspace-fix.md`。
 */
import type { SessionSummary, Workspace } from '../../shared/ipc-channels';
import { cwdKey, basename } from './path-key';

export interface ReconcilePlan {
  /** 需要新建的工作区条目（调用方用 upsertWorkspace 逐个写入） */
  toAdd: Workspace[];
  /** 修正后的 currentWorkspaceId；与传入值相同表示无需变更（含 null） */
  nextCurrentId: string | null;
  /** 是否有变化（调用方据此决定是否 persistWorkspaces） */
  changed: boolean;
}

export interface ReconcileInput {
  /** 会话摘要（需带 cwdExists —— 主进程 listSessions 算出：cwd 存在且为目录） */
  sessions: Pick<SessionSummary, 'cwd' | 'cwdExists'>[];
  workspaces: Workspace[];
  archived: Workspace[];
  /** 用户主动彻底删除过的 cwd（小写；两侧都过 cwdKey 归一后比较） */
  removedCwds: string[];
  /** 任务区工作区中 cwd 已失效（不存在或非目录）的 cwd 列表（主进程 WorkspacesGet 算出） */
  staleCwds: string[];
  currentId: string | null;
}

export function planWorkspaceReconcile(input: ReconcileInput): ReconcilePlan {
  const existingCwds = new Set(input.workspaces.map((w) => cwdKey(w.cwd)));
  const archivedCwds = new Set(input.archived.map((w) => cwdKey(w.cwd)));
  const removed = new Set(input.removedCwds.map(cwdKey));
  // 不变量：Workspace.id === cwdKey(Workspace.cwd)（path-key.ts 的 makeWorkspaceId = cwdKey，
  // setWorkspacesFile 的 migrateWs 负责迁移老数据）。因此失效 cwd 过 cwdKey 后**就是**该工作区的 id，
  // currentId 可直接在 staleIds 里查 —— 不要反查 cwd 再归一（那会绕开 path-key.ts 的统一归一化约定）。
  const staleIds = new Set(input.staleCwds.map(cwdKey));

  const toAdd: Workspace[] = [];
  for (const s of input.sessions) {
    const key = cwdKey(s.cwd);
    if (existingCwds.has(key) || archivedCwds.has(key) || removed.has(key)) continue;
    // 目录已消失的会话：绝不为其自动造工作区（R2 幽灵生成器）。
    // cwdExists 仅在显式为 false 时跳过 —— undefined（占位会话/老数据）按"存在"处理，向后兼容。
    if (s.cwdExists === false) continue;
    existingCwds.add(key); // 同 cwd 多个会话只补一个
    toAdd.push({
      id: key,
      cwd: s.cwd,
      displayName: basename(s.cwd),
      collapsed: false,
      createdAt: Date.now(),
    });
  }

  // currentId 指向失效工作区 → 回退到第一个非失效工作区；全失效则 null
  //（UI 停在可用空态并提示，绝不静默卡死）。
  let nextCurrentId = input.currentId;
  if (input.currentId !== null && staleIds.has(input.currentId)) {
    nextCurrentId = input.workspaces.find((w) => !staleIds.has(w.id))?.id ?? null;
  }

  return {
    toAdd,
    nextCurrentId,
    changed: toAdd.length > 0 || nextCurrentId !== input.currentId,
  };
}
