// capture-select.mjs — 抓真实 extension_ui_request(select) 帧
import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

function resolveOmp() {
  if (process.env.OMP_PATH) return process.env.OMP_PATH;
  try {
    const cmd = process.platform === 'win32' ? 'where omp' : 'which omp';
    return execSync(cmd, { windowsHide: true }).toString().trim().split(/\r?\n/)[0];
  } catch {
    console.error('找不到 omp。请安装 (bun install -g oh-my-pi) 或设置 OMP_PATH 环境变量。');
    process.exit(1);
  }
}

const OMP = resolveOmp();
const CWD = process.env.OMP_CWD || path.resolve(__dirname, '..');
const OUT = path.join(CWD, '.temp', 'capture-frames.jsonl');
const frames = [];
const child = spawn(OMP, ['--mode', 'rpc-ui', '--approval-mode', 'write', '--no-session'], {
  cwd: CWD,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', NO_COLOR: '1' },
});
const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
const dump = () => fs.writeFileSync(OUT, frames.map((f) => JSON.stringify(f)).join('\n'));
const deadline = setTimeout(() => {
  console.error('TIMEOUT; frames captured=', frames.length, '->', OUT);
  dump();
  child.kill('SIGKILL');
  process.exit(1);
}, 30000);
function send(cmd) { child.stdin.write(JSON.stringify(cmd) + '\n'); }
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let f; try { f = JSON.parse(t); } catch { return; }
  frames.push(f);
  if (f.type === 'extension_ui_request') {
    console.error('[REQ] method=', f.method, 'id=', f.id, 'title=', f.title, 'options=', JSON.stringify(f.options));
  }
  if (f.type === 'ready') {
    console.error('[ok] ready -> sending prompt');
    send({ id: 'p1', type: 'prompt', message: 'Run the command: dir' });
  }
});
child.stderr.on('data', (d) => process.stderr.write('[stderr] ' + d.toString()));
child.on('exit', (code) => {
  console.error('omp exit', code, 'frames=', frames.length, '->', OUT);
  dump();
  clearTimeout(deadline);
  process.exit(0);
});
