/**
 * frame-router.ts — 按 id 关联请求/响应，按 type 分发 omp 输出帧。
 */

import { randomUUID } from 'crypto';
import type { OmpFrame, RpcCommand, RpcResponse } from '../shared/rpc-types';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

interface Pending {
  resolve: (resp: RpcResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  command: string;
}

export interface FrameRouterDeps {
  write(cmd: RpcCommand): void;
  /** 非 response 帧推给渲染进程 */
  pushEvent(frame: OmpFrame): void;
  onLog(line: string): void;
}

export class FrameRouter {
  private pending = new Map<string, Pending>();

  constructor(private deps: FrameRouterDeps) {}

  /** 发送命令并等待响应。自动赋 id。 */
  send<T = unknown>(cmd: RpcCommand): Promise<RpcResponse<T>> {
    const id = cmd.id ?? randomUUID();
    const withId = { ...cmd, id } as RpcCommand;
    return new Promise<RpcResponse<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc timeout: ${withId.type}`));
      }, DEFAULT_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as never, reject, timer, command: withId.type });
      try {
        this.deps.write(withId);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** 分发 omp 输出帧。response 解 pending，其余推事件。 */
  dispatch(frame: OmpFrame): void {
    const f = frame as { type?: string; id?: string; command?: string };
    if (f.type === 'response') {
      const resp = frame as RpcResponse;
      // 未知命令 / 解析异常的响应 id 可能为 undefined，无法关联则记日志
      if (resp.id && this.pending.has(resp.id)) {
        const p = this.pending.get(resp.id)!;
        clearTimeout(p.timer);
        this.pending.delete(resp.id);
        if (resp.success) {
          p.resolve(resp);
        } else {
          p.reject(new Error(`${resp.command}: ${resp.error ?? 'unknown error'}`));
        }
      } else {
        this.deps.onLog(`[unmatched-response] command=${resp.command} success=${resp.success} ${resp.error ?? ''}`);
      }
      return;
    }
    // 其余全部推给渲染层
    this.deps.pushEvent(frame);
  }

  /** 进程退出时拒绝所有 pending */
  rejectAll(reason: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
