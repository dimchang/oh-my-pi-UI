/**
 * available-models.ts — 健壮的「可用模型」获取器。
 *
 * 背景（bug 根因）：
 *   omp 的 get_available_models RPC 把整份模型目录（内置 ~5700 + 各 provider 通过
 *   discovery 实时拉取的 /models）塞进【单帧】JSON 返回。当目录过大时，omp 不是返回
 *   截断数据，而是直接返回错误帧：{ success:false, error:"RPC response exceeded the
 *   transport limit" }。于是所有消费方（ModelPicker / SettingsModelConfig）拿不到任何
 *   模型，UI 整片空白。
 *
 * 本模块把「获取」与「回退」封装起来，保证 UI 永远有东西可显示：
 *   1. 优先走 omp 实时 RPC；成功则更新内存缓存 + 落盘缓存（userData/available-models-cache.json）。
 *   2. 失败（transport limit / 超时 / 进程异常）时回退到：
 *        - 上一次成功的内存缓存（同会话内有效）
 *        - 跨重启的落盘缓存
 *        - 本地 models.yml 里显式配置的 models（含新增 provider，确保不空白）
 *      合并去重后返回，并标记 fallback=true 让 UI 给出温和提示（而非硬错/空白）。
 */

import { rpc } from '../rpc-client';
import type { ModelInfo, AvailableModelsData } from '../../shared/rpc-types';
import type { OmpModelsConfig, OmpModelDefinition } from '../../shared/ipc-channels';
import { modelKey } from './path-key';

export interface AvailableModelsResult {
  /** 合并后的模型列表（可能来自实时 RPC 或回退） */
  models: ModelInfo[];
  /** true = 来自缓存/本地配置回退，非 omp 实时；UI 应给出温和提示 */
  fallback: boolean;
  /** 回退原因（实时失败时的错误信息），用于提示文案 */
  reason?: string;
}

// 内存缓存（同渲染会话内有效，避免每次刷新都打 RPC）
let memoryCache: ModelInfo[] | null = null;
let cacheLoaded = false;

/** 从本地 models.yml 的显式 models 生成 ModelInfo（discovery 实时拉取的不会在这里，只有手写/落盘的） */
function modelsFromYml(yml: OmpModelsConfig): ModelInfo[] {
  const out: ModelInfo[] = [];
  const providers = yml.providers ?? {};
  for (const [pid, cfg] of Object.entries(providers)) {
    if (!cfg) continue;
    const list: OmpModelDefinition[] = cfg.models ?? [];
    for (const m of list) {
      out.push({
        provider: pid,
        id: m.id,
        name: m.name ?? m.id,
        contextWindow: m.contextWindow,
      });
    }
  }
  return out;
}

/**
 * 逐条字段补全：新结果提供了什么就覆盖什么，**没提供的沿用旧值**。
 *
 * 为什么不能直接换掉：不同 provider 给的信息量差很多（xiaomi 的 /models 只有
 * {id, object, owned_by}，contextWindow/name 全无；omp 的 RPC 结果 name 常等于 id）。
 * 若整条替换，一次「信息更少」的刷新就会把缓存里已知的 ctx / 真名 / 倍率抹成空。
 *
 * 这也是「缺字段不显示 0」的第二道保险：合并后仍为 undefined → UI 条件渲染跳过。
 */
export function mergeModelFields(fresh: ModelInfo, prev?: ModelInfo): ModelInfo {
  if (!prev) return fresh;
  const merged: ModelInfo = { ...prev, ...fresh };
  merged.id = fresh.id;
  merged.provider = fresh.provider;
  // 名称：fresh 的 name 缺失或只是拿 id 顶替（omp discovery 的常见形态：name === id）
  // 时，优先沿用旧的真名（如缓存里的 "Hy3"），否则显示一串 id 更难读。
  const freshHasRealName = !!fresh.name && fresh.name !== fresh.id;
  if (!freshHasRealName) {
    const prevReal = prev.name && prev.name !== prev.id ? prev.name : undefined;
    merged.name = prevReal ?? fresh.name ?? prev.name ?? fresh.id;
  }
  merged.contextWindow = fresh.contextWindow ?? prev.contextWindow;
  merged.maxTokens = fresh.maxTokens ?? prev.maxTokens;
  merged.credits = fresh.credits ?? prev.credits;
  // 上游能力声明：omp 的结果永远不含（discovery 不解析），只可能来自直拉/缓存，
  // 所以这里不能因为 fresh 没有就丢掉。
  merged.upstreamReasoning = fresh.upstreamReasoning ?? prev.upstreamReasoning;
  merged.upstreamEfforts = fresh.upstreamEfforts ?? prev.upstreamEfforts;
  return merged;
}

