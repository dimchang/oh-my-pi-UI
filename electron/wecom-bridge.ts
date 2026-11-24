/**
 * wecom-bridge.ts — 企业微信渠道（薄壳）。
 *
 * 渠道无关逻辑（绑定表/回合/命令/帧流）在 chat-bridge-core.ts；这里只提供：
 *  - WecomClient 的 transport 适配（respondText/respondStream）
 *  - wecom-bridge.json 配置的读写与连接生命周期
 *  - 兼容导出：main.ts / preload / UI 用的类型与常量
 *
 * 企微特有：stream 消息 10 分钟硬窗口（STREAM_WINDOW_MS 传给 core）。
 */

import { WecomClient } from './wecom-client';
import { ChatBridgeCore } from './chat-bridge-core';
import type { BridgeDeps } from './chat-bridge-core';
import type { ApprovalMode, WecomBridgeConfig, WecomBridgeStatus } from '../src/shared/ipc-channels';

/** wecom 会话 tempKey 前缀（渲染层只认 __new_，__wecom_ 完全避开渲染层逻辑） */
export const WECOM_TEMP_PREFIX = '__wecom_';

/** 企微流式消息 10 分钟硬窗口，提前 30s 兜底收尾 */
const STREAM_WINDOW_MS = 10 * 60 * 1000 - 30_000;

/** core 识别的桥命令（与 chat-bridge-core handleCommand 一致） */
const COMMAND_RE = /(^|\s)(\/(?:bind|unbind|new|sessions|reset|status|steer|followup)(?:\s|$)[\s\S]*)$/;

/** 企微群聊 content 里直接带显示名 @（如「@机器人 /bind 1」），不剥掉命令就识别不到。
 *  只在 @ 开头、且后面跟着已知命令时剥离，避免误伤正文里的路径（/etc/...）。 */
export function stripLeadingMention(text: string): string {
  const t = text.trim();
  if (!/^[@＠]/.test(t)) return t;
  const m = COMMAND_RE.exec(t);
  return m?.[2] ? m[2].trim() : t;
}

export type { WecomBridgeConfig, WecomBridgeStatus };

export class WecomBridge {
  readonly core: ChatBridgeCore;
  private client: WecomClient | null = null;
  private deps: BridgeDeps | null = null;

  constructor() {
    this.core = new ChatBridgeCore('wecom', WECOM_TEMP_PREFIX, STREAM_WINDOW_MS);
  }

  /** 启动：装 transport + 读配置；enabled 且凭证齐全则连。 */
  async init(deps: BridgeDeps): Promise<WecomBridgeConfig> {
    this.deps = deps;
    // transport 通过闭包引用 this.client：connect/saveConfig 重建 client 后自动跟随。
    // getter 的 this 不能用于对象字面量，统一用 bridgeSelf 闭包。
    // 方法必须是 async：client 为 null（已停用/dispose）时要返回 rejected promise，
    // 不能同步抛——core 的 finishTurn 是 `void transport.x().catch()`，同步异常会穿出
    // dispose()/saveConfig()（退出时主进程报错且跳过 pool.killAll）。
    const bridgeSelf = this;
    const client = (): WecomClient => {
      if (!bridgeSelf.client) throw new Error('wecom: not connected');
      return bridgeSelf.client;
    };
    const transport = {
      get connected(): boolean {
        return bridgeSelf.client?.connected ?? false;
      },
      respondText: async (reqId: string, content: string) => client().respondText(reqId, content),
      respondStream: async (reqId: string, streamId: string, content: string, finish: boolean) =>
        client().respondStream(reqId, streamId, content, finish),
      pushText: async (chatKey: string, chatType: 'single' | 'group', content: string) =>
        client().sendMarkdown(chatKey, chatType === 'group' ? 2 : 1, content),
    };
    const cfg = await this.core.init(deps, transport, /* supportsStream */ true);
    if (cfg.enabled && cfg.botId && cfg.secret) {
      this.connect(cfg.botId, cfg.secret);
    }
    return cfg;
  }

  private connect(botId: string, secret: string): void {
    if (!botId || !secret) return;
    this.client = new WecomClient(botId, secret, {
      onOpen: () => {
        this.deps?.log('[wecom] connected');
        this.core.status();
        this.deps?.onStatusChange(this.core.status());
      },
      onClose: (reason) => {
        this.deps?.log(`[wecom] closed: ${reason}`);
        this.core.onTransportClosed();
        this.deps?.onStatusChange(this.core.status());
      },
      onError: (err) => {
        this.deps?.log(`[wecom] error: ${err}`);
      },
      onMessage: (msg) => {
        void this.core.handleMessage({
          reqId: msg.reqId,
          msgid: msg.msgid,
          chatKey: msg.chatKey,
          chatType: msg.chattype,
          text: msg.chattype === 'group' ? stripLeadingMention(msg.text) : msg.text,
          supportsStream: true,
        });
      },
    });
    this.client.start();
  }

  async saveConfig(cfg: WecomBridgeConfig): Promise<WecomBridgeConfig> {
    const saved = await this.core.saveConfig(cfg);
    const wantConnect = saved.enabled && saved.botId && saved.secret;
    if (wantConnect) {
      // WecomClient.updateCredentials 会断开重连；简单起见每次全量重建
      if (this.client) this.client.stop();
      this.connect(saved.botId, saved.secret);
    } else if (this.client) {
      this.client.stop();
      this.client = null;
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
    this.client?.stop();
    this.client = null;
    this.core.dispose();
  }
}
