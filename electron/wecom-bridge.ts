/**
 * wecom-bridge.ts — 企业微信 ↔ OMP 会话桥（主进程常驻）。
 *
 * 职责：企微智能机器人的消息 → 绑定的 OMP 会话（prompt/steer/follow_up），
 * omp 的回复 → 企微流式消息刷新，agent_end 终态收尾。
 *
 * 会话策略（用户已确认）：
 *  - chatKey（群 chatid / 单聊 userid）↔ sessionPath 绑定表，持久化 userData/wecom-bridge.json；
 *  - 未绑定的聊天首条消息自动新建会话（tempKey 前缀 __wecom_，避开渲染层 __new_ 迁移逻辑）；
 *  - 注入语义默认 steer（打断当前任务）——正是远程纠偏的核心诉求；
 *  - /bind /sessions /reset /new 命令管理绑定。
 *
 * 帧流订阅：不绕渲染层，直接从 pool 的 onFrame 钩子拿（main.ts 转发一份给本桥）。
 * 流式回复：message_update 的 text_delta 增量聚合，1s 节流刷新到企微 stream 消息；
 */

import { listSessions } from '../src/main/session-store';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import { WecomClient, type WecomIncomingMessage } from './wecom-client';
import type { OmpProcessPool } from './omp-pool';
import type { ApprovalMode, WecomBridgeConfig, WecomBinding, WecomBridgeStatus } from '../src/shared/ipc-channels';

/** wecom 会话 tempKey 前缀。刻意区别于渲染层 TEMP_KEY_PREFIX（__new_）：
 *  渲染层 migrateTempSession / discardTempSession / 自动恢复只认 __new_，
 *  __wecom_ 前缀让这些路径全部跳过桥会话，避免渲染层误迁移/误清理。 */
export const WECOM_TEMP_PREFIX = '__wecom_';

/** 流式刷新节流间隔 */
const STREAM_FLUSH_MS = 1_000;
/** 企微流式消息 10 分钟硬窗口，提前 30s 兜底收尾 */
const STREAM_WINDOW_MS = 10 * 60 * 1000 - 30_000;
/** 单条流式消息内容上限（防意外巨量推送） */
const STREAM_MAX_CHARS = 20_000;
/** 回复消息 markdown 上限（官方 20480 字节） */
const REPLY_MAX_BYTES = 20_000;

interface BridgeDeps {
  pool: OmpProcessPool;
  /** 取全局钩子参数（与 IPC OmpAcquire 同源） */
  resolveHooks: () => Promise<string[]>;
  /** 默认 cwd（wecom 新会话用） */
  defaultCwd: string;
  /** 默认权限模式 */
  defaultApprovalMode: ApprovalMode;
  onStatusChange(status: WecomBridgeStatus): void;
  log(line: string): void;
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
}

export function wecomBridgeFile(): string {
  return path.join(app.getPath('userData'), 'wecom-bridge.json');
}

function emptyConfig(): WecomBridgeConfig {
  return { enabled: false, botId: '', secret: '', cwd: '', approvalMode: 'write', injectMode: 'steer', bindings: [] };
}

/** 白名单式解析：脏数据回退默认，绝不把非法结构带进运行时。 */
export function parseWecomBridgeFile(raw: string): WecomBridgeConfig {
  try {
    const j = JSON.parse(raw) as Partial<WecomBridgeConfig>;
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
    return emptyConfig();
  }
}

export class WecomBridge {
  private client: WecomClient | null = null;
  private cfg: WecomBridgeConfig = emptyConfig();
  private deps: BridgeDeps | null = null;
  /** chatKey → 进行中的回合 */
  private active = new Map<string, ActiveTurn>();
  /** 磁盘缓存（mtime 失效） */
  private cfgCache: { mtimeMs: number; data: WecomBridgeConfig } | null = null;

  /** 启动时从磁盘恢复配置；enabled 则连。 */
  async init(deps: BridgeDeps): Promise<void> {
    this.deps = deps;
    this.cfg = await this.loadConfig();
    if (this.cfg.enabled && this.cfg.botId && this.cfg.secret) {
      this.connect();
    }
  }

