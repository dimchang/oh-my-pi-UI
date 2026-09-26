/**
 * wecom-client.ts — 企业微信「智能机器人 · 长连接」协议客户端。
 *
 * 协议（企微开放平台 doc 101463「智能机器人长连接」）：
 *  - 连接 wss://openws.work.weixin.qq.com，建立后发 aibot_subscribe（bot_id+secret）完成订阅；
 *  - 用户消息 → aibot_msg_callback（cmd/headers.req_id/body.msgid/body.chatid/...）；
 *  - 事件（进会话等）→ aibot_event_callback；
 *  - 回复用户消息 → aibot_respond_msg（透传回调 req_id；支持 msgtype: text | stream | markdown | ...）；
 *  - 流式消息：同 req_id 下用 stream.id 关联，持续刷新内容，finish=true 收尾（10 分钟窗口）；
 *  - 心跳：cmd=ping，官方建议 30s 间隔；
 *  - 单机器人同时只允许一条有效长连接：新连接订阅成功会踢掉旧连接。
 *
 * 本文件只做协议与连接管理（订阅/心跳/重连/回调分发/回复原语），不含任何业务路由逻辑。
 * Node 22+ 的全局 WebSocket（undici）即可满足，无第三方依赖。
 */

import { randomUUID } from 'crypto';

/** 企微长连接服务地址 */
const WECOM_WS_URL = 'wss://openws.work.weixin.qq.com';

/** 心跳间隔：官方建议 30s */
const PING_INTERVAL_MS = 30_000;
/** 断线重连基础退避 */
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

/** aibot_msg_callback 的 body 结构（文本场景） */
export interface WecomMsgCallbackBody {
  msgid: string;
  aibotid: string;
  /** 群聊会话 ID；单聊无此字段（以 from.userid 标识会话） */
  chatid?: string;
  /** single | group */
  chattype: 'single' | 'group';
  from: { userid: string };
  msgtype: string;
  text?: { content: string };
  image?: { url: string; aeskey: string };
  voice?: { url: string; aeskey: string; text?: string };
  [k: string]: unknown;
}

export interface WecomIncomingMessage {
  /** 回复时需要透传的 req_id */
  reqId: string;
  /** 消息排重 id */
  msgid: string;
  /** 会话标识：群聊 = chatid，单聊 = from.userid */
  chatKey: string;
  chattype: 'single' | 'group';
  sender: string;
  msgtype: string;
  text: string;
  raw: WecomMsgCallbackBody;
}

export interface WecomClientEvents {
  onMessage(msg: WecomIncomingMessage): void;
  /** 订阅成功（连接可用） */
  onOpen(): void;
  /** 连接断开（无论原因，之后会自动重连） */
  onClose(reason: string): void;
  /** 协议/逻辑错误（不影响连接自愈） */
  onError(err: string): void;
}

interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(ev: 'open', cb: () => void): void;
  addEventListener(ev: 'close', cb: (e: { code: number; reason: string }) => void): void;
  addEventListener(ev: 'error', cb: (e: { message?: string }) => void): void;
  addEventListener(ev: 'message', cb: (e: { data: unknown }) => void): void;
}

export class WecomClient {
  private ws: WsLike | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private stopped = false;
  private subscribed = false;
  /** req_id → resolve（响应关联） */
  private pending = new Map<string, { resolve: (ok: boolean, errmsg?: string) => void; timer: NodeJS.Timeout }>();
  /** 最近 N 条 msgid，事件排重（企微回调可能重试） */
  private seenMsgids: string[] = [];
  private readonly seenCap = 256;

  constructor(
    private botId: string,
    private secret: string,
    private events: WecomClientEvents,
  ) {}

  /** 手动连接。已连接时 no-op。 */
  start(): void {
    this.stopped = false;
    if (this.ws) return;
    this.connect();
  }

