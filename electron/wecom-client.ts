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
/** 连续多少次心跳无回执即判定连接已死（半开连接不会触发 close 事件） */
const MAX_MISSED_PINGS = 2;
/** stream / markdown 内容上限：20480 字节（UTF-8），超出服务端拒收 */
export const WECOM_CONTENT_MAX_BYTES = 20_480;

/** 按 UTF-8 字节数截取尾部（保留最新内容），不从代理对中间切开。 */
export function tailUtf8Bytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let bytes = 0;
  let i = s.length;
  while (i > 0) {
    const c = s.charCodeAt(i - 1);
    let units = 1;
    let size: number;
    if (c < 0x80) size = 1;
    else if (c < 0x800) size = 2;
    else if (c >= 0xdc00 && c <= 0xdfff && i >= 2 && (s.charCodeAt(i - 2) & 0xfc00) === 0xd800) {
      size = 4;
      units = 2;
    } else size = 3;
    if (bytes + size > maxBytes) break;
    bytes += size;
    i -= units;
  }
  return s.slice(i);
}

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
  binaryType: string;
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
  private missedPings = 0;
  /** req_id → resolve（响应关联） */
  private pending = new Map<string, { resolve: (ok: boolean, errmsg?: string) => void; timer: NodeJS.Timeout }>();
  /** req_id → 该 req_id 上最后一个回复请求。回执按 req_id 关联，同一 req_id 的回复必须串行
   *  （等上一帧回执再发下一帧），否则 pending 被覆盖、回执错配、流式帧乱序。 */
  private replyChains = new Map<string, Promise<void>>();
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

  /** 回复纯文本（透传 req_id）。aibot_respond_msg 不支持 text（text 仅用于欢迎语），
   *  用一帧即 finish 的 stream 承载。 */
  respondText(reqId: string, content: string): Promise<void> {
    return this.reply(reqId, {
      msgtype: 'stream',
      stream: { id: randomUUID(), finish: true, content: tailUtf8Bytes(content, WECOM_CONTENT_MAX_BYTES) },
    });
  }

  /** 回复 markdown（透传 req_id）。 */
  respondMarkdown(reqId: string, content: string): Promise<void> {
    return this.reply(reqId, {
      msgtype: 'markdown',
      markdown: { content },
    });
  }

  /**
   * 流式回复。同一 (reqId, streamId) 反复调用刷新内容；finish=true 结束该流。
   * 官方约束：从首条流式消息起 10 分钟内必须 finish，否则服务端自动结束。
   */
  respondStream(reqId: string, streamId: string, content: string, finish: boolean): Promise<void> {
    return this.reply(reqId, {
      msgtype: 'stream',
      stream: { id: streamId, finish, content: tailUtf8Bytes(content, WECOM_CONTENT_MAX_BYTES) },
    });
  }

  /** 主动推送 markdown（无需回调触发；单聊填 userid，群聊填 chatid）。 */
  sendMarkdown(chatKey: string, chatType: 1 | 2, content: string): Promise<void> {
    return this.request('aibot_send_msg', randomUUID(), {
      chatid: chatKey,
      chat_type: chatType,
      msgtype: 'markdown',
      markdown: { content: tailUtf8Bytes(content, WECOM_CONTENT_MAX_BYTES) },
    });
  }

  // ---- 内部 ----

  /** 同一 req_id 的被动回复排队串行发送。 */
  private reply(reqId: string, body: unknown): Promise<void> {
    const prev = this.replyChains.get(reqId);
    const p = (prev ? prev.catch(() => undefined) : Promise.resolve()).then(() =>
      this.request('aibot_respond_msg', reqId, body),
    );
    this.replyChains.set(reqId, p);
    const done = (): void => {
      if (this.replyChains.get(reqId) === p) this.replyChains.delete(reqId);
    };
    p.then(done, done);
    return p;
  }

  private connect(): void {
    if (this.stopped) return;
    const WS: typeof WebSocket = globalThis.WebSocket;
    if (!WS) {
      this.events.onError('此环境无 WebSocket 实现');
      return;
    }
    const ws = new WS(WECOM_WS_URL) as unknown as WsLike;
    // 全局 WebSocket（undici）默认 binaryType='blob'，下面只解析 ArrayBuffer/视图
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    // 所有监听先判 this.ws === ws：stop()/心跳判死丢弃的旧 socket 迟到的事件不能污染新连接
    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      // 连上后立刻订阅（有频率保护，只发一次）
      void this.subscribe(ws);
    });
    ws.addEventListener('message', (e) => {
      if (this.ws !== ws) return;
      let data: string;
      if (typeof e.data === 'string') data = e.data;
      else if (e.data instanceof ArrayBuffer) data = Buffer.from(e.data).toString('utf8');
      else if (ArrayBuffer.isView(e.data)) data = Buffer.from(e.data.buffer, e.data.byteOffset, e.data.byteLength).toString('utf8');
      else return;
      this.handleFrame(data);
    });
    ws.addEventListener('close', (e) => {
      if (this.ws !== ws) return;
      const reason = `code=${e.code}${e.reason ? ` (${e.reason})` : ''}`;
      this.onDisconnected(reason);
    });
    ws.addEventListener('error', () => {
      // error 事件后必跟 close，统一在 close 处理，避免双路径重连
    });
  }

  /** 主动判死当前连接：立即走断线/重连流程，旧 socket 尽力关闭（其迟到事件被忽略）。 */
  private dropConnection(ws: WsLike, reason: string): void {
    if (this.ws !== ws) return;
    this.onDisconnected(reason);
    try { ws.close(4000, reason); } catch { /* noop */ }
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

  private subscribe(ws: WsLike): Promise<void> {
    return this.request('aibot_subscribe', randomUUID(), {
      bot_id: this.botId,
      secret: this.secret,
    }).then(
      () => {
        if (this.ws !== ws) return;
        this.subscribed = true;
        this.reconnectAttempt = 0;
        this.startPing(ws);
        this.events.onOpen();
      },
      (e) => {
        if (this.ws !== ws) return;
        // 凭证错误/订阅超时：上报（「测试连接」靠它出结果），断开后按退避重连
        this.events.onError(`订阅失败：${e instanceof Error ? e.message : String(e)}`);
        this.dropConnection(ws, 'subscribe failed');
      },
    );
  }

  private startPing(ws: WsLike): void {
    this.missedPings = 0;
    this.pingTimer = setInterval(() => {
      // 半开连接（休眠唤醒/NAT 超时等）可能迟迟不触发 close：连续无回执即主动判死重连
      if (this.missedPings >= MAX_MISSED_PINGS) {
        this.dropConnection(ws, 'heartbeat timeout');
        return;
      }
      this.missedPings += 1;
      void this.request('ping', randomUUID(), undefined).then(
        () => { this.missedPings = 0; },
        () => undefined,
      );
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
