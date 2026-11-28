/**
 * omp-paths.ts — omp 目录解析的唯一来源（§4.2 / omp 18.18.8）。
 *
 * 背景：
 * - omp 18.1.3 起 listAllSessions 扫描的是活跃的 getSessionsDir() 根，不再硬编码 ~/.omp/agent/sessions；
 * - omp 18.18.8 起用户级 ~/.omp/agent 配置遵循 PI_CODING_AGENT_DIR；
 * - omp 18.12.3 起 skills.customDirectories 等配置路径支持 ~ 展开。
 *
 * 分层约束：本模块放 src/shared/，供 electron/omp-config.ts、electron/omp-skills.ts
 * 与 src/main/session-store.ts 共同引用（src/main 不允许反向 import electron/）。
 */

import * as os from 'os';
import * as path from 'path';

/** omp agent 配置目录（与 omp getAgentDir() 一致：PI_CODING_AGENT_DIR → $OMP_HOME/agent → ~/.omp/agent） */
export function ompAgentDir(): string {
  const explicit = process.env.PI_CODING_AGENT_DIR && process.env.PI_CODING_AGENT_DIR.trim();
  if (explicit) return expandHomeDir(explicit);
  const base = process.env.OMP_HOME && process.env.OMP_HOME.trim()
    ? expandHomeDir(process.env.OMP_HOME.trim())
    : path.join(os.homedir(), '.omp');
  return path.join(base, 'agent');
}

/** 展开路径开头的 `~` / `~/` / `~\`（omp 18.12.3：skills.customDirectories 等配置支持波浪号） */
export function expandHomeDir(p: string, homeDir?: string): string {
  const trimmed = p.trim();
  if (!trimmed) return trimmed;
  const home = homeDir ?? os.homedir();
  if (trimmed === '~') return home;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(home, trimmed.slice(2));
  }
  return trimmed;
}
