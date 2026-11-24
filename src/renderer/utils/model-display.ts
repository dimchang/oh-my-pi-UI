/**
 * model-display.ts — 模型显示名的消歧（纯函数，无 React/Electron 依赖）。
 *
 * 背景：上游 /v1/models 的 `name` 字段常对「同族多通道」重复。实测 LocalWBAPI：
 *   Hy3          → cn:hy3 / cn:hy3-b / cn:hy3-c / cn:hy3-x
 *   Hy4 preview  → cn:hy4-preview-ctrl / -exp / -x
 *   Hy4          → cn:hy4free / cn:hy4std
 * UI 只渲染 name 时会出现一排一模一样的条目（设置页截图：4 个 "Hy3"、3 个 "Hy4 preview"），
 * 用户根本无法判断哪个是免费通道/哪个是自己想选的那个。
 *
 * 规则（只影响显示，不碰白名单 key / 协议字段）：
 *   - name 缺失或就等于 id → 直接显示 id（同 provider 内 id 唯一）
 *   - name 在同组内唯一 → 原样显示 name（保持简洁，不打扰大多数模型）
 *   - name 重复 → `name · 短id`（短 id = 去掉最后一个 ':' 前的命名空间，如 cn:hy4free → hy4free）
 *     短 id 与 name 相同（如 name/id 都叫 hy3）或仍撞车 → 退化为完整 id
 */

export interface DisplayableModel {
  id: string;
  name?: string;
}

/** id 去掉命名空间前缀：`cn:hy4free` → `hy4free`；无 ':' 时原样返回 */
export function shortModelId(id: string): string {
  const i = id.lastIndexOf(':');
  return i >= 0 && i < id.length - 1 ? id.slice(i + 1) : id;
}

/**
 * 计算同组（同一 provider）内每个模型的显示名。
 * 入参应当是**同一 provider** 的模型列表；跨 provider 传进来没有意义（分组在 UI 侧）。
 * @returns Map<id, 显示名>
 */
export function modelDisplayNames(models: DisplayableModel[]): Map<string, string> {
  const base = models.map((m) => {
    const n = m.name?.trim();
    return !n || n === m.id ? m.id : n;
  });
  const count = new Map<string, number>();
  for (const b of base) count.set(b, (count.get(b) ?? 0) + 1);

  // 第一轮：只对重名的加短 id 后缀
  const first = base.map((b, i) => {
    if ((count.get(b) ?? 0) <= 1) return b;
    const short = shortModelId(models[i]?.id ?? b);
    return short.toLowerCase() === b.toLowerCase() ? b : `${b} · ${short}`;
  });

  // 第二轮：短 id 仍撞车（如两个 provider 内部同名不同命名空间）→ 完整 id
  const dup = new Map<string, number>();
  for (const f of first) dup.set(f, (dup.get(f) ?? 0) + 1);
  const out = new Map<string, string>();
  models.forEach((m, i) => {
    const f = first[i] ?? m.id;
    const b = base[i] ?? m.id;
    out.set(m.id, (dup.get(f) ?? 0) > 1 ? `${b} · ${m.id}` : f);
  });
  return out;
}

/**
 * 计费倍率的展示文案："x0.00" → "免费"；"x0.29" → "x0.29"；无法识别 → ''
 * （credits 是 workbuddy 网关私有字段，其它 provider 没有 → 返回 ''，UI 不渲染徽标）
 */
export function formatCredits(raw?: string): string {
  if (!raw) return '';
  const t = raw.trim().replace(/^x/i, '');
  const n = Number(t);
  if (!Number.isFinite(n)) return '';
  return n === 0 ? '免费' : `x${t}`;
}
