/**
 * temp-session.ts — 新会话临时 key（`__new_xxx`）相关的纯逻辑。
 *
 * 2026-09-17 需求变更：新建会话时**不再**往侧栏插「新会话」占位条目。占位改到首条消息
 * 提交时、取好名字之后再插入——侧栏里出现的第一个状态就已经是有名字的会话，
 * 「新会话 + 改名后会话」两条并存的观感问题从根上消失（见 App.tsx `autoNameTempSession`）。
 */

/** 临时会话 key 前缀：尚未落盘、还没有真实 .jsonl 路径的会话。 */
export const TEMP_KEY_PREFIX = '__new_';

/** 取名兜底值：输入过短/纯符号、且没有附件名可当标题时使用。
 *  **必须与主进程 session-store.titleFallback 的返回值一致**，否则侧栏显示名与重载后
 *  扫盘得到的名字会跳变。 */
export const UNNAMED_SESSION = '（未命名会话）';

/** 旧版硬编码占位名。仅用于识别历史持久化数据里残留的值，新代码不再写入。 */
export const LEGACY_TEMP_TITLE = '新会话';

/** 会话自动命名判据（与主进程 titleFallback 同源）：
 *  取输入首行并 trim；长度 <2 或纯符号（如误发的「？」「！！」）不配当标题，退回附件名，
 *  再退回「（未命名会话）」。统一截断 40 字符。 */
export function deriveSessionName(text: string, firstAttachmentName?: string): string {
  const firstLine = (text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const attName = (firstAttachmentName ?? '').trim();
  const t = firstLine || attName;
  return t.length >= 2 && !/^[？！?!.。,，、\s]+$/.test(t)
    ? t.slice(0, 40)
    : (attName || UNNAMED_SESSION).slice(0, 40);
}
