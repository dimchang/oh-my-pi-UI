/**
 * AddModelModal — 「添加模型」弹窗：
 *
 *  第 1 步：
 *    A) 从内置 provider 预设列表选择（自动填充 baseUrl / api 类型，只需填 API Key）
 *    B) 或选「自定义」手动填写全部字段
 *    → 写入 ~/.omp/agent/models.yml → 重启 omp
 *
 *  两种保存方式：
 *    · 「保存并获取模型列表」→ 写配置 + 重启 + 第 2 步轮询自动发现
 *    · 「仅保存」（有手动模型 ID 时出现）→ 写配置 + 重启 + 手动 ID 直接入白名单 + 关闭
 *
 *  第 2 步：展示该 provider 拉回的模型列表 → 用户勾选要启用的（写 enabledModels 白名单）
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store';
import { rpc } from '../rpc-client';
import { modelKey } from '../utils/path-key';
import { reloadCurrentSession } from '../utils/reload-session';
import type { ModelInfo } from '../../shared/rpc-types';
import type { OmpProviderConfig } from '../../shared/ipc-channels';

// ---------------------------------------------------------------------------
// 内置 provider 预设（来自 OMP 17.x 源码：pi-ai registry + pi-catalog descriptors）
// ---------------------------------------------------------------------------

interface ProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  authUrl?: string;
  hint: string;
  cat: 'popular' | 'chinese' | 'local' | 'other';
}

const PRESET_GROUPS: { label: string; cat: ProviderPreset['cat']; items: ProviderPreset[] }[] = [
  {
    label: '热门',
    cat: 'popular',
    items: [
      { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', api: 'openai-completions', authUrl: 'https://platform.deepseek.com/api_keys', hint: 'sk-...', cat: 'popular' },
      { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', api: 'openai-responses', authUrl: 'https://platform.openai.com/api-keys', hint: 'sk-...', cat: 'popular' },
      { id: 'anthropic', name: 'Anthropic (Claude)', baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages', authUrl: 'https://console.anthropic.com/settings/keys', hint: 'sk-ant-...', cat: 'popular' },
      { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', api: 'openrouter', authUrl: 'https://openrouter.ai/keys', hint: 'sk-or-...', cat: 'popular' },
      { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', api: 'openai-completions', authUrl: 'https://console.groq.com/keys', hint: 'gsk_...', cat: 'popular' },
      { id: 'xai', name: 'xAI (Grok)', baseUrl: 'https://api.x.ai/v1', api: 'openai-completions', authUrl: 'https://console.x.ai/', hint: 'xai-...', cat: 'popular' },
      { id: 'moonshot', name: 'Moonshot / Kimi', baseUrl: 'https://api.moonshot.ai/v1', api: 'openai-completions', authUrl: 'https://platform.moonshot.ai/console/api-keys', hint: 'sk-...', cat: 'popular' },
      { id: 'cerebras', name: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', api: 'openai-completions', authUrl: 'https://cloud.cerebras.ai/platform/', hint: 'csk-...', cat: 'popular' },
      { id: 'fireworks', name: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1', api: 'openai-completions', authUrl: 'https://fireworks.ai/account/api-keys', hint: 'fw_...', cat: 'popular' },
      { id: 'mistral', name: 'Mistral AI', baseUrl: 'https://api.mistral.ai/v1', api: 'openai-completions', authUrl: 'https://console.mistral.ai/api-keys/', hint: '...', cat: 'popular' },
      { id: 'together', name: 'Together AI', baseUrl: 'https://api.together.xyz/v1', api: 'openai-completions', authUrl: 'https://api.together.xyz/settings/api-keys', hint: '...', cat: 'popular' },
      { id: 'nvidia', name: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1', api: 'openai-completions', authUrl: 'https://build.nvidia.com/', hint: 'nvapi-...', cat: 'popular' },
      { id: 'huggingface', name: 'Hugging Face', baseUrl: 'https://router.huggingface.co/v1', api: 'openai-completions', authUrl: 'https://huggingface.co/settings/tokens', hint: 'hf_...', cat: 'popular' },
      { id: 'google', name: 'Google (Gemini)', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', api: 'google-generative-ai', authUrl: 'https://aistudio.google.com/app/apikey', hint: 'AIza...', cat: 'popular' },
    ],
  },
  {
    label: '国内服务商',
    cat: 'chinese',
    items: [
      { id: 'zhipu-coding-plan', name: '智谱 GLM (Coding Plan)', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', api: 'openai-completions', authUrl: 'https://open.bigmodel.cn/usercenter/apikeys', hint: '...', cat: 'chinese' },
      { id: 'zai', name: '智谱 zAI (GLM)', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', api: 'openai-completions', authUrl: 'https://open.bigmodel.cn/usercenter/apikeys', hint: '...', cat: 'chinese' },
      { id: 'qianfan', name: '百度千帆 (Qianfan)', baseUrl: 'https://qianfan.baidubce.com/v2', api: 'openai-completions', authUrl: 'https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application', hint: '...', cat: 'chinese' },
      { id: 'firepass', name: 'Fire Pass (Kimi K2 Turbo)', baseUrl: 'https://api.fireworks.ai/inference/v1', api: 'openai-completions', authUrl: 'https://fireworks.ai/firepass', hint: 'fpk_...', cat: 'chinese' },
      { id: 'xiaomi', name: '小米 (Xiaomi)', baseUrl: 'https://api.xiaomi.com/v1', api: 'openai-completions', authUrl: 'https://platform.mi.com/', hint: '...', cat: 'chinese' },
      { id: 'minimax-code', name: 'MiniMax Code', baseUrl: 'https://api.minimax.chat/v1', api: 'openai-completions', authUrl: 'https://platform.minimaxi.com/document/Account%20&%20Keys', hint: '...', cat: 'chinese' },
      { id: 'minimax-code-cn', name: 'MiniMax Code CN', baseUrl: 'https://api.minimaxi.chat/v1', api: 'openai-completions', authUrl: 'https://platform.minimaxi.com/document/Account%20&%20Keys', hint: '...', cat: 'chinese' },
      { id: 'sakana', name: 'Sakana AI (Fugu/GLM)', baseUrl: 'https://api.sakana.ai/v1', api: 'openai-completions', authUrl: '', hint: '...', cat: 'chinese' },
      { id: 'siliconflow', name: 'SiliconFlow (硅基流动)', baseUrl: 'https://api.siliconflow.cn/v1', api: 'openai-completions', authUrl: 'https://cloud.siliconflow.cn/account/ak', hint: 'sk-...', cat: 'chinese' },
      { id: 'dashscope', name: '阿里 DashScope (通义)', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api: 'openai-completions', authUrl: 'https://dashscope.console.aliyun.com/apiKey', hint: 'sk-...', cat: 'chinese' },
    ],
  },
  {
    label: '本地 / 自托管',
    cat: 'local',
    items: [
      { id: 'ollama', name: 'Ollama (本地)', baseUrl: 'http://127.0.0.1:11434', api: 'ollama-chat', authUrl: '', hint: '（本地服务可留空）', cat: 'local' },
      { id: 'lm-studio', name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', api: 'openai-completions', authUrl: '', hint: '（本地服务可留空）', cat: 'local' },
      { id: 'vllm', name: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1', api: 'openai-completions', authUrl: '', hint: '（本地服务可留空）', cat: 'local' },
      { id: 'llama-cpp', name: 'llama.cpp', baseUrl: 'http://127.0.0.1:8080', api: 'ollama-chat', authUrl: '', hint: '（本地服务可留空）', cat: 'local' },
      { id: 'ollama-cloud', name: 'Ollama Cloud', baseUrl: 'https://cloud.ollama.com', api: 'ollama-chat', authUrl: '', hint: '...', cat: 'local' },
    ],
  },
  {
    label: '其他',
    cat: 'other',
    items: [
      { id: 'novita', name: 'Novita', baseUrl: 'https://api.novita.ai/openai/v1', api: 'openai-completions', authUrl: 'https://novita.ai/playground/key', hint: '...', cat: 'other' },
      { id: 'aimlapi', name: 'AIML API', baseUrl: 'https://api.aimlapi.com/v1', api: 'openai-completions', authUrl: '', hint: '...', cat: 'other' },
      { id: 'synthetic', name: 'Synthetic (zAI)', baseUrl: 'https://api.synthetic.ai/v1', api: 'openai-completions', authUrl: '', hint: '...', cat: 'other' },
      { id: 'nanogpt', name: 'NanoGPT', baseUrl: 'https://api.nanogpt.com/v1', api: 'openai-completions', authUrl: '', hint: '...', cat: 'other' },
      { id: 'perplexity', name: 'Perplexity', baseUrl: 'https://api.perplexity.ai', api: 'openai-completions', authUrl: '', hint: 'ppl-...', cat: 'other' },
      { id: 'vercel-ai-gateway', name: 'Vercel AI Gateway', baseUrl: 'https://gateway.vercel.sh/v1', api: 'openai-completions', authUrl: '', hint: '...', cat: 'other' },
      { id: 'cloudflare-ai-gateway', name: 'Cloudflare AI Gateway', baseUrl: 'https://gateway.ai.cloudflare.com/v1', api: 'openai-completions', authUrl: '', hint: '...', cat: 'other' },
      { id: 'litellm', name: 'LiteLLM Proxy', baseUrl: 'http://127.0.0.1:4000/v1', api: 'openai-completions', authUrl: '', hint: '（本地代理可留空）', cat: 'other' },
      { id: 'kilo', name: 'Kilo Gateway', baseUrl: 'https://kilo.run/v1', api: 'openai-completions', authUrl: '', hint: '...', cat: 'other' },
      { id: 'zenmux', name: 'ZenMux', baseUrl: 'https://api.zenmux.app/v1', api: 'openai-completions', authUrl: '', hint: '...', cat: 'other' },
      { id: 'umans', name: 'Umans AI', baseUrl: 'https://api.code.umans.ai', api: 'anthropic-messages', authUrl: '', hint: '...', cat: 'other' },
      { id: 'coreweave', name: 'CoreWeave Serverless', baseUrl: 'https://api.coreweave.com/v1', api: 'openai-completions', authUrl: '', hint: '...', cat: 'other' },
      { id: 'wafer-serverless', name: 'Wafer Serverless', baseUrl: 'https://pass.wafer.ai/v1', api: 'openai-completions', authUrl: '', hint: '...', cat: 'other' },
      { id: 'baseten', name: 'Baseten', baseUrl: 'https://app.baseten.co/v1', api: 'openai-completions', authUrl: '', hint: '...', cat: 'other' },
      { id: 'amazon-bedrock', name: 'AWS Bedrock', baseUrl: '', api: 'bedrock-converse-stream', authUrl: '', hint: '（需 AWS 凭证）', cat: 'other' },
      { id: 'azure', name: 'Azure OpenAI', baseUrl: '', api: 'azure-openai-responses', authUrl: '', hint: '（需 Azure 凭证）', cat: 'other' },
      { id: 'google-vertex', name: 'Google Vertex AI', baseUrl: '', api: 'google-vertex', authUrl: '', hint: '（需 GCP 凭证）', cat: 'other' },
    ],
  },
];

/** 扁平化用于搜索 */
const ALL_PRESETS: ProviderPreset[] = PRESET_GROUPS.flatMap((g) => g.items);

