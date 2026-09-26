/**
 * chat-bridge-core.ts — 渠道无关的「IM ↔ OMP 会话」桥接核心。
 *
 * 企微桥与飞书桥共享的逻辑全部在这里：绑定表（chatKey ↔ sessionPath）、
 * 回合管理（流式聚合 + 节流 + 终态收尾）、/bind /sessions /reset 等命令路由、
 * 配置持久化。渠道差异（收发原语、tempKey 前缀、配置文件）由 ChatTransport 注入。
 *
 * 流式差异说明：企微有原生 stream 消息（同 req_id 刷新），飞书没有——
 * 飞书 transport 把 flush 落到「本地缓冲」，agent_end 时一次性回复终稿。
 * 核心只管按节流回调 transport.flush，渠道自己决定怎么消费。
 */

import { listSessions } from '../src/main/session-store';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import type { OmpProcessPool } from './omp-pool';
import type { ApprovalMode, WecomBinding, WecomBridgeStatus } from '../src/shared/ipc-channels';

/** 流式刷新节流间隔 */
export const STREAM_FLUSH_MS = 1_000;
/** 单条流式消息内容上限（防意外巨量推送） */
export const STREAM_MAX_CHARS = 20_000;

/** 渠道Incoming消息的统一形状（各渠道 client 解析后转成这个） */
export interface BridgeIncomingMessage {
  /** 回复时透传（企微 = 回调 req_id；飞书 = message_id，用于 reply） */
  reqId: string;
  /** 消息排重 id */
  msgid: string;
  /** 会话标识：群聊 = chatid，单聊 = userid */
  chatKey: string;
  chatType: 'single' | 'group';
  /** 群聊 @ 前缀剥离等渠道特定的文本清洗 */
  text: string;
  /** true = 支持 reqId 关联的流式回复（企微 stream）；false = 只能终稿回复（飞书） */
  supportsStream: boolean;
}

/** 渠道收发原语。生命周期由渠道自己管理（连接/重连/凭证），核心只调用。 */
export interface ChatTransport {
  /** 当前是否在线（status().connected 用） */
  readonly connected: boolean;
  /** 发一条「关联消息」的即时回复（错误提示等短消息；飞书=reply，企微=text respond） */
  respondText(reqId: string, content: string): Promise<void>;
  /** 流式刷新（仅 supportsStream 的渠道真正实现；飞书空实现） */
  respondStream(reqId: string, streamId: string, content: string, finish: boolean): Promise<void>;
}

export interface BridgeConfig {
  enabled: boolean;
  /** 渠道凭证（企微=botId+secret；飞书=appId+appSecret） */
  botId: string;
  secret: string;
  cwd: string;
  approvalMode: ApprovalMode;
  injectMode: 'steer' | 'followUp';
  bindings: WecomBinding[];
}

export interface BridgeDeps {
  pool: OmpProcessPool;
  resolveHooks: () => Promise<string[]>;
  defaultCwd: string;
  onStatusChange(status: WecomBridgeStatus): void;
  log(line: string): void;
  /** 渠道名（日志前缀 + /status 显示） */
  channelLabel: string;
}

/** chatKey → 进行中的流式回合 */
interface ActiveTurn {
  chatKey: string;
  sessionPath: string;
  reqId: string;
  streamId: string;
  /** 聚合的纯文本 */
  text: string;
  lastFlushAt: number;
  startedAt: number;
  flushTimer: NodeJS.Timeout | null;
  finished: boolean;
  /** 渠道是否支持流式（不支持时 text 只累积，agent_end 一次性发） */
  supportsStream: boolean;
}

export function bridgeConfigFile(name: string): string {
  return path.join(app.getPath('userData'), `${name}-bridge.json`);
}