  /** 停止连接与所有定时器。 */
  stop(): void {
    this.stopped = true;
    this.clearTimers();
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve(false, 'client stopped');
    }
    this.pending.clear();
    try { this.ws?.close(1000, 'client stopped'); } catch { /* noop */ }
    this.ws = null;
    this.subscribed = false;
  }

  /** 更新凭证并重连（配置变更用）。 */
  updateCredentials(botId: string, secret: string): void {
    this.botId = botId;
    this.secret = secret;
    this.stop();
    this.stopped = false;
    this.connect();
  }

  get connected(): boolean {
    return this.subscribed;
  }

  // ---- 回复原语 ----

  /** 回复纯文本（透传 req_id）。 */
  respondText(reqId: string, content: string): Promise<void> {
    return this.request('aibot_respond_msg', reqId, {
      msgtype: 'text',
      text: { content },
    });
  }

  /** 回复 markdown（透传 req_id）。 */
  respondMarkdown(reqId: string, content: string): Promise<void> {
    return this.request('aibot_respond_msg', reqId, {
      msgtype: 'markdown',
      markdown: { content },
    });
  }

  /**
   * 流式回复。同一 (reqId, streamId) 反复调用刷新内容；finish=true 结束该流。
   * 官方约束：从首条流式消息起 10 分钟内必须 finish，否则服务端自动结束。
   */
  respondStream(reqId: string, streamId: string, content: string, finish: boolean): Promise<void> {
    return this.request('aibot_respond_msg', reqId, {
      msgtype: 'stream',
      stream: { id: streamId, finish, content },
    });
  }

  /** 主动推送 markdown（无需回调触发；单聊填 userid，群聊填 chatid）。 */
  sendMarkdown(chatKey: string, chatType: 1 | 2, content: string): Promise<void> {
    return this.request('aibot_send_msg', randomUUID(), {
      chatid: chatKey,
      chat_type: chatType,
      msgtype: 'markdown',
      markdown: { content },
    });
  }

  // ---- 内部 ----

  private connect(): void {
    if (this.stopped) return;
    const WS: typeof WebSocket = globalThis.WebSocket;
    if (!WS) {
      this.events.onError('此环境无 WebSocket 实现');
      return;
    }
    const ws = new WS(WECOM_WS_URL) as unknown as WsLike;
    this.ws = ws;
    ws.addEventListener('open', () => {
      // 连上后立刻订阅（有频率保护，只发一次）
      void this.subscribe();
    });
    ws.addEventListener('message', (e) => {
      let data: string;
      if (typeof e.data === 'string') data = e.data;
      else if (e.data instanceof ArrayBuffer) data = Buffer.from(e.data).toString('utf8');
      else if (ArrayBuffer.isView(e.data)) data = Buffer.from(e.data.buffer, e.data.byteOffset, e.data.byteLength).toString('utf8');
      else return;
      this.handleFrame(data);
    });
    ws.addEventListener('close', (e) => {
      const reason = `code=${e.code}${e.reason ? ` (${e.reason})` : ''}`;
      this.onDisconnected(reason);
    });
    ws.addEventListener('error', () => {
      // error 事件后必跟 close，统一在 close 处理，避免双路径重连
    });
  }

  private onDisconnected(reason: string): void {
    const wasSubscribed = this.subscribed;
    this.subscribed = false;
    this.ws = null;
    this.clearTimers();
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve(false, 'connection closed');
    }
    this.pending.clear();
    if (this.stopped) return;
    if (wasSubscribed) this.events.onClose(reason);
    // 指数退避重连
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private clearTimers(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  private subscribe(): Promise<void> {
    return this.request('aibot_subscribe', randomUUID(), {
      bot_id: this.botId,
      secret: this.secret,
    }).then(() => {
      this.subscribed = true;
      this.reconnectAttempt = 0;
      this.startPing();
      this.events.onOpen();
    });
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      // ping 失败会被 pending 超时吞掉；连接级死亡由 close 事件处理
      void this.request('ping', randomUUID(), undefined).catch(() => undefined);
    }, PING_INTERVAL_MS);
  }

  /** 发送命令并等 errcode 响应。失败 reject（带 errmsg）。 */
  private request(cmd: string, reqId: string, body: unknown): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = this.ws;
      // subscribe 阶段尚未置 subscribed，需放行
      if (!ws || (!this.subscribed && cmd !== 'aibot_subscribe')) {
        reject(new Error('wecom: not connected'));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`wecom ${cmd} timeout`));
      }, 15_000);
      this.pending.set(reqId, {
        resolve: (ok, errmsg) => {
          this.pending.delete(reqId);
          clearTimeout(timer);
          if (ok) resolve();
          else reject(new Error(`wecom ${cmd} failed: ${errmsg ?? 'unknown'}`));
        },
        timer,
      });
      try {
        ws.send(JSON.stringify({
          cmd,
          headers: { req_id: reqId },
          ...(body === undefined ? {} : { body }),
        }));
      } catch (e) {
        this.pending.delete(reqId);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private handleFrame(raw: string): void {
    let f: {
      cmd?: string;
      headers?: { req_id?: string };
      errcode?: number;
      errmsg?: string;
      body?: WecomMsgCallbackBody;
    };
    try {
      f = JSON.parse(raw);
    } catch {
      this.events.onError(`非 JSON 帧: ${raw.slice(0, 120)}`);
      return;
    }
    const cmd = f.cmd ?? '';
    const reqId = f.headers?.req_id ?? '';

    // 命令响应（subscribe/ping/respond_msg 等）
    if (f.errcode !== undefined) {
      const p = reqId ? this.pending.get(reqId) : undefined;
      if (f.errcode === 0) {
        p?.resolve(true);
      } else {
        // 错误响应：优先解 pending；未知的记错误
        if (p) p.resolve(false, f.errmsg);
        else this.events.onError(`errcode=${f.errcode} ${f.errmsg ?? ''} (${cmd})`);
      }
      return;
    }

    // 下行回调
    if (cmd === 'aibot_msg_callback' && f.body) {
      const b = f.body;
      if (!reqId) {
        this.events.onError('msg_callback 无 req_id，无法回复');
        return;
      }
      // msgid 排重（回调可能重试投递）
      if (b.msgid) {
        if (this.seenMsgids.includes(b.msgid)) return;
        this.seenMsgids.push(b.msgid);
        if (this.seenMsgids.length > this.seenCap) this.seenMsgids.splice(0, this.seenMsgids.length - this.seenCap);
      }
      const chatKey = b.chattype === 'group' ? (b.chatid ?? '') : (b.from?.userid ?? '');
      if (!chatKey) {
        this.events.onError('msg_callback 缺 chatid/from.userid');
        return;
      }
      const text = b.text?.content
        ?? (b.msgtype === 'voice' ? b.voice?.text : undefined)
        ?? '';
      this.events.onMessage({
        reqId,
        msgid: b.msgid ?? '',
        chatKey,
        chattype: b.chattype,
        sender: b.from?.userid ?? '',
        msgtype: b.msgtype ?? 'text',
        text,
        raw: b,
      });
      return;
    }

    // 其余回调类型（event_callback / welcome 等）暂不处理：静默即可，
    // 不回复欢迎语不影响消息链路。
  }
}
