/**
 * reloadCurrentSession — 写盘后对「当前会话」进程做 evict + 重新 acquire。
 *
 * 背景：omp 的 ModelRegistry / provider 配置只在进程启动时从 models.yml 加载一遍，
 * 已在线进程的进程内存缓存的是旧配置。因此增删 provider 后若不重载，
 * getAvailableModels 仍返回旧缓存（表现：删 provider 后列表不刷新 / 新增后拉不到模型）。
 *
 * 行为：
 *   · 对当前会话进程 rpc.release（杀旧进程）→ rpc.acquire（-r 续接同一 JSONL，
 *     新进程启动即重读 models.yml）。
 *   · temp 新会话（path 以 __new_ 开头）尚未落盘，无法 -r 续接 → 跳过重载，返回 false。
 *   · 正在生成中（isStreaming）不打断（evict 会杀掉进行中的 agent run）→ 跳过重载，返回 false。
 *   · 取不到 cwd → 跳过重载，返回 false。
 *
 * 返回：true = 已重载；false = 跳过重载（调用方应走 fallback 提示）。
 * 注意：真正的重载失败（release/acquire 抛错）会向上抛出，由调用方决定如何提示用户。
 */

import { useApp } from '../store';
import { rpc } from '../rpc-client';
import { cwdKey } from './path-key';

export async function reloadCurrentSession(): Promise<boolean> {
  const st = useApp.getState();
  const sp = st.currentSessionPath;

  // temp 新会话（__new_）尚未落盘，无法用 -r 续接，跳过重载
  if (!sp || sp.startsWith('__new_')) return false;
  // 正在生成中不打断（evict 会杀掉进行中的 agent run）
  if (st.procStateMap[sp]?.isStreaming) return false;

  const sess = st.sessions.find((x) => x.path === sp);
  const cwd = sess?.cwd ?? st.currentWorkspace()?.cwd ?? '';
  if (!cwd) return false;

  const approvalMode =
    st.workspaces.find((w) => cwdKey(w.cwd) === cwdKey(cwd))?.approvalMode ?? 'write';

  // 杀旧进程（onExit 会短暂置 offline，onReady 恢复），新进程重读 models.yml
  await rpc.release(sp);
  await rpc.acquire(sp, cwd, approvalMode);
  return true;
}
