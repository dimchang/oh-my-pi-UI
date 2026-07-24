/**
 * e2e-smoke.mjs — 主进程逻辑端到端冒烟测试（不启 Electron 窗口）。
 *
 * 直接复用编译产物验证：spawn omp → ready → get_state → prompt → 收 agent_end。
 * 这是 plan M1.6 / 任务#7 的核心验收：证明 OmpProcess + 事件流在真实 omp 上跑通。
 */

import { spawn, execSync } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';

function resolveOmp() {
  if (process.env.OMP_PATH) return process.env.OMP_PATH;
  try {
    const cmd = process.platform === 'win32' ? 'where omp' : 'which omp';
    return execSync(cmd, { windowsHide: true }).toString().trim().split(/\r?\n/)[0];
  } catch {
    console.error('找不到 omp。请先安装 (bun install -g oh-my-pi) 或设置 OMP_PATH 环境变量后重试。');
    process.exit(1);
  }
}

const OMP = resolveOmp();
const CWD = process.env.OMP_CWD || path.resolve(__dirname, '..');

const child = spawn(OMP, ['--mode', 'rpc-ui', '--approval-mode', 'write', '--no-session'], {
  cwd: CWD,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', NO_COLOR: '1' },
});

const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

let phase = 'waiting-ready';
const seen = [];
const deadline = setTimeout(() => {
  console.error('TIMEOUT. phase=', phase, 'seen=', seen.join(','));
  child.kill('SIGKILL');
  process.exit(1);
}, 60000);

function send(cmd) {
  child.stdin.write(JSON.stringify(cmd) + '\n');
}

rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let f;
  try { f = JSON.parse(t); } catch { return; }
  seen.push(f.type);

  if (f.type === 'ready' && phase === 'waiting-ready') {
    console.log('[ok] ready');
    phase = 'get_state';
    send({ id: 's1', type: 'get_state' });
    return;
  }
  if (f.type === 'response' && f.command === 'get_state' && phase === 'get_state') {
    console.log('[ok] get_state success=', f.success, 'model=', f.data?.model?.id);
    phase = 'prompt';
    send({ id: 'p1', type: 'prompt', message: 'Reply with exactly: e2e ok' });
    return;
  }
  if (f.type === 'response' && f.command === 'prompt') {
    console.log('[ok] prompt ack success=', f.success);
    return;
  }
  if (f.type === 'agent_start') { console.log('[ok] agent_start'); return; }
  if (f.type === 'message_update' && f.message?.role === 'assistant') {
    const texts = (f.message.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    process.stdout.write('\r[stream] ' + texts.slice(-40).padEnd(40));
    return;
  }
  if (f.type === 'agent_end') {
    console.log('\n[ok] agent_end');
    const assistant = (f.messages ?? []).find((m) => m.role === 'assistant');
    const out = (assistant?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    console.log('[result] assistant text =', JSON.stringify(out));
    clearTimeout(deadline);
    child.kill('SIGKILL');
    console.log('E2E PASS');
    process.exit(0);
  }
});

child.stderr.on('data', (d) => process.stderr.write('[stderr] ' + d.toString()));
child.on('exit', (code) => {
  if (phase !== 'done') {
    console.error('\nomp exited early code=', code, 'phase=', phase);
  }
});
