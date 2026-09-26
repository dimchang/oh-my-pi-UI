/**
 * feishu-bridge.ts — 飞书渠道（薄壳）。
 *
 * 用飞书官方 SDK（@larksuiteoapi/node-sdk）：
 *  - WSClient 建立长连接（免公网 IP、免加解密），订阅 im.message.receive_v1；
 *  - Client.im.message.reply 回复消息（关联原消息）；
 *  - Client.im.message.create 主动发送（chatchannel 兜底）。
 *
 * 流式差异：飞书没有企微那种 stream 消息原语，supportsStream=false——
 * core 在 agent_end 时一次性回复终稿（生成期间用户无中间输出）。
 * chatKey：群聊 = chat_id，单聊 = sender open_id（chat_id 单聊也存在，
 * 但同一单聊会话 chat_id 稳定，直接用 chat_id 做两种聊天的 chatKey）。
 *
 * tempKey 前缀 __feishu_：与 __wecom_/__new_ 均不同，避免渲染层与企微桥误认。
 */

import { Client, WSClient, EventDispatcher, LoggerLevel } from '@larksuiteoapi/node-sdk';
import { ChatBridgeCore } from './chat-bridge-core';
import type { BridgeDeps, BridgeIncomingMessage } from './chat-bridge-core';
import type { WecomBridgeConfig, WecomBridgeStatus } from '../src/shared/ipc-channels';

export const FEISHU_TEMP_PREFIX = '__feishu_';

export type { WecomBridgeConfig, WecomBridgeStatus };

interface FeishuIncoming {
  reqId: string; // message_id
  msgid: string;
  chatKey: string;
  chatType: 'single' | 'group';
  text: string;
  msgType: string;
}

/** 从飞书 message.content（JSON 字符串）提取纯文本 */
function extractText(msgType: string, content: string, mentions: Array<{ key: string; name: string }> | undefined): string {
  try {
    const j = JSON.parse(content) as Record<string, unknown>;
    if (msgType === 'text' && typeof j.text === 'string') {
      let t = j.text;
      // 群聊 @ 机器人：文本里是 @_user_1 占位符，剥离
      if (mentions) {
        for (const m of mentions) {
          t = t.split(m.key).join('');
        }
      }
      return t.trim();
    }
    if (msgType === 'post') {
      // 富文本：递归取 text 节点
      const collect = (n: unknown): string => {
        if (Array.isArray(n)) return n.map(collect).join('');
        if (n && typeof n === 'object') {
          const o = n as Record<string, unknown>;
          if (typeof o.text === 'string') return o.text;
          if (o.content) return collect(o.content);
        }
        return '';
      };
      return collect(j).trim();
    }
  } catch {
    return '';
  }
  return '';
}

export class FeishuBridge {
  readonly core: ChatBridgeCore;
  private ws: WSClient | null = null;
  private api: Client | null = null;
  private deps: BridgeDeps | null = null;
  /** 收到的 message_id 排重（飞书事件可能重试投递） */
  private seenMsgids: string[] = [];

  constructor() {
    // supportsStream=false：飞书无 stream 原语，core 在 agent_end 一次性回复
    this.core = new ChatBridgeCore('feishu', FEISHU_TEMP_PREFIX, 0);
  }

  async init(deps: BridgeDeps): Promise<WecomBridgeConfig> {
    this.deps = deps;
    const bridgeSelf = this;
    const transport = {
      get connected(): boolean {
        return bridgeSelf.ws?.getConnectionStatus().state === 'connected';
      },
      respondText: async (reqId: string, content: string) => {
        // reqId = message_id；超长或内容异常时 reply 失败 → 主动发送兜底
        try {
          await bridgeSelf.api!.im.message.reply({
            path: { message_id: reqId },
            data: {
              content: JSON.stringify({ text: content }),
              msg_type: 'text',
            },
          });
        } catch {
          // reply 窗口过期等：改用主动发送（需要已知 chatKey）
          await bridgeSelf.sendToBoundChat(reqId, content);
        }
      },
      respondStream: async () => {
        /* 飞书无 stream 原语：core 在 finishTurn 时才调 respondText */
      },
    };
    const cfg = await this.core.init(deps, transport, /* supportsStream */ false);
    if (cfg.enabled && cfg.botId && cfg.secret) {
      this.connect(cfg.botId, cfg.secret);
    }
    return cfg;
  }

