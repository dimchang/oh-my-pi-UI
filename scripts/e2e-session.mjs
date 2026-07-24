import { spawn, execSync } from 'child_process';
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
const child = spawn(OMP, ['--mode','rpc-ui','--approval-mode','write'], { cwd: CWD, stdio:['pipe','pipe','pipe'], env:{...process.env, NO_COLOR:'1'} });
const rl = readline.createInterface({ input: child.stdout });
let step='ready';
const dl=setTimeout(()=>{console.error('TIMEOUT step=',step);child.kill('SIGKILL');process.exit(1);},20000);
rl.on('line',(l)=>{const t=l.trim();if(!t)return;let f;try{f=JSON.parse(t)}catch{return}
  if(f.type==='ready'&&step==='ready'){console.log('[ok] ready');step='gm';child.stdin.write(JSON.stringify({id:'1',type:'get_messages'})+'\n');}
  else if(f.type==='response'&&f.command==='get_messages'&&step==='gm'){console.log('[ok] get_messages success=',f.success,'count=',(f.data?.messages??[]).length);step='gs';child.stdin.write(JSON.stringify({id:'2',type:'get_session_stats'})+'\n');}
  else if(f.type==='response'&&f.command==='get_session_stats'){console.log('[ok] get_session_stats success=',f.success);clearTimeout(dl);child.kill('SIGKILL');console.log('SESSION-CMDS PASS');process.exit(0);}
});
child.on('exit',(c)=>{if(step!=='done')console.error('early exit',c,step);});
