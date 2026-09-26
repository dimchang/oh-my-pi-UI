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
    const bridgeSelf = this;
    const transport = {
      get connected(): boolean {
        return bridgeSelf.client?.connected ?? false;
      },
      respondText: (reqId: string, content: string) => bridgeSelf.client!.respondText(reqId, content),
      respondStream: (reqId: string, streamId: string, content: string, finish: boolean) =>
        bridgeSelf.client!.respondStream(reqId, streamId, content, finish),
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
          text: msg.text,
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