  private connect(appId: string, appSecret: string): void {
    if (!appId || !appSecret) return;
    this.api = new Client({ appId, appSecret });
    const dispatcher = new EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        this.handleEvent(data);
      },
    });
    this.ws = new WSClient({ appId, appSecret, loggerLevel: LoggerLevel.warn });
    void this.ws.start({ eventDispatcher: dispatcher }).catch((e) => {
      this.deps?.log(`[feishu] ws start failed: ${e instanceof Error ? e.message : String(e)}`);
    });
    // 状态变化通过轮询（getConnectionStatus）暴露；连接建立/断开日志
    const watch = setInterval(() => {
      if (!this.ws) {
        clearInterval(watch);
        return;
      }
      const st = this.ws.getConnectionStatus().state;
      if (st === 'connected' && !this.lastConnected) {
        this.lastConnected = true;
        this.deps?.log('[feishu] connected');
        this.deps?.onStatusChange(this.core.status());
      } else if (st !== 'connected' && this.lastConnected) {
        this.lastConnected = false;
        this.deps?.log(`[feishu] disconnected (${st})`);
        this.core.onTransportClosed();
        this.deps?.onStatusChange(this.core.status());
      }
    }, 2_000);
  }

  private lastConnected = false;

  private handleEvent(data: {
    message?: {
      message_id: string;
      chat_id: string;
      chat_type: string;
      message_type: string;
      content: string;
      mentions?: Array<{ key: string; name: string }>;
    };
    sender?: { sender_id?: { open_id?: string } };
  }): void {
    const m = data.message;
    if (!m) return;
    // msgid 排重（事件可能重试）
    if (m.message_id) {
      if (this.seenMsgids.includes(m.message_id)) return;
      this.seenMsgids.push(m.message_id);
      if (this.seenMsgids.length > 256) this.seenMsgids.splice(0, this.seenMsgids.length - 256);
    }
    const chatType: 'single' | 'group' = m.chat_type === 'group' ? 'group' : 'single';
    const text = extractText(m.message_type, m.content, m.mentions);
    const msg: BridgeIncomingMessage = {
      reqId: m.message_id,
      msgid: m.message_id,
      chatKey: m.chat_id,
      chatType,
      text,
      supportsStream: false,
    };
    void this.core.handleMessage(msg);
  }

  /** reply 失败兜底：查绑定表拿 chatKey 主动发送。 */
  private async sendToBoundChat(messageId: string, content: string): Promise<void> {
    // message_id → chatKey 不可反查；遍历绑定找回合，或用 receive_id_type=chat_id 直接发
    // （飞书 im.message.create 的 receive_id 单聊填 open_id、群聊填 chat_id——
    // 我们 chatKey 就是 chat_id，两种场景都能直接用）
    for (const b of this.core.config.bindings) {
      try {
        await this.api!.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: b.chatKey,
            content: JSON.stringify({ text: content }),
            msg_type: 'text',
          },
        });
        return;
      } catch { /* 下一个绑定 */ }
    }
    this.deps?.log(`[feishu] reply+send 均失败，丢弃回复: ${content.slice(0, 60)}`);
  }

  async saveConfig(cfg: WecomBridgeConfig): Promise<WecomBridgeConfig> {
    const saved = await this.core.saveConfig(cfg);
    const wantConnect = saved.enabled && saved.botId && saved.secret;
    if (wantConnect) {
      if (this.ws) this.ws.close({ force: true });
      this.ws = null;
      this.connect(saved.botId, saved.secret);
    } else if (this.ws) {
      this.ws.close({ force: true });
      this.ws = null;
      this.lastConnected = false;
      this.core.onTransportClosed();
    }
    this.deps?.onStatusChange(this.core.status());
    return saved;
  }

  status(): WecomBridgeStatus {
    return this.core.status();
  }

  handleFrame(sessionPath: string, frame: Record<string, unknown>): void {
    this.core.handleFrame(sessionPath, frame);
  }

  handleProcessExit(sessionPath: string): void {
    this.core.handleProcessExit(sessionPath);
  }

  dispose(): void {
    this.ws?.close({ force: true });
    this.ws = null;
    this.core.dispose();
  }
}