/**
 * 按 provider 粒度合并（缓存清理的核心）。
 *
 * 旧实现是「并集 + 只增不减」：任何进过缓存的 id 永不淘汰 → 上游下线的模型永久残留
 * （实测 LocalWBAPI：缓存 60 条 vs 上游 49 条，多出 hy4-preview-dev/-f/-exp1..3、
 * glm-5.1、kimi-k2.6/2.7、minimax-m3 等 11 个幽灵条目）。
 *
 * 新语义：
 *   1. `fresh` 里出现的 provider → 该 provider 的旧条目**整体作废**，只保留本次结果
 *      （旧条目仅用于逐字段补全）。fresh 里出现 = 本次真的拉到了这个 provider 的列表。
 *   2. fresh 里没有的 provider → 旧缓存原样保留（403/超时/空数组都不会误删模型）。
 *   3. `extra`（models.yml 显式声明的 models）→ 只做并集补齐，不触发整组替换
 *      （yml 里可能只写了部分模型，用它替换会丢 omp 目录里的同 provider 其他模型）。
 *
 * 顺序：fresh（保持原序）→ extra 补齐 → 未被覆盖的旧缓存。
 *
 * @param opts.pruneMissingProviders 仅在「fresh 是权威目录」时传 true（即 omp RPC 成功）。
 *   含义：本次既没出现在 fresh、也没在 models.yml 里声明的 provider，说明它已经不存在了
 *   （用户删除了 provider），旧缓存不该继续展示。RPC 失败时**绝不能**传 true——
 *   直拉只能覆盖配置了 discovery 且本次拉取成功的 provider，其余（403/超时/无 discovery）
 *   必须靠旧缓存兜住。
 * @param opts.keepProviders 额外豁免的 provider（yml 里声明过、但只配了 discovery 没写
 *   models 的那些——它们不会出现在 extra 里，却仍是用户配置过的）。
 */
export function mergeProviderScoped(
  cached: ModelInfo[],
  fresh: ModelInfo[],
  extra: ModelInfo[] = [],
  opts?: { pruneMissingProviders?: boolean; keepProviders?: Iterable<string> },
): ModelInfo[] {
  const byProvider = (list: ModelInfo[]): Map<string, ModelInfo[]> => {
    const m = new Map<string, ModelInfo[]>();
    for (const it of list) {
      const arr = m.get(it.provider);
      if (arr) arr.push(it);
      else m.set(it.provider, [it]);
    }
    return m;
  };
  const freshByProv = byProvider(fresh);
  const cachedByProv = byProvider(cached);

  const out: ModelInfo[] = [];
  const seen = new Set<string>();
  const push = (m: ModelInfo, prev?: ModelInfo) => {
    const k = modelKey(m);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(mergeModelFields(m, prev));
  };

  // 1) 本次拉到数据的 provider：整体替换（旧条目只用于字段补全）
  for (const [pid, list] of freshByProv) {
    const prevList = cachedByProv.get(pid) ?? [];
    for (const m of list) push(m, prevList.find((p) => p.id === m.id));
  }
  // 2) yml 显式 models：并集补齐
  for (const m of extra) push(m, cachedByProv.get(m.provider)?.find((p) => p.id === m.id));
  // 3) 本次没拿到数据的 provider：保留旧缓存（除非 fresh 是权威目录且它连 yml 都没声明）
  const extraProv = new Set<string>([...extra.map((m) => m.provider), ...(opts?.keepProviders ?? [])]);
  for (const [pid, list] of cachedByProv) {
    if (freshByProv.has(pid)) continue;
    if (opts?.pruneMissingProviders && !extraProv.has(pid)) continue;
    for (const m of list) push(m);
  }
  return out;
}

/**
 * 删除 provider 后同步清理模型缓存（内存 + 落盘）。
 *
 * 为什么必须有：RPC 失败（本机常态）时旧缓存是唯一数据源，删掉 yml 条目和进程后，
 * 缓存里那个 provider 的模型会因为「本次没拿到它、无法证明它不存在」而被继续保留 ——
 * 表现为「右键删除了 provider，列表里还在」。
 */
export async function dropProviderFromCache(providerId: string): Promise<void> {
  const cur = memoryCache ?? (await ensureDiskCache()) ?? [];
  if (!cur.some((m) => m.provider === providerId)) return;
  persistCache(cur.filter((m) => m.provider !== providerId));
}


/** 加载落盘缓存（仅首次） */
async function ensureDiskCache(): Promise<ModelInfo[] | null> {
  if (cacheLoaded) return memoryCache;
  cacheLoaded = true;
  try {
    if (typeof window.omp.loadModelsCache === 'function') {
      const fromDisk = await window.omp.loadModelsCache();
      if (Array.isArray(fromDisk) && fromDisk.length > 0) memoryCache = fromDisk;
    }
  } catch {
    /* 忽略：缓存读取失败不致命 */
  }
  return memoryCache;
}