export function parseBridgeConfig(raw: string): BridgeConfig {
  try {
    const j = JSON.parse(raw) as Partial<BridgeConfig>;
    const modes = new Set(['steer', 'followUp']);
    const approvals = new Set(['yolo', 'write', 'always-ask']);
    const bindings: WecomBinding[] = [];
    if (Array.isArray(j.bindings)) {
      for (const b of j.bindings) {
        if (!b || typeof b.chatKey !== 'string' || typeof b.sessionPath !== 'string') continue;
        if (!b.chatKey || !b.sessionPath) continue;
        bindings.push({
          chatKey: b.chatKey,
          sessionPath: b.sessionPath,
          chatType: b.chatType === 'group' ? 'group' : 'single',
          title: typeof b.title === 'string' ? b.title : '',
          createdAt: typeof b.createdAt === 'number' ? b.createdAt : Date.now(),
        });
      }
    }
    return {
      enabled: j.enabled === true,
      botId: typeof j.botId === 'string' ? j.botId : '',
      secret: typeof j.secret === 'string' ? j.secret : '',
      cwd: typeof j.cwd === 'string' ? j.cwd : '',
      approvalMode: approvals.has(j.approvalMode as ApprovalMode) ? (j.approvalMode as ApprovalMode) : 'write',
      injectMode: modes.has(j.injectMode as 'steer' | 'followUp') ? (j.injectMode as 'steer' | 'followUp') : 'steer',
      bindings,
    };
  } catch {
    return { enabled: false, botId: '', secret: '', cwd: '', approvalMode: 'write', injectMode: 'steer', bindings: [] };
  }
}

export class ChatBridgeCore {
  /** 当前 transport（渠道 connect/disconnect 时更新） */
  private transport: ChatTransport | null = null;
  /** transport 是否支持流式（startTurn 时快照进 turn） */
  private transportSupportsStream = false;
  private cfg: BridgeConfig;
  private deps: BridgeDeps | null = null;
  private active = new Map<string, ActiveTurn>();
  /** 磁盘缓存（mtime 失效） */
  private cfgCache: { mtimeMs: number; data: BridgeConfig } | null = null;
  /** 10 分钟流式窗口（渠道可覆盖；0 = 不限） */
  readonly streamWindowMs: number;

  constructor(
    private readonly configFileName: string,
    private readonly tempPrefix: string,
    streamWindowMs = 0,
  ) {
    this.cfg = { enabled: false, botId: '', secret: '', cwd: '', approvalMode: 'write', injectMode: 'steer', bindings: [] };
    this.streamWindowMs = streamWindowMs;
  }

  /** 渠道 init：装 transport + 读配置。凭证齐全且 enabled 时由渠道自行 connect。 */
  async init(deps: BridgeDeps, transport: ChatTransport, supportsStream: boolean): Promise<BridgeConfig> {
    this.deps = deps;
    this.transport = transport;
    this.transportSupportsStream = supportsStream;
    this.cfg = await this.loadConfig();
    return this.cfg;
  }

  async loadConfig(): Promise<BridgeConfig> {
    const file = bridgeConfigFile(this.configFileName);
    try {
      const st = await fs.promises.stat(file);
      if (this.cfgCache && this.cfgCache.mtimeMs === st.mtimeMs) return this.cfgCache.data;
      const raw = await fs.promises.readFile(file, 'utf8');
      const data = parseBridgeConfig(raw);
      this.cfgCache = { mtimeMs: st.mtimeMs, data };
      return data;
    } catch {
      return { enabled: false, botId: '', secret: '', cwd: '', approvalMode: 'write', injectMode: 'steer', bindings: [] };
    }
  }

  async saveConfig(cfg: BridgeConfig): Promise<BridgeConfig> {
    // 绑定去重（同 chatKey 只留最新）
    const seen = new Set<string>();
    cfg.bindings = (cfg.bindings ?? []).filter((b) => {
      if (seen.has(b.chatKey)) return false;
      seen.add(b.chatKey);
      return true;
    });
    await fs.promises.writeFile(bridgeConfigFile(this.configFileName), JSON.stringify(cfg, null, 2), 'utf8');
    this.cfg = cfg;
    this.cfgCache = null;
    this.emitStatus();
    return cfg;
  }

  status(): WecomBridgeStatus {
    return {
      enabled: this.cfg.enabled,
      connected: this.transport?.connected ?? false,
      botId: this.cfg.botId,
      cwd: this.cfg.cwd,
      approvalMode: this.cfg.approvalMode,
      injectMode: this.cfg.injectMode,
      bindings: this.cfg.bindings.map((b) => ({ ...b })),
      activeChats: [...this.active.keys()],
    };
  }

  private emitStatus(): void {
    this.deps?.onStatusChange(this.status());
  }

  get config(): BridgeConfig {
    return this.cfg;
  }

  /** 渠道断开时收尾全部活跃回合。 */
  onTransportClosed(): void {
    for (const turn of this.active.values()) this.finishTurn(turn, turn.text || '（连接已断开）');
    this.active.clear();
    this.emitStatus();
  }

  // ---- 消息入口（渠道 client 的 onMessage 转到这里）----

