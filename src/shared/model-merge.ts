/**
 * model-merge.ts — discovery 模型列表与 models.yml 旧条目的合并（纯函数，无 React/Node 依赖）。
 *
 * 使用方：AddModelModal.onFinish（渲染层）与 omp-config.test.ts（往返回归测试）。
 * 抽成纯函数的原因（审查 P2-B）：合并逻辑若内联在组件里、测试里重抄一遍，
 * 测试通过不能证明组件没回归——两边必须 import 同一份实现。
 */

import type { ModelInfo } from './rpc-types';
import type { OmpModelDefinition } from './ipc-channels';

/**
 * 合并规则（omp 18.1.0→18.3.2 升级适配 §3）：
 *
 * 1. 与 yml 里同 id 旧条目合并：旧条目作基底（保留 thinking/input/compat/transport/
 *    cost 等手工/上游字段——运行时对象含 yml 全部键），discovery 结果只覆盖 GUI 关心字段。
 *    否则 thinking.efforts 丢失 → 思考档位"切高自动弹回"；input 丢失 → 图片能力不被识别。
 * 2. 并集（审查 P2-C）：旧条目中本次未被发现的模型**保留**——discovery 可能因 provider
 *    过滤 / 认证问题缺漏，按 discovered 驱动重建会静默删除旧配置，违背透传语义。
 */
export function mergeDiscoveredModels(
  prevModels: OmpModelDefinition[] | undefined,
  discovered: ModelInfo[],
): OmpModelDefinition[] {
  const prev = prevModels ?? [];
  const out: OmpModelDefinition[] = discovered.map((m) => {
    const prevModel = prev.find((pm) => pm.id === m.id);
    const { extra: pmExtra, ...pmRest } = (prevModel ?? {}) as OmpModelDefinition;
    const merged: OmpModelDefinition = {
      ...(pmExtra ?? {}),
      ...pmRest,
      id: m.id,
      name: m.name ?? pmRest.name ?? m.id,
      contextWindow: m.contextWindow ?? pmRest.contextWindow,
      maxTokens: m.maxTokens ?? pmRest.maxTokens,
    };
    if (m.thinking) merged.thinking = m.thinking;
    if (m.input) merged.input = [...m.input];
    if (m.reasoning !== undefined) merged.reasoning = m.reasoning;
    if (m.cost) merged.cost = { ...m.cost };
    return merged;
  });
  // 并集：未被本次发现的旧模型原样保留
  const seen = new Set(out.map((m) => m.id));
  for (const pm of prev) {
    if (!seen.has(pm.id)) out.push({ ...pm });
  }
  return out;
}
