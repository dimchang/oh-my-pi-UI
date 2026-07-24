/**
 * perm-cache.ts — 宿主侧"记住本次选择"allowlist（kimi_plan §M2.6）。
 *
 * 这是宿主 UX 层优化：omp 不持久化每工具 allowlist。
 * 命中 allow → 自动回 confirmed:true；命中 deny → 自动回 confirmed:false；未命中 → 弹 modal。
 */

export type PermDecision = 'allow' | 'deny';

export class PermCache {
  private map = new Map<string, PermDecision>();

  /** 从 extension_ui_request 提取工具 key（confirm 的 message/title 里常含工具名） */
  static keyOf(toolName?: string): string | null {
    return toolName ? toolName.toLowerCase() : null;
  }

  get(toolName: string): PermDecision | undefined {
    return this.map.get(toolName.toLowerCase());
  }

  set(toolName: string, decision: PermDecision): void {
    this.map.set(toolName.toLowerCase(), decision);
  }

  reset(): void {
    this.map.clear();
  }
}
