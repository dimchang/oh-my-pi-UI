/**
 * notice-filter.ts — 识别 omp 启动/运行期的工具挂载噪声通知。
 *
 * 背景：
 * - omp ≤ 19.0.1：MCP/扩展工具通过 `xd://` 挂载，通知形态如 `xd://: mounted mcp__...`；
 * - omp 19.1.0+：`xd://` 工具设备被 `tools.commands` 取代（设置 `tools.commandNotices`），
 *   挂载/卸载通知不再以 `xd://` 开头，可能表现为 `commands: mounted ...` / `tools: mounted ...` /
 *   `mounted command(s): ...` / `unmounted ...` 等形式。
 *
 * 注意：仅用于过滤 info/warn 级挂载噪声，绝不吞掉会话写盘失败等真正错误。
 */

const MOUNT_NOTICE_PATTERNS: RegExp[] = [
  /^xd:\/\//i,
  /^(?:tools\.?commands?|commands?|tool commands?|mcp)\s*:\s*(?:mounted|unmounted)\b/i,
  /^(?:mounted|unmounted)\s+(?:tool\s+)?commands?\b/i,
  /^(?:mounted|unmounted)\s+mcp__/i,
];

/** 判断一条 omp `notice` 消息是否属于 MCP / 扩展工具命令挂载或卸载的运行时噪声。 */
export function isToolMountNotice(message: string | undefined): boolean {
  if (!message) return false;
  const trimmed = message.trim();
  if (!trimmed) return false;
  return MOUNT_NOTICE_PATTERNS.some((re) => re.test(trimmed));
}