  async handleMessage(msg: BridgeIncomingMessage): Promise<void> {
    const deps = this.deps;
    const transport = this.transport;
    if (!deps || !transport) return;
    const text = msg.text.trim();
    if (!text) return;

    if (text.startsWith('/')) {
      await this.handleCommand(msg, text);
      return;
    }

    const binding = this.cfg.bindings.find((b) => b.chatKey === msg.chatKey);
    const sessionPath = binding?.sessionPath;
    if (!sessionPath) {
      await this.autoBind(msg, text);
      return;
    }

    const turn = this.active.get(msg.chatKey);
    try {
      const cmd = turn
        ? (this.cfg.injectMode === 'followUp'
            ? { type: 'follow_up', message: text }
            : { type: 'steer', message: text })
        : { type: 'prompt', message: text };
      await deps.pool.send(sessionPath, cmd as never, 30_000);
      if (!turn) this.startTurn(msg.chatKey, sessionPath, msg);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      // 进程离线（LRU 淘汰/退出）→ 重新拉起再投
      if (/not online|spawn|exited|timeout/i.test(errMsg)) {
        try {
          const cwd = this.cfg.cwd || deps.defaultCwd;
          const hooks = await deps.resolveHooks();
          await deps.pool.acquire(sessionPath, cwd, this.cfg.approvalMode, hooks);
          await deps.pool.send(sessionPath, { type: 'prompt', message: text } as never, 30_000);
          this.startTurn(msg.chatKey, sessionPath, msg);
          return;
        } catch (e2) {
          await this.safeRespond(msg.reqId, `会话不可用：${e2 instanceof Error ? e2.message : String(e2)}`);
          return;
        }
      }
      await this.safeRespond(msg.reqId, `发送失败：${errMsg}`);
    }
  }