  async loadConfig(): Promise<WecomBridgeConfig> {
    const file = wecomBridgeFile();
    try {
      const st = await fs.promises.stat(file);
      if (this.cfgCache && this.cfgCache.mtimeMs === st.mtimeMs) return this.cfgCache.data;
      const raw = await fs.promises.readFile(file, 'utf8');
      const data = parseWecomBridgeFile(raw);
      this.cfgCache = { mtimeMs: st.mtimeMs, data };
      return data;
    } catch {
      return emptyConfig();
    }
  }

  async saveConfig(cfg: WecomBridgeConfig): Promise<WecomBridgeConfig> {
    // 规范化：绑定去重（同 chatKey 只留最新）
    const seen = new Set<string>();
    cfg.bindings = (cfg.bindings ?? []).filter((b) => {
      if (seen.has(b.chatKey)) return false;
      seen.add(b.chatKey);
      return true;
    });
    const file = wecomBridgeFile();
    await fs.promises.writeFile(file, JSON.stringify(cfg, null, 2), 'utf8');
    this.cfg = cfg;
    this.cfgCache = null;
    // 连接状态对齐配置
    const wantConnect = cfg.enabled && cfg.botId && cfg.secret;
    if (wantConnect) {
      if (this.client) this.client.updateCredentials(cfg.botId, cfg.secret);
      else this.connect();
    } else if (this.client) {
      this.disconnect();
    }
    this.emitStatus();
    return cfg;
  }