function persistCache(models: ModelInfo[]): void {
  memoryCache = models;
  cacheLoaded = true;
  // 落盘为 fire-and-forget，失败不影响主流程
  try {
    if (typeof window.omp.saveModelsCache === 'function') {
      void window.omp.saveModelsCache(models);
    }
  } catch {
    /* 忽略 */
  }
}

/**
 * 获取可用模型列表。永不直接抛错——失败时回退到缓存 + 本地配置。
 * @param sp 会话路径（路由到对应 omp 进程）
 * @param opts.cacheOnly 启动预热用：只读落盘缓存 + 本地 models.yml，不打 omp RPC、
 *        不做 provider 网络直拉——避免每次启动都触发 get_available_models
 *        （目录过大时必超 transport limit，纯浪费）。
 */
export async function fetchAvailableModels(
  sp: string,
  opts?: { cacheOnly?: boolean },
): Promise<AvailableModelsResult> {
  if (opts?.cacheOnly) {
    const cached = await ensureDiskCache();
    let ymlModels: ModelInfo[] = [];
    try {
      const yml: OmpModelsConfig = await window.omp.readModelsConfig();
      ymlModels = modelsFromYml(yml);
    } catch {
      /* 忽略：本地配置读取失败不致命 */
    }
    const merged = mergeProviderScoped(cached ?? [], [], ymlModels);
    return { models: merged, fallback: merged.length === 0 };
  }

  // 1) 先走 omp 实时 RPC；失败不致命（下面回退链兜底）
  let rpcModels: ModelInfo[] = [];
  let rpcOk = false;
  let reason: string | undefined;
  try {
    const r = await rpc.getAvailableModels(sp);
    if (r.success && (r.data as AvailableModelsData | undefined)?.models) {
      rpcModels = (r.data as AvailableModelsData).models ?? [];
      rpcOk = true;
    } else {
      throw new Error((r as { error?: string }).error ?? 'get_available_models 返回失败');
    }
  } catch (e) {
    reason = e instanceof Error ? e.message : String(e);
  }

  // 2) 本地 models.yml 的显式 models 永远并入：omp 的目录可能不含自定义 provider
  //    （issue：omp RPC 成功但目录里没有任何自定义 provider 的模型，UI 全部显示 0/0）
  let ymlModels: ModelInfo[] = [];
  let declared: string[] = [];
  try {
    const yml: OmpModelsConfig = await window.omp.readModelsConfig();
    ymlModels = modelsFromYml(yml);
    declared = Object.keys(yml.providers ?? {});
  } catch {
    /* 忽略：本地配置读取失败不致命 */
  }

  // 3) yml 里声明了、但当前结果里没有模型的 provider → 按其 discovery 配置直拉 /models 补齐
  //    （RPC 失败时 rpcModels 为空 → 所有声明过的 provider 都会尝试直拉，与原回退行为一致）
  let discoveredModels: ModelInfo[] = [];
  const have = new Set(rpcModels.map((m) => m.provider));
  const missing = declared.filter((pid) => !have.has(pid));
  if (missing.length > 0 && typeof window.omp.fetchProviderModels === 'function') {
    try {
      discoveredModels = await window.omp.fetchProviderModels();
    } catch {
      /* 忽略：直拉失败不致命 */
    }
  }

  // 4) 合并：
  //    - fresh = 本次真正拉到数据的集合（RPC 成功用 RPC 结果，否则用直拉结果）
  //    - fresh 里出现的 provider 整体替换旧缓存 → 上游已下线的幽灵条目被淘汰
  //    - fresh 里没有的 provider 保留旧缓存 → 某次 403/超时不会让该 provider 变空
  //    注意 RPC 成功时也把缓存传进去：它只用于「字段补全」（omp 的 name 常等于 id、
  //    且不含 credits），新鲜 provider 的成员资格仍由 fresh 决定。
  const cached = (await ensureDiskCache()) ?? [];
  // RPC 成功时，直拉结果只取「RPC 里没有的 provider」（否则同一 provider 两套命名会打架：
  // omp 给 name=id，直拉给上游真名）。
  const fresh = rpcOk
    ? [...rpcModels, ...discoveredModels.filter((m) => !have.has(m.provider))]
    : discoveredModels;
  const merged = mergeProviderScoped(cached, fresh, ymlModels, {
    pruneMissingProviders: rpcOk,
    keepProviders: declared,
  });
  // 有数据才落盘，空结果不覆盖已有缓存
  if (merged.length > 0) persistCache(merged);
  return { models: merged, fallback: !rpcOk, reason };
}