  /** 首条消息自动建会话并绑定。 */
  private async autoBind(msg: BridgeIncomingMessage, firstText: string): Promise<void> {
    const deps = this.deps!;
    const tempKey = this.tempPrefix + randomUUID();
    const cwd = this.cfg.cwd || deps.defaultCwd;
    const hooks = await deps.resolveHooks();
    try {
      await deps.pool.acquireNew(tempKey, cwd, this.cfg.approvalMode, undefined, hooks);
      this.cfg.bindings.push({
        chatKey: msg.chatKey,
        sessionPath: tempKey,
        chatType: msg.chatType,
        title: firstText.slice(0, 30),
        createdAt: Date.now(),
      });
      await this.saveConfig(this.cfg);
      await deps.pool.send(tempKey, { type: 'prompt', message: firstText } as never, 30_000);
      this.startTurn(msg.chatKey, tempKey, msg);
      this.emitStatus();
    } catch (e) {
      await this.safeRespond(msg.reqId, `新建会话失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ---- 命令 ----

  private async handleCommand(msg: BridgeIncomingMessage, text: string): Promise<void> {
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(' ').trim();
    switch (cmd) {
      case 'bind': {
        const target = await this.resolveSessionArg(arg);
        if (!target) {
          await this.safeRespond(msg.reqId, '用法：/bind <会话路径或序号>（序号见 /sessions）');
          return;
        }
        const existing = this.cfg.bindings.find((b) => b.chatKey === msg.chatKey);
        if (existing) existing.sessionPath = target.path;
        else this.cfg.bindings.push({ chatKey: msg.chatKey, sessionPath: target.path, chatType: msg.chatType, title: target.title, createdAt: Date.now() });
        await this.saveConfig(this.cfg);
        await this.safeRespond(msg.reqId, `已绑定会话：${target.title || target.path}`);
        return;
      }
      case 'unbind': {
        this.cfg.bindings = this.cfg.bindings.filter((b) => b.chatKey !== msg.chatKey);
        await this.saveConfig(this.cfg);
        await this.safeRespond(msg.reqId, '已解除绑定。下次发消息将新建会话。');
        return;
      }
      case 'new': {
        this.cfg.bindings = this.cfg.bindings.filter((b) => b.chatKey !== msg.chatKey);
        await this.saveConfig(this.cfg);
        await this.autoBind(msg, arg || '（新会话）');
        return;
      }
      case 'sessions': {
        const list = await this.listSessions();
        const lines = list.slice(0, 20).map((s, i) => `${i + 1}. ${s.title} (${s.mtime})`);
        await this.safeRespond(msg.reqId, lines.length ? `最近会话：\n${lines.join('\n')}\n\n用 /bind <序号> 绑定` : '没有可用会话');
        return;
      }
      case 'reset': {
        const turn = this.active.get(msg.chatKey);
        if (turn) this.finishTurn(turn, turn.text || '（已重置）');
        this.active.delete(msg.chatKey);
        await this.safeRespond(msg.reqId, '已重置当前聊天的桥接状态。');
        return;
      }
      case 'status': {
        const s = this.status();
        await this.safeRespond(msg.reqId,
          `渠道：${this.deps?.channelLabel ?? ''}\n连接：${s.connected ? '正常' : '断开'}\n注入模式：${s.injectMode}\n绑定数：${s.bindings.length}\n活跃回合：${s.activeChats.length}`);
        return;
      }
      case 'steer':
      case 'followup': {
        this.cfg.injectMode = cmd === 'steer' ? 'steer' : 'followUp';
        await this.saveConfig(this.cfg);
        await this.safeRespond(msg.reqId, `注入模式已切换为 ${this.cfg.injectMode}`);
        return;
      }
      default:
        await this.safeRespond(msg.reqId, '可用命令：/bind /unbind /new /sessions /reset /status /steer /followup');
    }
  }

  private async resolveSessionArg(arg: string): Promise<{ path: string; title: string } | null> {
    if (!arg) return null;
    const list = await this.listSessions();
    const idx = Number(arg);
    if (Number.isInteger(idx) && idx >= 1 && idx <= list.length) return list[idx - 1]!;
    const hit = list.find((s) => s.path === arg);
    return hit ?? null;
  }

  private async listSessions(): Promise<Array<{ path: string; title: string; mtime: string }>> {
    const cwd = this.cfg.cwd || this.deps?.defaultCwd || '';
    if (!cwd) return [];
    try {
      const list = await listSessions(cwd);
      return list
        .sort((a, b) => b.mtime - a.mtime)
        .map((s) => ({ path: s.path, title: s.title || s.path, mtime: new Date(s.mtime).toLocaleString('zh-CN') }));
    } catch {
      return [];
    }
  }

  // ---- 流式回合 ----

  private startTurn(chatKey: string, sessionPath: string, msg: BridgeIncomingMessage): void {
    const old = this.active.get(chatKey);
    if (old) this.finishTurn(old, old.text || '（被新消息接管）');
    const turn: ActiveTurn = {
      chatKey,
      sessionPath,
      reqId: msg.reqId,
      streamId: randomUUID(),
      text: '',
      lastFlushAt: 0,
      startedAt: Date.now(),
      flushTimer: null,
      finished: false,
      supportsStream: msg.supportsStream && this.transportSupportsStream,
    };
    this.active.set(chatKey, turn);
    if (turn.supportsStream) {
      void this.transport?.respondStream(turn.reqId, turn.streamId, '…', false).catch(() => undefined);
    }
    this.emitStatus();
  }

  /** 帧流入口：main.ts pool onFrame 转发（多桥各收一份，按绑定 sessionPath 过滤）。 */
  handleFrame(sessionPath: string, frame: Record<string, unknown>): void {
    const type = frame.type as string | undefined;
    if (type === 'message_update') {
      const turn = this.findTurn(sessionPath);
      if (!turn || turn.finished) return;
      const evt = frame.assistantMessageEvent as { type?: string; delta?: string } | undefined;
      if (evt?.type === 'text_delta' && typeof evt.delta === 'string') {
        turn.text += evt.delta;
        this.scheduleFlush(turn);
      }
      return;
    }
    if (type === 'agent_end') {
      const turn = this.findTurn(sessionPath);
      // tempKey 落盘迁移：agent_end 时 omp 已 flush JSONL，查 get_state 换真实 path
      if (sessionPath.startsWith(this.tempPrefix)) {
        void this.migrateTempKey(sessionPath);
      }
      if (!turn) return;
      // isTerminal === false 表示维护/异步投递还会继续，不算完成
      if (frame.isTerminal === false) return;
      this.finishTurn(turn, turn.text || '（无输出）');
      this.active.delete(turn.chatKey);
      this.emitStatus();
      return;
    }
    if (type === 'notice') {
      const n = frame as { message?: string };
      if (typeof n.message === 'string' && n.message) {
        const turn = this.findTurn(sessionPath);
        if (turn) {
          this.finishTurn(turn, `${turn.text}\n\n---\n⚠ ${n.message}`);
          this.active.delete(turn.chatKey);
        }
      }
      return;
    }
    if (type === 'message_end') {
      const turn = this.findTurn(sessionPath);
      if (!turn || turn.finished) return;
      const m = frame.message as { stopReason?: string } | undefined;
      if (m?.stopReason === 'error') {
        this.finishTurn(turn, `${turn.text}\n\n---\n⚠ 生成出错`.trim());
        this.active.delete(turn.chatKey);
      }
      return;
    }
  }

  private async migrateTempKey(tempKey: string): Promise<void> {
    try {
      const r = await this.deps!.pool.send(tempKey, { type: 'get_state' } as never, 10_000);
      const sf = (r.data as { sessionFile?: unknown } | undefined)?.sessionFile;
      if (r.success && typeof sf === 'string' && sf && !sf.startsWith(this.tempPrefix)) {
        this.deps!.pool.renameKey(tempKey, sf);
        this.rebindSession(tempKey, sf);
        this.deps?.log(`[${this.deps.channelLabel}] session migrated: ${tempKey} -> ${sf}`);
      }
    } catch {
      // 进程已死等：绑定表保留 tempKey，下次消息时 acquire 兜底
    }
  }

  /** tempKey 落盘后，绑定表里的 tempKey 换成真实 path。 */
  rebindSession(oldKey: string, realPath: string): void {
    let changed = false;
    for (const b of this.cfg.bindings) {
      if (b.sessionPath === oldKey) {
        b.sessionPath = realPath;
        changed = true;
      }
    }
    for (const t of this.active.values()) {
      if (t.sessionPath === oldKey) t.sessionPath = realPath;
    }
    if (changed) {
      void this.saveConfig(this.cfg).catch(() => undefined);
    }
  }

  /** 会话进程退出：该会话的活跃回合按已有文本收尾。 */
  handleProcessExit(sessionPath: string): void {
    const turn = this.findTurn(sessionPath);
    if (turn && !turn.finished) {
      this.finishTurn(turn, `${turn.text}\n\n---\n⚠ 会话进程已退出`.trim());
      this.active.delete(turn.chatKey);
      this.emitStatus();
    }
  }

  private findTurn(sessionPath: string): ActiveTurn | undefined {
    for (const t of this.active.values()) {
      if (t.sessionPath === sessionPath) return t;
    }
    return undefined;
  }

  private scheduleFlush(turn: ActiveTurn): void {
    if (!turn.supportsStream) return; // 非流式渠道：只累积，agent_end 一次发
    const now = Date.now();
    if (now - turn.lastFlushAt >= STREAM_FLUSH_MS) {
      this.flush(turn);
      return;
    }
    if (turn.flushTimer) return;
    turn.flushTimer = setTimeout(() => {
      turn.flushTimer = null;
      if (!turn.finished) this.flush(turn);
    }, STREAM_FLUSH_MS - (now - turn.lastFlushAt));
  }

  private flush(turn: ActiveTurn): void {
    turn.lastFlushAt = Date.now();
    // 流式窗口将尽 → 兜底收尾（0 = 不限窗口的渠道跳过）
    if (this.streamWindowMs > 0 && Date.now() - turn.startedAt > this.streamWindowMs) {
      this.finishTurn(turn, turn.text || '（超时）');
      return;
    }
    const content = turn.text.slice(-STREAM_MAX_CHARS) || '…';
    void this.transport?.respondStream(turn.reqId, turn.streamId, content, false).catch(() => undefined);
  }

  /** 回合收尾：流式渠道 finish=true；非流式渠道在这里发终稿。 */
  finishTurn(turn: ActiveTurn, finalText: string): void {
    if (turn.finished) return;
    turn.finished = true;
    if (turn.flushTimer) {
      clearTimeout(turn.flushTimer);
      turn.flushTimer = null;
    }
    const content = finalText.slice(-STREAM_MAX_CHARS);
    if (turn.supportsStream) {
      void this.transport?.respondStream(turn.reqId, turn.streamId, content, true).catch(() => {
        // 流式收尾失败：文本兜底
        void this.transport?.respondText(turn.reqId, content).catch(() => undefined);
      });
    } else {
      void this.transport?.respondText(turn.reqId, content).catch(() => undefined);
    }
  }

  private async safeRespond(reqId: string, text: string): Promise<void> {
    try {
      await this.transport?.respondText(reqId, text);
    } catch (e) {
      this.deps?.log(`[${this.deps.channelLabel}] respond failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** app 退出清理（transport 关闭由渠道自己做）。 */
  dispose(): void {
    this.onTransportClosed();
  }
}