  status(): WecomBridgeStatus {
    return {
      enabled: this.cfg.enabled,
      connected: this.client?.connected ?? false,
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

  private connect(): void {
    if (!this.cfg.botId || !this.cfg.secret || !this.deps) return;
    this.client = new WecomClient(this.cfg.botId, this.cfg.secret, {
      onOpen: () => {
        this.deps?.log('[wecom] connected');
        this.emitStatus();
      },
      onClose: (reason) => {
        this.deps?.log(`[wecom] closed: ${reason}`);
        this.emitStatus();
      },
      onError: (err) => {
        this.deps?.log(`[wecom] error: ${err}`);
      },
      onMessage: (msg) => void this.handleMessage(msg),
    });
    this.client.start();
  }

  private disconnect(): void {
    this.client?.stop();
    this.client = null;
    // 进行中的流回合全部按当前文本收尾
    for (const turn of this.active.values()) this.finishTurn(turn, turn.text || '（连接已断开）');
    this.active.clear();
    this.emitStatus();
  }

  // ---- 消息入口 ----

  private async handleMessage(msg: WecomIncomingMessage): Promise<void> {
    const deps = this.deps;
    if (!deps) return;
    // 非文本（图片/文件等）暂不支持：直接告知
    if (msg.msgtype !== 'text' && msg.msgtype !== 'voice') {
      await this.safeRespond(msg.reqId, '目前仅支持文本消息。');
      return;
    }
    const text = msg.text.trim();
    if (!text) return;

    // 命令路由（/ 开头）
    if (text.startsWith('/')) {
      await this.handleCommand(msg, text);
      return;
    }

    // 常规消息 → 绑定会话
    const binding = this.cfg.bindings.find((b) => b.chatKey === msg.chatKey);
    const sessionPath = binding?.sessionPath;
    if (!sessionPath) {
      // 未绑定：自动新建会话并绑定（首次接触即接管）
      await this.autoBind(msg, text);
      return;
    }

    // 会话进行中 → steer（默认）/ followUp；空闲 → prompt
    const turn = this.active.get(msg.chatKey);
    try {
      const cmd = turn
        ? (this.cfg.injectMode === 'followUp'
            ? { type: 'follow_up', message: text }
            : { type: 'steer', message: text })
        : { type: 'prompt', message: text };
      await deps.pool.send(sessionPath, cmd as never, 30_000);
      if (!turn) {
        // 新回合：开流式消息
        this.startTurn(msg.chatKey, sessionPath, msg.reqId);
      }
      // steer 的增量会继续走已有 stream.id 刷新
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      // 进程离线（被 LRU 淘汰/退出）→ 重新拉起再投
      if (/not online|spawn|exited|timeout/i.test(errMsg)) {
        try {
          const cwd = this.cfg.cwd || this.deps!.defaultCwd;
          const hooks = await this.deps!.resolveHooks();
          await this.deps!.pool.acquire(sessionPath, cwd, this.cfg.approvalMode, hooks);
          await this.deps!.pool.send(sessionPath, { type: 'prompt', message: text } as never, 30_000);
          this.startTurn(msg.chatKey, sessionPath, msg.reqId);
          return;
        } catch (e2) {
          const m2 = e2 instanceof Error ? e2.message : String(e2);
          await this.safeRespond(msg.reqId, `会话不可用：${m2}`);
          return;
        }
      }
      await this.safeRespond(msg.reqId, `发送失败：${errMsg}`);
    }
  }

  /** 首条消息自动建会话并绑定。 */
  private async autoBind(msg: WecomIncomingMessage, firstText: string): Promise<void> {
    const deps = this.deps!;
    const tempKey = WECOM_TEMP_PREFIX + randomUUID();
    const cwd = this.cfg.cwd || deps.defaultCwd;
    const hooks = await deps.resolveHooks();
    try {
      await deps.pool.acquireNew(tempKey, cwd, this.cfg.approvalMode, undefined, hooks);
      // 记绑定（tempKey 随后由帧流里的 get_state.sessionFile 解析替换成真实 path）
      this.cfg.bindings.push({
        chatKey: msg.chatKey,
        sessionPath: tempKey,
        chatType: msg.chattype,
        title: firstText.slice(0, 30),
        createdAt: Date.now(),
      });
      await this.saveConfig(this.cfg);
      await deps.pool.send(tempKey, { type: 'prompt', message: firstText } as never, 30_000);
      this.startTurn(msg.chatKey, tempKey, msg.reqId);
      this.emitStatus();
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      await this.safeRespond(msg.reqId, `新建会话失败：${m}`);
    }
  }

  // ---- 命令 ----

  private async handleCommand(msg: WecomIncomingMessage, text: string): Promise<void> {
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(' ').trim();
    switch (cmd) {
      case 'bind': {
        // /bind <sessionPath|序号> — 绑定到已有会话
        const target = await this.resolveSessionArg(arg);
        if (!target) {
          await this.safeRespond(msg.reqId, '用法：/bind <会话路径或序号>（序号见 /sessions）');
          return;
        }
        const existing = this.cfg.bindings.find((b) => b.chatKey === msg.chatKey);
        if (existing) existing.sessionPath = target.path;
        else this.cfg.bindings.push({ chatKey: msg.chatKey, sessionPath: target.path, chatType: msg.chattype, title: target.title, createdAt: Date.now() });
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
        // /new — 解绑并立即新建会话（首条消息即 prompt）
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
        // /reset — 清当前聊天的活跃回合与绑定（不动磁盘会话）
        const turn = this.active.get(msg.chatKey);
        if (turn) this.finishTurn(turn, turn.text || '（已重置）');
        this.active.delete(msg.chatKey);
        await this.safeRespond(msg.reqId, '已重置当前聊天的桥接状态。');
        return;
      }
      case 'status': {
        const s = this.status();
        await this.safeRespond(msg.reqId,
          `连接：${s.connected ? '正常' : '断开'}\n注入模式：${s.injectMode}\n绑定数：${s.bindings.length}\n活跃回合：${s.activeChats.length}`);
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

  /** /bind 参数解析：序号（/sessions 列表）或绝对路径。 */
  private async resolveSessionArg(arg: string): Promise<{ path: string; title: string } | null> {
    if (!arg) return null;
    const list = await this.listSessions();
    const idx = Number(arg);
    if (Number.isInteger(idx) && idx >= 1 && idx <= list.length) return list[idx - 1]!;
    const hit = list.find((s) => s.path === arg);
    return hit ?? null;
  }

  private async listSessions(): Promise<Array<{ path: string; title: string; mtime: string }>> {
    // 复用主进程 session-store 的扫盘（与侧栏同源），只列桥默认 cwd 的
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

  /** 开新流式回合（prompt 成功后调用）。 */
  private startTurn(chatKey: string, sessionPath: string, reqId: string): void {
    // 同聊天旧回合兜底收尾（理论上 prompt 只在无活跃回合时发）
    const old = this.active.get(chatKey);
    if (old) this.finishTurn(old, old.text || '（被新消息接管）');

    const turn: ActiveTurn = {
      chatKey,
      sessionPath,
      reqId,
      streamId: randomUUID(),
      text: '',
      lastFlushAt: 0,
      startedAt: Date.now(),
      flushTimer: null,
      finished: false,
    };
    this.active.set(chatKey, turn);
    // 先发一条占位流式消息（用户在企微端立即看到响应起点）
    void this.client?.respondStream(reqId, turn.streamId, '…', false).catch(() => undefined);
    this.emitStatus();
  }

  /** 帧流入口：main.ts pool onFrame 转发。 */
  handleFrame(sessionPath: string, frame: Record<string, unknown>): void {
    // 逐回合按 sessionPath 匹配（一个会话同一时刻至多一个 wecom 回合）
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
      // tempKey 落盘迁移：agent_end 时 omp 已 flush JSONL，查 get_state 拿真实
      // sessionFile（omp spawn 时即分配好），把绑定表里的 __wecom_ key 换成
      // 真实 path——之后进程被 LRU 淘汰再 acquire 才能带 -r 续接而非裂新会话。
      if (sessionPath.startsWith(WECOM_TEMP_PREFIX)) {
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
      // 会话级通知（错误等）透传给绑定聊天
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
      // message_end 带 stopReason error 的回合收尾兜底
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

  /** tempKey 落盘后，绑定表里的 tempKey 换成真实 path（main.ts 在 get_state 时回调）。 */
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

  /** __wecom_ tempKey → 真实 sessionFile（agent_end 后调用；渲染层不认识该前缀，须自管）。 */
  private async migrateTempKey(tempKey: string): Promise<void> {
    try {
      const r = await this.deps!.pool.send(tempKey, { type: 'get_state' } as never, 10_000);
      const sf = (r.data as { sessionFile?: unknown } | undefined)?.sessionFile;
      if (r.success && typeof sf === 'string' && sf && !sf.startsWith(WECOM_TEMP_PREFIX)) {
        // pool key 同步迁移（与渲染层 rpc.renameKey 同路径，pin/frames 全部跟着走）
        this.deps!.pool.renameKey(tempKey, sf);
        this.rebindSession(tempKey, sf);
        this.deps?.log(`[wecom] session migrated: ${tempKey} -> ${sf}`);
      }
    } catch {
      // 进程已死等：绑定表保留 tempKey，下次消息时 acquire 走 tempSessionFiles
      // 记忆（pool 内部）带 -r 续接，或失败后重建
    }
  }

  /** 会话进程退出（被 LRU 淘汰/崩溃）：该会话的活跃回合按已有文本收尾。 */
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
    // 10 分钟窗口将尽 → 兜底收尾，余下内容等 agent_end 后由 finishTurn 补发终稿
    if (Date.now() - turn.startedAt > STREAM_WINDOW_MS) {
      this.finishTurn(turn, turn.text || '（超时）');
      return;
    }
    const content = turn.text.slice(-STREAM_MAX_CHARS) || '…';
    void this.client?.respondStream(turn.reqId, turn.streamId, content, false).catch(() => undefined);
  }

  /** 流式收尾：finish=true。失败（req_id 过期等）→ 主动推送终稿兜底。 */
  private finishTurn(turn: ActiveTurn, finalText: string): void {
    if (turn.finished) return;
    turn.finished = true;
    if (turn.flushTimer) {
      clearTimeout(turn.flushTimer);
      turn.flushTimer = null;
    }
    const content = finalText.slice(-STREAM_MAX_CHARS);
    void this.client?.respondStream(turn.reqId, turn.streamId, content, true).catch(() => {
      // 流式收尾失败（如超过 24h 回复窗口）：markdown 主动推送兜底
      const chatType: 1 | 2 = this.cfg.bindings.find((b) => b.chatKey === turn.chatKey)?.chatType === 'group' ? 2 : 1;
      void this.client?.sendMarkdown(turn.chatKey, chatType, content.slice(0, REPLY_MAX_BYTES)).catch(() => undefined);
    });
  }

  private async safeRespond(reqId: string, text: string): Promise<void> {
    try {
      await this.client?.respondText(reqId, text);
    } catch (e) {
      this.deps?.log(`[wecom] respond failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** app 退出清理。 */
  dispose(): void {
    this.disconnect();
  }
}
