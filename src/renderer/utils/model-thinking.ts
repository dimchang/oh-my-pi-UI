/**
 * model-thinking.ts（renderer）— 思考能力的执行层：读写 models.yml + 重启 omp 进程。
 * 纯判定/构建逻辑在 src/shared/model-thinking.ts（渲染层与主进程共用，可单测）。
 *
 * 为什么需要「批量」：omp 的 discovery 不解析上游 supports_reasoning，
 * 一个 provider 下往往几十个模型全是 reasoning:false。逐个点「修复」不可接受，
 * 因此提供 syncProviderThinking(providerId) 一次补齐该 provider 全量。
 */

import type { ModelInfo, ThinkingLevel } from '../../shared/rpc-types';
import type { OmpModelDefinition } from '../../shared/ipc-channels';
import { planProviderThinkingSync, THINKING_LEVEL_ORDER } from '../../shared/model-thinking';
import { reloadCurrentSession } from './reload-session';

export {
  THINKING_LEVEL_ORDER,
  buildThinkingModelEntry,
  hasRuntimeThinking,
  planProviderThinkingSync,
  planThinkingRepair,
} from '../../shared/model-thinking';
export type { ThinkingRepairPlan, ThinkingSyncPlan } from '../../shared/model-thinking';

export interface SyncThinkingResult {
  /** 新写入的模型数 */
  added: number;
  /** 更新了思考配置的模型数 */
  updated: number;
  /** 实际写入的 id → 档位 */
  changed: Record<string, ThinkingLevel[]>;
  /** 是否重启了当前会话进程（false = 临时会话/生成中，需用户手动重启） */
  reloaded: boolean;
}

/**
 * 一次补齐整个 provider 的思考能力：
 *   1) 现拉上游 /v1/models（不用缓存：老缓存没有 upstream* 字段）
 *   2) 与 models.yml 现有条目比对，只改「上游声明支持、但 yml 没写/写得不一致」的
 *   3) 有改动才写盘 + 重启当前会话进程（omp 只在启动时读 models.yml）
 *
 * @param opts.forceEfforts 上游没声明支持时，用户强制指定的档位（「我知道它能思考」逃生口）
 */
export async function syncProviderThinking(
  providerId: string,
  opts?: { only?: string[]; forceEfforts?: ThinkingLevel[] },
): Promise<SyncThinkingResult> {
  const discovered = (await window.omp.fetchProviderModels(providerId)) as ModelInfo[];
  const yml = await window.omp.readModelsConfig();
  const cfg = yml.providers?.[providerId];
  if (!cfg) throw new Error(`models.yml 里没有 provider「${providerId}」，无法写入思考配置`);

  const plan = planProviderThinkingSync(
    cfg.models as OmpModelDefinition[] | undefined,
    discovered,
    opts,
  );
  if (plan.added + plan.updated === 0) {
    return { added: 0, updated: 0, changed: {}, reloaded: false };
  }

  await window.omp.writeOmpProvider(providerId, { ...cfg, models: plan.models });
  const reloaded = await reloadCurrentSession();
  return { added: plan.added, updated: plan.updated, changed: plan.changed, reloaded };
}

/** 读取 models.yml 里某模型已写入的思考档位（用于「配置已就绪」时回报真实结果） */
async function readYmlThinking(
  providerId: string,
  modelId: string,
): Promise<{ efforts: ThinkingLevel[] } | null> {
  try {
    const yml = await window.omp.readModelsConfig();
    const m = (yml.providers?.[providerId]?.models ?? []).find((x) => x.id === modelId);
    const efforts = (m?.thinking?.efforts ?? []).filter((e): e is ThinkingLevel =>
      (THINKING_LEVEL_ORDER as string[]).includes(e),
    );
    return m?.reasoning === true && efforts.length > 0 ? { efforts } : null;
  } catch {
    return null;
  }
}

export interface RepairThinkingResult {
  efforts: ThinkingLevel[];
  /** false = 配置本来就是对的，只是把进程重启一次让它生效 */
  written: boolean;
  reloaded: boolean;
}

/**
 * 单模型修复（思考菜单里的「修复思考能力」）。
 *
 * 三种情况必须区分开（旧实现一律报「上游没声明」，2026-11-12 误报实证）：
 *   1. 需要写入 → 写盘 + 重启
 *   2. 配置已正确、但当前进程是写盘之前启动的 → **仍然重启**（否则用户点了等于没点）
 *   3. 上游真的没声明、用户也没强制 → 抛错（UI 会引导「强制开启」）
 *
 * @param opts.forceEfforts 单模型强制档位；不给则只看上游声明
 */
export async function repairModelThinking(
  providerId: string,
  modelId: string,
  opts?: { forceEfforts?: ThinkingLevel[] },
): Promise<RepairThinkingResult> {
  const res = await syncProviderThinking(providerId, { only: [modelId], forceEfforts: opts?.forceEfforts });
  const written = res.changed[modelId];
  if (written) {
    return { efforts: written, written: true, reloaded: res.reloaded };
  }

  // 没有改动：可能是「本来就对」，也可能「上游真的不支持」
  const existing = await readYmlThinking(providerId, modelId);
  if (!existing) {
    throw new Error('上游 /v1/models 没有声明该模型支持思考，models.yml 里也没有对应配置');
  }
  // 配置已就绪 → 重启进程让它生效（等价于用户点「让它现在生效」）
  const reloaded = await reloadCurrentSession();
  return { efforts: existing.efforts, written: false, reloaded };
}
