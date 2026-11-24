/**
 * model-thinking.ts（shared）— 思考能力的纯函数：检测、方案生成、models.yml 条目构建、批量同步计划。
 *
 * 背景（omp 18.3.2 二进制实证）：
 *   Mu(model)  = model.reasoning ? (model.thinking?.efforts ?? []) : []      // 可选档位
 *   set_thinking_level → nu → Hc(model, level) = 有 reasoning ? 最近档位 : undefined
 *   → omp 回执 thinking_level_changed{thinkingLevel: undefined} → GUI 忽略 undefined → 永远停在「关闭」
 *
 * 而 omp 的 openai-models-list discovery 只按 id 猜能力，不读上游 /v1/models 的
 * supports_reasoning / reasoning_supported_efforts。于是自定义 provider 的思考模型在 omp 里
 * 全是 reasoning:false、thinking:null，用户选任何档位都被拒。
 *
 * 治法：在 models.yml 的 providers.<pid>.models[] 给这些 id 补 reasoning + thinking
 * （实测：显式 models 按 id 合并进 discovery 结果，不会顶掉其它模型），重启 omp 生效。
 *
 * 本文件只放纯逻辑（无 window/React/Node 依赖），渲染层与主进程共享。
 */

import type { ModelInfo, ThinkingLevel } from './rpc-types';
import type { OmpModelDefinition } from './ipc-channels';

/** omp 支持的档位全集（顺序即强度） */
export const THINKING_LEVEL_ORDER: ThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export interface ThinkingRepairPlan {
  efforts: ThinkingLevel[];
  defaultLevel: ThinkingLevel;
}

/** 运行时（omp 侧）真的能调档位吗：reasoning=true 且 efforts 非空 */
export function hasRuntimeThinking(
  model?: Pick<ModelInfo, 'reasoning' | 'thinking'> | null,
): boolean {
  return model?.reasoning === true && (model.thinking?.efforts?.length ?? 0) > 0;
}

/**
 * 依据上游声明生成修复方案；上游没说支持思考 → null。
 * 不臆断：给非思考模型硬开 reasoning 会让 omp 发 reasoning_effort，上游可能直接 400。
 */
export function planThinkingRepair(
  upstream?: Pick<ModelInfo, 'upstreamReasoning' | 'upstreamEfforts'> | null,
): ThinkingRepairPlan | null {
  if (!upstream?.upstreamReasoning) return null;
  const declared = (upstream.upstreamEfforts ?? []).filter((e): e is ThinkingLevel =>
    THINKING_LEVEL_ORDER.includes(e),
  );
  // 上游只说了 supports_reasoning 没给档位：用最常见的低/高两档（workbuddy/混元系实测就是这两档）
  const efforts = declared.length > 0 ? declared : (['low', 'high'] as ThinkingLevel[]);
  const defaultLevel = efforts.includes('high') ? 'high' : (efforts[efforts.length - 1] ?? 'high');
  return { efforts, defaultLevel };
}

/**
 * 生成要写进 models.yml 的模型条目：保留已有字段（含未知字段 extra），只覆盖思考能力。
 */
export function buildThinkingModelEntry(
  prev: OmpModelDefinition | undefined,
  meta: Pick<ModelInfo, 'id' | 'name' | 'contextWindow' | 'maxTokens'>,
  plan: ThinkingRepairPlan,
): OmpModelDefinition {
  const { extra, ...rest } = prev ?? { id: meta.id };
  const next: OmpModelDefinition = {
    ...(extra ?? {}),
    ...rest,
    id: meta.id,
    name: rest.name ?? meta.name ?? meta.id,
    contextWindow: rest.contextWindow ?? meta.contextWindow,
    maxTokens: rest.maxTokens ?? meta.maxTokens,
    reasoning: true,
    thinking: {
      ...(rest.thinking ?? {}),
      mode: 'effort',
      efforts: [...plan.efforts],
      defaultLevel: plan.defaultLevel,
    },
  };
  if (next.contextWindow === undefined) delete next.contextWindow;
  if (next.maxTokens === undefined) delete next.maxTokens;
  return next;
}

export interface ThinkingSyncPlan {
  /** 合并后的完整 models 数组（待写回 models.yml） */
  models: OmpModelDefinition[];
  /** 新增条目数（yml 里原本没有该 id） */
  added: number;
  /** 就地更新条目数（原本有、但思考配置不一致） */
  updated: number;
  /** 每个被改动的 id → 实际写入的档位（用于 toast 文案） */
  changed: Record<string, ThinkingLevel[]>;
}

/** yml 条目里的 efforts 是否已与方案一致（幂等判据，避免每次点击都重写文件） */
function effortsEqual(a: string[] | undefined, b: ThinkingLevel[]): boolean {
  if (!a || a.length !== b.length) return false;
  const norm = (xs: string[]) => [...xs].map((x) => x.toLowerCase()).sort();
  return norm(a).join(',') === norm(b).join(',');
}

/**
 * 批量同步计划：把「上游声明支持思考、但 yml 里没写或写得不一致」的模型一次性补齐。
 *
 * 幂等：已经完全一致的条目不会被改写（added=updated=0 时调用方直接跳过写盘与重启）。
 * 可选 only：只处理指定 id（单模型修复复用同一套逻辑）。
 * 可选 forceEfforts：上游没声明、但用户确认模型支持思考时，按指定档位强制写入。
 */
export function planProviderThinkingSync(
  prevModels: OmpModelDefinition[] | undefined,
  discovered: ModelInfo[],
  opts?: { only?: string[]; forceEfforts?: ThinkingLevel[] },
): ThinkingSyncPlan {
  const models: OmpModelDefinition[] = [...(prevModels ?? [])];
  const only = opts?.only ? new Set(opts.only) : null;
  const forced = (opts?.forceEfforts ?? []).filter((e) => THINKING_LEVEL_ORDER.includes(e));
  let added = 0;
  let updated = 0;
  const changed: Record<string, ThinkingLevel[]> = {};

  for (const meta of discovered) {
    if (only && !only.has(meta.id)) continue;
    // 上游说法优先；上游沉默时才用用户手动指定的档位
    const plan =
      planThinkingRepair(meta) ??
      (forced.length > 0
        ? { efforts: forced, defaultLevel: forced.includes('high') ? 'high' : (forced[forced.length - 1] ?? 'high') }
        : null);
    if (!plan) continue; // 上游没声明且用户没强制 → 不动（不臆断）
    const idx = models.findIndex((m) => m.id === meta.id);
    const prev = idx >= 0 ? models[idx] : undefined;
    if (prev?.reasoning === true && effortsEqual(prev.thinking?.efforts, plan.efforts)) continue; // 已一致
    const entry = buildThinkingModelEntry(prev, meta, plan);
    if (idx >= 0) {
      models[idx] = entry;
      updated += 1;
    } else {
      models.push(entry);
      added += 1;
    }
    changed[meta.id] = plan.efforts;
  }
  return { models, added, updated, changed };
}