/** 支持自动发现模型列表的 api 类型 → discovery.type 映射 */
const DISCOVERY_BY_API: Record<string, string> = {
  'openai-completions': 'openai-models-list',
  'ollama-chat': 'ollama',
};

/** 不需要 API Key 的类型 */
const NO_KEY_NEEDED = new Set(['ollama-chat', 'bedrock-converse-stream', 'azure-openai-responses', 'google-vertex']);

interface Props {
  onClose(): void;
  onSaved(): void;
}

export const AddModelModal: React.FC<Props> = ({ onClose, onSaved }) => {
  const [step, setStep] = useState<1 | 2>(1);

  // ---- 选择模式 ----
  /** null = 未选（显示预设列表）；ProviderPreset = 选了预设；'custom' = 自定义 */
  const [selectedPreset, setSelectedPreset] = useState<ProviderPreset | 'custom' | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // ---- 表单字段 ----
  const [pid, setPid] = useState('');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [api, setApi] = useState('openai-completions');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [manualIds, setManualIds] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  // ---- 第 2 步：拉回的模型 + 勾选 ----
  const [discovered, setDiscovered] = useState<ModelInfo[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [polling, setPolling] = useState(false);
  const pollTimer = useRef<number | null>(null);
  /** 记住第 1 步填的手动模型 ID（跨步传递） */
  const savedManualIdsRef = useRef<string[]>([]);
  /** 写盘时跳过了进程重载（temp 会话 / 正在生成中）→ 第 2 步自动发现不可用，需针对性提示 */
  const [skippedRestart, setSkippedRestart] = useState(false);

  useEffect(() => () => {
    if (pollTimer.current) window.clearTimeout(pollTimer.current);
  }, []);

  // ---- 预设搜索过滤 ----
  const filteredGroups = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return PRESET_GROUPS;
    return PRESET_GROUPS
      .map((g) => ({ ...g, items: g.items.filter((p) => `${p.id} ${p.name}`.toLowerCase().includes(q)) }))
      .filter((g) => g.items.length > 0);
  }, [searchQuery]);

  // ---- 选中预设 → 自动填充表单 ----
  const selectPreset = useCallback((p: ProviderPreset) => {
    setSelectedPreset(p);
    setPid(p.id);
    setName(p.name);
    setBaseUrl(p.baseUrl);
    setApi(p.api);
    setApiKey('');
    setManualIds('');
    setError('');
  }, []);

  const selectCustom = useCallback(() => {
    setSelectedPreset('custom');
    setPid('');
    setName('');
    setBaseUrl('');
    setApi('openai-completions');
    setApiKey('');
    setManualIds('');
    setError('');
  }, []);

  const goBackToPresets = useCallback(() => {
    setSelectedPreset(null);
  }, []);

  const pidValid = /^[a-zA-Z0-9_-]+$/.test(pid);
  // Bedrock/Azure/Vertex 等 provider 不需要 baseUrl，跳过非空校验（依据 NO_KEY_NEEDED 同组）
  const canSave = pidValid && (baseUrl.trim().length > 0 || NO_KEY_NEEDED.has(api)) && (apiKey.trim().length > 0 || NO_KEY_NEEDED.has(api));
  /** 用户是否填了手动模型 ID */
  const hasManualIds = manualIds.split(/[,\s]+/).some((s) => s.trim().length > 0);

  /** 解析手动填写的模型 ID 列表 */
  const parsedManualIds = useMemo(
    () => manualIds.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean),
    [manualIds],
  );

  /** 构建要写入 models.yml 的 provider 配置 */
  const buildConfig = useCallback((): OmpProviderConfig => {
    const cfg: OmpProviderConfig = {
      baseUrl: baseUrl.trim(),
      api,
    };
    if (name.trim()) cfg.name = name.trim();
    if (apiKey.trim()) cfg.apiKey = apiKey.trim();
    else if (!NO_KEY_NEEDED.has(api)) cfg.auth = 'none';

    // 手动指定的模型 ID → 写为静态 models 条目
    if (parsedManualIds.length > 0) {
      cfg.models = parsedManualIds.map((id) => ({ id }));
    }
    // 没有手动 ID 且 API 类型支持发现 → 加 discovery 配置让 omp 自动拉取
    const discovery = DISCOVERY_BY_API[api];
    if (discovery && parsedManualIds.length === 0) {
      cfg.discovery = { type: discovery };
    }
    return cfg;
  }, [baseUrl, api, name, apiKey, parsedManualIds]);

  /** 写 models.yml + 重载当前会话进程。
   *  omp 的 ModelRegistry 只在进程启动时加载 models.yml，已在线进程看不到新 provider，
   *  不重载的话 pollModels 查旧进程 registry 会永远轮到空列表（表现为"获取失败"）。
   *  → 写盘后对当前会话进程 evict + 重新 acquire（-r 续接同一 JSONL），新进程即含新 provider。
   *  返回 true = 已重载；false = 跳过重载（temp 会话 / 正在生成中 / 无 cwd → 轮询将靠手动 ID fallback）。 */
  const writeAndRestart = useCallback(async (cfg: OmpProviderConfig): Promise<boolean> => {
    await window.omp.writeOmpProvider(pid.trim(), cfg);
    return reloadCurrentSession();
  }, [pid]);

  /** 轮询 getAvailableModels 获取新 provider 的模型 */
  const pollModels = useCallback((providerId: string, attempt = 0) => {
    // 重新 poll 前清掉旧定时器，避免重复点击产生并发轮询链
    if (pollTimer.current) {
      window.clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
    setPolling(true);
    const sp = useApp.getState().currentSessionPath ?? '';
    void rpc.getAvailableModels(sp).then((r) => {
      const list = (r.success && r.data ? r.data.models ?? [] : []).filter(
        (m) => m.provider === providerId,
      );
      if (list.length > 0) {
        setDiscovered(list);
        setChecked(new Set(list.map((m) => modelKey(m))));
        setPolling(false);
        return;
      }
      if (attempt < 6) {
        pollTimer.current = window.setTimeout(() => pollModels(providerId, attempt + 1), 1500);
      } else {
        setPolling(false);
      }
    }).catch(() => {
      if (attempt < 6) {
        pollTimer.current = window.setTimeout(() => pollModels(providerId, attempt + 1), 1500);
      } else {
        setPolling(false);
      }
    });
  }, []);

  // =========================================================================
  // 保存操作（两种模式）
  // =========================================================================

  /** 模式 A：保存 + 进入第 2 步自动获取 */
  const onSaveAndFetch = useCallback(async () => {
    setError('');
    setBusy('正在写入 models.yml 并重启 omp…');
    try {
      savedManualIdsRef.current = parsedManualIds; // 记住手动 ID
      const restarted = await writeAndRestart(buildConfig());
      setSkippedRestart(!restarted);
      setBusy('');
      setStep(2);
      // 如果有手动 ID，先作为 fallback 放进 discovered
      if (parsedManualIds.length > 0) {
        const pidVal = pid.trim();
        const manualModels: ModelInfo[] = parsedManualIds.map((id) => ({
          provider: pidVal,
          id,
          name: id,
        }));
        setDiscovered(manualModels);
        setChecked(new Set(manualModels.map((m) => modelKey(m))));
      }
      pollModels(pid.trim());
    } catch (e) {
      setBusy('');
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [writeAndRestart, buildConfig, pollModels, pid, parsedManualIds]);

  /** 模式 B：仅保存（不进入第 2 步）— 手动 ID 直接入白名单后关闭 */
  const onSaveOnly = useCallback(async () => {
    setError('');
    setBusy('正在保存…');
    try {
      const cfg = buildConfig();
      await writeAndRestart(cfg);
      // 手动 ID 直接写入 enabledModels 白名单
      if (parsedManualIds.length > 0) {
        const pidVal = pid.trim();
        const keys = parsedManualIds.map((id) => modelKey({ provider: pidVal, id }));
        const st = useApp.getState();
        const cur = st.enabledModels;
        if (cur !== undefined) {
          const next = Array.from(new Set([...cur, ...keys]));
          st.setEnabledModels(next);
        } else {
          st.setEnabledModels(keys);
        }
      }
      setBusy('');
      onSaved();
    } catch (e) {
      setBusy('');
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [buildConfig, writeAndRestart, parsedManualIds, pid, onSaved]);

  /** 第 2 步完成：把勾选结果并入 enabledModels 白名单 */
  const onFinish = useCallback(() => {
    const st = useApp.getState();
    const providerPrefix = `${pid.trim()}\u0000`;
    const checkedKeys = Array.from(checked);
    const cur = st.enabledModels;

    // 如果 discovered 为空但有之前存的手动 ID，也一并处理
    const allKeys = checkedKeys.length > 0
      ? checkedKeys
      : savedManualIdsRef.current.length > 0
        ? savedManualIdsRef.current.map((id) => modelKey({ provider: pid.trim(), id }))
        : [];

    if (cur !== undefined) {
      const next = Array.from(new Set([
        ...cur.filter((k) => !k.startsWith(providerPrefix)),
        ...allKeys,
      ]));
      st.setEnabledModels(next.length > 0 ? next : undefined);
    } else {
      st.setEnabledModels(allKeys.length > 0 ? allKeys : undefined);
    }
    onSaved();
  }, [pid, checked, onSaved]);

  const toggleCheck = useCallback((key: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const allChecked = useMemo(
    () => discovered.length > 0 && discovered.every((m) => checked.has(modelKey(m))),
    [discovered, checked],
  );

  /** 打开获取 API Key 的链接 */
  const openAuthUrl = useCallback((url: string) => {
    if (!url) return;
    if (window.omp?.openExternal) {
      void window.omp.openExternal(url);
    } else {
      window.open(url, '_blank');
    }
  }, []);

  // ===========================================================================
  // 渲染
  // ===========================================================================

  return (
    <div className="modal-overlay inner" onMouseDown={(e) => {
      if (e.target === e.currentTarget && !busy) onClose();
    }}>
      <div className="modal add-model-modal">
        <div className="add-model-head">
          <span className="modal-title">添加模型</span>
          <span className="add-model-subtitle">
            {step === 1
              ? selectedPreset === null ? '选择已知提供商或自定义' : `配置「${selectedPreset === 'custom' ? '自定义' : (selectedPreset as ProviderPreset).name}」`
              : `选择要启用的模型（${pid}）`
            }
          </span>
          <button className="settings-close" onClick={onClose} disabled={!!busy}>✕</button>
        </div>

        {/* ==================== 第 1 步 ==================== */}
        {step === 1 && (
          <div className="add-model-form">
            {/* ---- 阶段 A：预设选择 ---- */}
            {selectedPreset === null && (
              <>
                <div className="preset-search">
                  <input
                    className="form-input"
                    placeholder="🔍 搜索提供商（如 deepseek、kimi、ollama）…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    autoFocus
                  />
                </div>

                <div className="preset-grid">
                  {filteredGroups.map((group) => (
                    <div key={group.cat} className="preset-group">
                      <div className="preset-group-label">{group.label}</div>
                      <div className="preset-items">
                        {group.items.map((p) => (
                          <button
                            key={p.id}
                            className={`preset-card ${p.cat}`}
                            onClick={() => selectPreset(p)}
                            title={`${p.name}\n${p.baseUrl}\nAPI: ${p.api}${p.authUrl ? '\n点击前往获取 API Key' : ''}`}
                          >
                            <span className="preset-name">{p.name}</span>
                            <span className="preset-id">{p.id}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>

                {filteredGroups.every((g) => g.items.length === 0) && (
                  <div className="settings-placeholder">没有匹配的提供商</div>
                )}

                <div className="preset-custom-divider">
                  <span>或</span>
                </div>
                <button className="btn btn-block preset-custom-btn" onClick={selectCustom}>
                  + 自定义提供商（手动填写所有字段）
                </button>
              </>
            )}

            {/* ---- 阶段 B：表单 ---- */}
            {selectedPreset !== null && (
              <>
                {selectedPreset !== 'custom' && (
                  <div className="preset-selected-bar">
                    <span className="preset-selected-name">{(selectedPreset as ProviderPreset).name}</span>
                    <span className="preset-selected-id">ID: {(selectedPreset as ProviderPreset).id}</span>
                    {(selectedPreset as ProviderPreset).authUrl && (
                      <button
                        className="btn btn-sm btn-link preset-auth-btn"
                        onClick={() => openAuthUrl((selectedPreset as ProviderPreset).authUrl!)}
                        title="打开获取 API Key 的页面"
                      >
                        🔑 获取 API Key
                      </button>
                    )}
                    <button className="btn btn-sm btn-link preset-change-btn" onClick={goBackToPresets}>
                      ← 换一个
                    </button>
                  </div>
                )}
                {selectedPreset === 'custom' && (
                  <div className="preset-selected-bar">
                    <span className="preset-selected-name">自定义提供商</span>
                    <button className="btn btn-sm btn-link preset-change-btn" onClick={goBackToPresets}>
                      ← 从预设选择
                    </button>
                  </div>
                )}

                <label className="form-field">
                  <span className="form-label">提供商 ID *</span>
                  <input
                    className="form-input"
                    placeholder="如 deepseek（字母/数字/-/_）"
                    value={pid}
                    onChange={(e) => setPid(e.target.value)}
                    disabled={selectedPreset !== 'custom'}
                  />
                  {pid && !pidValid && <span className="form-error">只允许字母、数字、- 和 _</span>}
                </label>

                <label className="form-field">
                  <span className="form-label">显示名</span>
                  <input
                    className="form-input"
                    placeholder="如 深度求索 / DeepSeek（可选）"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>

                <label className="form-field">
                  <span className="form-label">API 地址 (baseUrl) *</span>
                  <input
                    className="form-input"
                    placeholder="如 https://api.deepseek.com/v1"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                  />
                </label>

                <label className="form-field">
                  <span className="form-label">API 类型</span>
                  <select className="form-input" value={api} onChange={(e) => setApi(e.target.value)}>
                    <option value="openai-completions">OpenAI 兼容 (openai-completions)</option>
                    <option value="openai-responses">OpenAI Responses API (openai-responses)</option>
                    <option value="anthropic-messages">Anthropic Claude (anthropic-messages)</option>
                    <option value="openrouter">OpenRouter (openrouter)</option>
                    <option value="google-generative-ai">Google Gemini (google-generative-ai)</option>
                    <option value="ollama-chat">Ollama (ollama-chat)</option>
                    <option value="azure-openai-responses">Azure OpenAI (azure-openai-responses)</option>
                    <option value="google-vertex">Google Vertex (google-vertex)</option>
                    <option value="bedrock-converse-stream">AWS Bedrock (bedrock-converse-stream)</option>
                  </select>
                </label>

                <label className="form-field">
                  <span className="form-label">
                    API Key {NO_KEY_NEEDED.has(api) ? '（可留空）' : '*'}
                  </span>
                  <div className="form-input-group">
                    <input
                      className="form-input"
                      type={showKey ? 'text' : 'password'}
                      placeholder={
                        selectedPreset !== 'custom'
                          ? `输入 ${(selectedPreset as ProviderPreset).name} API Key（明文存于 models.yml）`
                          : '输入 API Key（明文存于 ~/.omp/agent/models.yml）'
                      }
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                    />
                    <button
                      className="btn btn-sm form-eye"
                      onClick={() => setShowKey((v) => !v)}
                      title={showKey ? '隐藏' : '显示'}
                      type="button"
                    >
                      {showKey ? '🙈' : '👁'}
                    </button>
                  </div>
                  {selectedPreset !== 'custom' && (selectedPreset as ProviderPreset).hint && (
                    <span className="form-hint">格式提示：{(selectedPreset as ProviderPreset).hint}</span>
                  )}
                </label>

                <label className="form-field">
                  <span className="form-label">模型 ID（可选，逗号分隔）</span>
                  <input
                    className="form-input"
                    placeholder="如 deepseek-v4-pro,deepseek-v3；留空则尝试自动获取"
                    value={manualIds}
                    onChange={(e) => setManualIds(e.target.value)}
                  />
                  <span className="form-hint">
                    {hasManualIds
                      ? `已填 ${parsedManualIds.length} 个模型 ID，可直接「仅保存」或「保存并获取模型列表」`
                      : '留空则依赖 API 端点自动发现（部分服务商不支持）'}
                  </span>
                </label>

                {error && <div className="model-config-error">{error}</div>}
                {busy && <div className="model-config-busy">{busy}</div>}

                <div className="modal-actions">
                  <button className="btn" onClick={goBackToPresets}>返回</button>
                  <button className="btn" onClick={onClose} disabled={!!busy}>取消</button>
                  {hasManualIds && (
                    <button
                      className="btn btn-primary"
                      onClick={() => void onSaveOnly()}
                      disabled={!canSave || !!busy}
                    >
                      仅保存
                    </button>
                  )}
                  <button
                    className="btn btn-primary"
                    onClick={() => void onSaveAndFetch()}
                    disabled={!canSave || !!busy}
                  >
                    保存并获取模型列表
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* ==================== 第 2 步 ==================== */}
        {step === 2 && (
          <div className="add-model-form">
            {polling && (
              <div className="model-config-busy">正在获取模型列表…</div>
            )}
            {!polling && discovered.length === 0 && skippedRestart && (
              <div className="model-config-busy">
                临时会话 / 正在生成中，自动发现暂不可用。可返回上一步手动填写模型 ID 后点击「仅保存」。
              </div>
            )}
            {!polling && discovered.length === 0 && !skippedRestart && savedManualIdsRef.current.length === 0 && (
              <div className="model-config-error">
                未能获取到「{pid}」的模型列表。可能原因：API Key / baseUrl 有误，或该端点不支持自动发现。
                可返回上一步手动填写模型 ID 后点击「仅保存」。
              </div>
            )}
            {discovered.length > 0 && (
              <>
                <label className="provider-model-row all-toggle">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={() => {
                      if (allChecked) setChecked(new Set());
                      else setChecked(new Set(discovered.map((m) => modelKey(m))));
                    }}
                  />
                  <span className="provider-model-name">全选（{checked.size}/{discovered.length}）</span>
                </label>
                <div className="add-model-list">
                  {discovered.map((m) => {
                    const key = modelKey(m);
                    return (
                      <label key={key} className="provider-model-row" title={key}>
                        <input
                          type="checkbox"
                          checked={checked.has(key)}
                          onChange={() => toggleCheck(key)}
                        />
                        <span className="provider-model-name">{m.name ?? m.id}</span>
                      </label>
                    );
                  })}
                </div>
              </>
            )}
            <div className="modal-actions">
              <button className="btn" onClick={() => { setSkippedRestart(false); setStep(1); }}>上一步</button>
              {!polling && discovered.length === 0 && !skippedRestart && savedManualIdsRef.current.length === 0 && (
                <button className="btn" onClick={() => pollModels(pid.trim())}>重试获取</button>
              )}
              {!polling && discovered.length === 0 && savedManualIdsRef.current.length > 0 && (
                <span className="form-hint" style={{ marginRight: 'auto' }}>
                  自动获取失败，但已使用你填写的 {savedManualIdsRef.current.length} 个手动模型 ID
                </span>
              )}
              <button
                className="btn btn-primary"
                onClick={onFinish}
                disabled={polling}
              >
                完成
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
