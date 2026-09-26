/**
 * omp-paths.ts — omp 目录解析的唯一来源（§4.2）。
 *
 * 背景：omp 18.1.3 起 listAllSessions 扫描的是活跃的 getSessionsDir() 根，
 * 不再硬编码 ~/.omp/agent/sessions；当用户设置 OMP_HOME（或未来 XDG_DATA_HOME）时，
 * omp 写会话的位置与 GUI 扫盘的位置必须一致，否则侧栏扫不到会话。
 *
 * 分层约束：本模块放 src/shared/，供 electron/omp-config.ts 与 src/main/session-store.ts
 * 共同引用（src/main 不允许反向 import electron/）。
 */

import * as os from 'os';
import * as path from 'path';

/** omp agent 配置目录（与 omp getAgentDir() 一致：$OMP_HOME/agent 或 ~/.omp/agent） */
export function ompAgentDir(): string {
  const base = process.env.OMP_HOME && process.env.OMP_HOME.trim()
    ? process.env.OMP_HOME
    : path.join(os.homedir(), '.omp');
  return path.join(base, 'agent');
}
