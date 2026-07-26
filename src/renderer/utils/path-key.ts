/**
 * path-key.ts — 跨平台路径归一化与比较。
 *
 * Windows 上同一目录可能被表成 D:\code\foo、D:/code/foo、d:\code\foo\ 等，
 * 必须在所有"用 cwd 当 Map 键 / Workspace.id / sessionsByWs 索引"的场景
 * 走同一份归一化，否则不命中。
 *
 * 历史教训：早期 d4bea22 commit 里 makeWorkspaceId 只是 cwd.toLowerCase()，
 * 后续改成 cwdKey()（加 `\\ → /`），但**没迁移老 workspaces.json**，
 * 导致 OMP-Tauri / OMP-UI / omp-gui 这类老 workspace 的 id 仍是
 * `d:\code\omp-tauri`（反斜杠），与 sessionsByWs 的 `d:/code/omp-tauri` 永远
 * 不命中 → "该工作空间下暂无会话"。
 *
 * 现在统一用 cwdKey：所有新增/迁移的 id 都用此函数算。
 */

export function cwdKey(p: string): string {
  return p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
}

/** 派生稳定 id（workspace.id 与 cwd 一一对应，不区分大小写/斜杠） */
export function makeWorkspaceId(cwd: string): string {
  return cwdKey(cwd);
}

/** Windows 路径比较：normalize + 大小写不敏感 */
export function pathsEqual(a: string, b: string): boolean {
  return cwdKey(a) === cwdKey(b);
}

/** 路径的 basename（跨平台：处理 / 和 \） */
export function basename(p: string): string {
  const m = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return m[m.length - 1] || p;
}

/** 模型白名单 key（provider/id）。用不可见分隔符 \u0000，避免 provider 或 id 含 '/'
 *  时与另一组 provider/id 碰撞（如 "a/b" + "c" 与 "a" + "b/c"）。
 *  SettingsModelConfig 与 AddModelModal 共用此函数，保证写入/读取 enabledModels 一致。 */
export function modelKey(m: { provider: string; id: string }): string {
  return `${m.provider}\u0000${m.id}`;
}
