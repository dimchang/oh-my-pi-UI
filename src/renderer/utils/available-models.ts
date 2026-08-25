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

/** 多列表去重合并（按 provider/id 维度），保持先出现的优先 */
function mergeDedup(...lists: ModelInfo[][]): ModelInfo[] {
  const map = new Map<string, ModelInfo>();
  for (const list of lists) {
    for (const m of list) {
      const k = modelKey(m);
      if (!map.has(k)) map.set(k, m);
    }
  }
  return [...map.values()];
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
 */
export async function fetchAvailableModels(sp: string): Promise<AvailableModelsResult> {
  try {
    const r = await rpc.getAvailableModels(sp);
    if (r.success && (r.data as AvailableModelsData | undefined)?.models) {
      const models = (r.data as AvailableModelsData).models ?? [];
      persistCache(models);
      return { models, fallback: false };
    }
    throw new Error((r as { error?: string }).error ?? 'get_available_models 返回失败');
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const cached = await ensureDiskCache();
    let ymlModels: ModelInfo[] = [];
    try {
      const yml: OmpModelsConfig = await window.omp.readModelsConfig();
      ymlModels = modelsFromYml(yml);
    } catch {
      /* 忽略：本地配置读取失败不致命 */
    }
    // 绕过 omp：直接按 models.yml 的 discovery 配置拉各 provider 的模型列表，
    // 这样「新添加但 omp 目录过大拉不到」的 provider 也能被显示与选择。
    let discoveredModels: ModelInfo[] = [];
    try {
      if (typeof window.omp.fetchProviderModels === 'function') {
        discoveredModels = await window.omp.fetchProviderModels();
      }
    } catch {
      /* 忽略：直拉失败不致命 */
    }
    const base = cached ?? [];
    const merged = mergeDedup(base, ymlModels, discoveredModels);
    // 回退结果也落盘：下次刷新（或重启）直接从缓存取，避免每次都打网络直拉。
    // 仅在有数据时缓存，空结果不覆盖已有缓存。
    if (merged.length > 0) persistCache(merged);
    return { models: merged, fallback: true, reason };
  }
}
