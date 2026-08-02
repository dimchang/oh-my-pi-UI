/**
 * main.ts — Electron 主进程入口：建窗、起 OmpProcessPool、注册 IPC。
 *
 * 多进程架构（v0.2.0）：每会话绑定独立 omp 进程，切换会话不中断。
 * pool 上限 5（可配），LRU 淘汰 idle 进程，懒加载。
 */

import { app, BrowserWindow, ipcMain, shell, dialog, clipboard, Menu, nativeImage, type MenuItemConstructorOptions } from 'electron';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { randomUUID, createHash } from 'crypto';

app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
import { OmpProcessPool } from './omp-pool';
import { listSessions, deleteSession, readSessionMessages, readUserEntries } from '../src/main/session-store';
import { readModelsConfig, writeProvider, deleteProvider, getAgentDir } from './omp-config';
import { listSkills, readSkillDetail, setSkillEnabled, uninstallSkill } from './omp-skills';
import { IPC } from '../src/shared/ipc-channels';
import type { FileEntry, WorkspacesFile, ApprovalMode, OmpProviderConfig, HookFileConfig, HookFileInfo, CustomCssConfig, PastedImageResult, ImageDataUrlResult } from '../src/shared/ipc-channels';
import type { RpcCommand, ExtensionUIResponseCommand } from '../src/shared/rpc-types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveOmpPath(): string {
  if (process.env.OMP_PATH) {
    try { if (fs.existsSync(process.env.OMP_PATH)) return process.env.OMP_PATH; } catch { /* */ }
  }
  if (process.platform === 'win32') {
    try {
      const result = execSync('where omp', { encoding: 'utf8', timeout: 5000 });
      for (const p of result.trim().split(/\r?\n/)) {
        const t = p.trim();
        if (t && /\.exe$/i.test(t)) { try { if (fs.existsSync(t)) return t; } catch { /* */ } }
      }
    } catch { /* */ }
  } else {
    try {
      const result = execSync('which omp', { encoding: 'utf8', timeout: 5000 });
      const t = result.trim();
      if (t) { try { if (fs.existsSync(t)) return t; } catch { /* */ } }
    } catch { /* */ }
  }
  const bunBinDir = path.join(os.homedir(), '.bun', 'bin');
  const fallbacks = process.platform === 'win32' ? [path.join(bunBinDir, 'omp.exe')] : [path.join(bunBinDir, 'omp')];
  for (const p of fallbacks) { try { if (fs.existsSync(p)) return p; } catch { /* */ } }
  return '';
}

function resolveOmpVersion(p: string): string {
  if (!p) return '';
  try {
    const out = execSync(`"${p}" --version`, { encoding: 'utf8', timeout: 5000 });
    const firstLine = out.split(/\r?\n/)[0]?.trim() ?? '';
    const m = firstLine.match(/(?:^|\s)(?:omp\/|v)?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/i);
    if (m?.[1]) return m[1];
    return firstLine || '';
  } catch { return ''; }
}

let ompPath = '';
let ompVersion = '';
function readUiVersion(): string {
  try {
    const pkgPath = path.join(__dirname, '..', '..', 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch { return 'unknown'; }
}
const UI_VERSION = readUiVersion();

let mainWindow: BrowserWindow | null = null;
let pool: OmpProcessPool | null = null;
let appQuitting = false;

const WORKSPACES_FILE = path.join(app.getPath('userData'), 'workspaces.json');

function emptyWorkspacesFile(): WorkspacesFile {
  return { version: 1, workspaces: [], currentId: null };
}

/** 简单的内存缓存：workspaces.json 内容几乎只在用户操作时变化，避免每次 IPC 都重读磁盘。
 *  以文件 mtime 作为失效判断（无 fs.watch 复杂度，但能保证修改后立即可见）。 */
let wsCache: { mtimeMs: number; data: WorkspacesFile } | null = null;

/** 手动结构校验 + 白名单式重建：JSON.parse 失败时回退默认；字段不合法（如 workspaces
 *  不是数组、元素缺 id/cwd）也回退默认，避免脏数据污染运行时。 */
function parseWorkspacesFile(raw: string): WorkspacesFile {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyWorkspacesFile();
  }
  if (!parsed || typeof parsed !== 'object') return emptyWorkspacesFile();
  if (parsed.version !== 1 || !Array.isArray(parsed.workspaces)) return emptyWorkspacesFile();
  for (const w of parsed.workspaces) {
    if (!w || typeof w !== 'object') return emptyWorkspacesFile();
    if (typeof w.id !== 'string' || typeof w.cwd !== 'string') return emptyWorkspacesFile();
  }
  return {
    version: 1,
    workspaces: parsed.workspaces,
    currentId: parsed.currentId ?? null,
    archived: Array.isArray(parsed.archived) ? parsed.archived : [],
    removedCwds: Array.isArray(parsed.removedCwds)
      ? (parsed.removedCwds as unknown[]).filter((x): x is string => typeof x === 'string')
      : [],
    lastModel: parsed.lastModel && typeof parsed.lastModel === 'object'
      ? {
          provider: String((parsed.lastModel as { provider?: unknown }).provider ?? ''),
          id: String((parsed.lastModel as { id?: unknown }).id ?? ''),
          name: typeof (parsed.lastModel as { name?: unknown }).name === 'string'
            ? (parsed.lastModel as { name: string }).name : undefined,
        }
      : undefined,
    enabledModels: Array.isArray(parsed.enabledModels)
      ? (parsed.enabledModels as unknown[]).filter((x): x is string => typeof x === 'string')
      : undefined,
    systemPrompt: typeof parsed.systemPrompt === 'string' ? parsed.systemPrompt : undefined,
    appearance: parsed.appearance && typeof parsed.appearance === 'object'
      ? (parsed.appearance as WorkspacesFile['appearance'])
      : undefined,
    // 注意：本函数是"白名单式重建对象"，saveWorkspacesFile 里新增的字段必须在这里同步补上，
    // 否则该字段会在下次启动被剥掉、随后任意一次 persist 被永久抹掉（hooks 曾踩此坑）。
    hooks: Array.isArray(parsed.hooks) ? (parsed.hooks as WorkspacesFile['hooks']) : undefined,
  };
}

async function loadWorkspacesFile(): Promise<WorkspacesFile> {
  try {
    const st = await fs.promises.stat(WORKSPACES_FILE);
    if (wsCache && wsCache.mtimeMs === st.mtimeMs) return wsCache.data;
    const raw = await fs.promises.readFile(WORKSPACES_FILE, 'utf8');
    const data = parseWorkspacesFile(raw);
    wsCache = { mtimeMs: st.mtimeMs, data };
    return data;
  } catch (e) {
    // 文件不存在（ENOENT）或解析/读取失败 → 回退空配置；不要抛出以免 IPC handler reject。
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') wsCache = null;
    return emptyWorkspacesFile();
  }
}

// issue 8：写入串行化。多个事件短内并发触发 saveWorkspacesFile 时，若各自直接 writeFile，
// 后一次写入可能基于旧数据覆盖前一次（写交错）。用模块级 Promise 队列保证 writeFile 严格串行，
// 每次写入都用调用时传入的 file 快照，避免互相覆盖。
let saveWorkspacesQueue: Promise<void> = Promise.resolve();
async function saveWorkspacesFile(file: WorkspacesFile): Promise<void> {
  const run = saveWorkspacesQueue.then(async () => {
    try {
      await fs.promises.mkdir(path.dirname(WORKSPACES_FILE), { recursive: true });
      await fs.promises.writeFile(WORKSPACES_FILE, JSON.stringify(file, null, 2), 'utf8');
      // 写入后让下次 load 重新读取（mtime 已变，这里顺手清掉避免同 tick 内读到旧缓存）。
      wsCache = null;
    } catch (e) {
      sendToRenderer(IPC.OmpStderr, { sessionPath: '', line: `[workspaces-save-error] ${e instanceof Error ? e.message : String(e)}` });
    }
  });
  // 维持队列尾部；单条写入失败仅记录，不中断后续写入。
  saveWorkspacesQueue = run.catch(() => undefined);
  return run;
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

const USE_CUSTOM_TITLE_BAR = process.platform === 'win32';

/** 简单的滑动窗口速率限制器：防止渲染进程被 XSS 攻陷后批量调用敏感 IPC。
 *  每个 key 独立计数，超过 maxCalls 次/窗口期则拒绝。 */
class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private maxCalls: number, private windowMs: number) {}
  /** 返回 true 表示允许，false 表示被限流。 */
  allow(key: string): boolean {
    const now = Date.now();
    let arr = this.hits.get(key);
    if (!arr) { arr = []; this.hits.set(key, arr); }
    // 清除窗口外的记录
    while (arr.length > 0 && arr[0]! <= now - this.windowMs) arr.shift();
    if (arr.length >= this.maxCalls) return false;
    arr.push(now);
    return true;
  }
}
/** 敏感操作限流：每个操作 10 秒内最多 20 次（正常用户操作远达不到）。 */
const sensitiveLimiter = new RateLimiter(20, 10_000);

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280, height: 840, minWidth: 900, minHeight: 600,
    backgroundColor: '#0d1117', title: 'OMP — Codex',
    frame: !USE_CUSTOM_TITLE_BAR,
    titleBarStyle: USE_CUSTOM_TITLE_BAR ? 'hidden' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true, nodeIntegration: false,
      // sandbox 保持关闭：preload 通过 contextBridge 暴露的 API 依赖 Node 能力
      // （fs/path 等仅在主进程使用，但 IPC 通道与部分能力需要非沙箱上下文；
      // 若未来 preload 完全不触碰 Node API，可开启 sandbox: true 进一步收紧）。
      sandbox: false,
    },
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  if (USE_CUSTOM_TITLE_BAR) {
    mainWindow.on('maximize', () => sendToRenderer(IPC.WindowMaximizedChange, true));
    mainWindow.on('unmaximize', () => sendToRenderer(IPC.WindowMaximizedChange, false));
  }
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

/** 自定义 CSS 持久化文件：不再污染源码 styles.css（开发态会被 git 跟踪、
 *  打包态在 asar 里只读），统一写入 userData 下的 custom.css，运行时通过
 *  webContents.insertCSS 注入渲染进程，对外行为（自定义样式生效）保持一致。 */
function customCssPath(): string {
  return path.join(app.getPath('userData'), 'custom.css');
}

/** 移除指定文件里所有 OMP-UI 自定义 CSS 区块，保留用户手动内容（含未闭合区块，见上方实现）。 */
function stripCustomCssBlocks(css: string): string {
  const lines = css.split('\n');
  const out: string[] = [];
  let inBlock = false;
  let currentId: string | null = null;
  let blockLines: string[] = []; // 当前未闭合区块内的行，EOF 时若仍未闭合则回写，避免吞掉用户 CSS
  for (const line of lines) {
    const beginMatch = line.match(/\/\* OMP-UI-CUSTOM-CSS-BEGIN: ([\w-]+) mode=(embed|link) path="([^"]*)" \*\//);
    if (beginMatch) {
      inBlock = true;
      currentId = beginMatch[1] ?? null;
      blockLines = [];
      continue;
    }
    const endMatch = line.match(/\/\* OMP-UI-CUSTOM-CSS-END: ([\w-]+) \*\//);
    if (endMatch && endMatch[1] === currentId) {
      inBlock = false;
      currentId = null;
      blockLines = [];
      continue;
    }
    if (!inBlock) out.push(line);
    else blockLines.push(line); // 临时缓冲，闭合即丢弃；未闭合则 EOF 回写
  }
  // 文件结束仍处未闭合区块：把缓冲的内容原样保留，宁可留着也别吞掉用户 CSS。
  if (inBlock) out.push(...blockLines);
  return out.join('\n');
}

/** 生成一个自定义 CSS 区块（异步读取 embed 源文件）。 */
async function buildCustomCssBlock(c: CustomCssConfig): Promise<string | null> {
  if (c.mode === 'link') {
    const fileUrl = pathToFileURL(c.path).href;
    return `/* OMP-UI-CUSTOM-CSS-BEGIN: ${c.id} mode=link path="${c.path.replace(/"/g, '\\"')}" */\n@import url("${fileUrl}");\n/* OMP-UI-CUSTOM-CSS-END: ${c.id} */`;
  }
  try {
    const content = await fs.promises.readFile(c.path, 'utf8');
    return `/* OMP-UI-CUSTOM-CSS-BEGIN: ${c.id} mode=embed path="${c.path.replace(/"/g, '\\"')}" */\n${content}\n/* OMP-UI-CUSTOM-CSS-END: ${c.id} */`;
  } catch {
    return null;
  }
}

/** 上次 insertCSS 返回的 key，更新时先移除旧样式再注入新样式。 */
let injectedCssKey: string | null = null;

/** 把合并后的自定义 CSS 注入渲染进程（运行时生效，无需改 renderer 的 import）。 */
async function injectCustomCss(css: string): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wc = mainWindow.webContents;
  try {
    if (injectedCssKey !== null) {
      await wc.removeInsertedCSS(injectedCssKey);
      injectedCssKey = null;
    }
  } catch { /* 旧 key 可能已随页面重载失效，忽略 */ }
  if (!css) return;
  try {
    injectedCssKey = await wc.insertCSS(css);
  } catch { /* 注入失败不阻断主流程 */ }
}

/** 把自定义 CSS 列表同步到 userData/custom.css，并运行时注入渲染进程。
 *  - embed：读取源文件内容写入区块；
 *  - link：区块内 @import 该文件；
 *  - 禁用/不存在的条目会被移除；
 *  - 同时保留用户在该文件手动追加的、非 OMP-UI 区块的内容（stripCustomCssBlocks）。 */
async function syncCustomCss(list: CustomCssConfig[]): Promise<{ error?: string }> {
  const target = customCssPath();
  try {
    // 1) 读取已有文件，剥离旧区块，保留用户手动内容
    let base = '';
    try { base = await fs.promises.readFile(target, 'utf8'); } catch { /* 文件不存在视为空 */ }
    base = stripCustomCssBlocks(base);

    const enabled = (list ?? []).filter((c) => c && c.enabled);
    const imports: string[] = [];
    const embeds: string[] = [];
    for (const c of enabled) {
      const block = await buildCustomCssBlock(c);
      if (!block) continue;
      if (c.mode === 'link') imports.push(block);
      else embeds.push(block);
    }

    let combined = base.trimEnd();
    if (imports.length > 0) combined += (combined ? '\n\n' : '') + imports.join('\n\n');
    if (embeds.length > 0) combined += (combined ? '\n\n' : '') + embeds.join('\n\n');
    combined = (combined + '\n').trimEnd() + '\n';

    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, combined, 'utf8');

    // 2) 运行时注入，使样式立即生效（也解决打包态 asar 内 styles.css 只读无法写入的问题）
    await injectCustomCss(imports.join('\n') + '\n' + embeds.join('\n'));
    return {};
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function registerIpc(): void {
  // ---- 多进程 RPC 路由 ----
  ipcMain.handle(IPC.RpcSend, async (_e, sessionPath: string, cmd: RpcCommand) => {
    if (!pool) throw new Error('pool not initialized');
    // extension_ui_response 无需等待 response（应答帧），直接 write
    if (cmd.type === 'extension_ui_response') {
      try {
        pool.write(sessionPath, cmd as ExtensionUIResponseCommand);
      } catch {
        // 进程已离线（如 temp key 被释放）——静默忽略，不影响用户体验
      } finally {
        pool.unpin(sessionPath);
      }
      return { type: 'response', command: 'extension_ui_response', success: true };
    }
    return pool.send(sessionPath, cmd);
  });

  ipcMain.handle(IPC.OmpAcquire, async (_e, sessionPath: string, cwd: string, approvalMode?: ApprovalMode) => {
    if (!pool) throw new Error('pool not initialized');
    // 钩子是全局的，续接/恢复的历史会话也一并加载（读取持久化配置，解析出 --hook 参数）。
    const wf = await loadWorkspacesFile();
    const hooks = await resolveHookArgs(wf.hooks, sessionPath);
    await pool.acquire(sessionPath, cwd, approvalMode ?? 'write', hooks);
  });

  ipcMain.handle(IPC.OmpNewSession, async (_e, cwd: string, approvalMode?: ApprovalMode) => {
    if (!pool) throw new Error('pool not initialized');
    // 新建会话：spawn 不带 -r/-c（新 .jsonl），用 tempKey 绑定。
    // 真实 path 在首条消息 agent_end 后落盘，renderer refreshSessions 时迁移 tempKey→realPath。
    // 用 crypto.randomUUID 作 key，杜绝 Date.now + 4 位随机的碰撞可能（issue 79）。
    const tempKey = '__new_' + randomUUID();
    // 读取持久化的系统提示词 + 钩子，注入到新会话。
    const wf = await loadWorkspacesFile();
    const systemPrompt = wf.systemPrompt;
    const hooks = await resolveHookArgs(wf.hooks, tempKey);
    await pool.acquireNew(tempKey, cwd, approvalMode ?? 'write', systemPrompt, hooks);
    return { sessionPath: tempKey };
  });

  ipcMain.handle(IPC.OmpRelease, async (_e, sessionPath: string) => {
    pool?.evict(sessionPath);
  });

  ipcMain.handle(IPC.OmpRenameKey, async (_e, oldKey: string, newKey: string) => {
    pool?.renameKey(oldKey, newKey);
  });

  ipcMain.handle(IPC.SessionList, async (_e, cwd?: string) => listSessions(cwd));
  ipcMain.handle(IPC.SessionDelete, async (_e, p: string) => {
    if (!sensitiveLimiter.allow('session-delete')) throw new Error('操作过于频繁，请稍后再试');
    await deleteSession(p);
  });
  ipcMain.handle(IPC.SessionMessages, async (_e, p: string) => readSessionMessages(p));
  ipcMain.handle(IPC.SessionUserEntries, async (_e, p: string) => readUserEntries(p));
  // 技能（Skills）管理
  ipcMain.handle(IPC.SkillsList, async () => listSkills());
  ipcMain.handle(IPC.SkillsDetail, async (_e, name: string) => readSkillDetail(name));
  ipcMain.handle(IPC.SkillsSetEnabled, async (_e, name: string, enabled: boolean) => {
    await setSkillEnabled(name, enabled);
    return listSkills();
  });
  ipcMain.handle(IPC.SkillsUninstall, async (_e, name: string) => uninstallSkill(name));

  ipcMain.handle(IPC.GetOmpInfo, async () => ({ path: ompPath, version: ompVersion || 'unknown', agentDir: getAgentDir() }));

  ipcMain.handle(IPC.OpenExternal, async (_e, url: string) => {
    // 只允许 http/https，其余（file://、自定义协议、裸路径）一律拒绝，避免借 IPC 打开任意资源。
    if (!/^https?:\/\//i.test(url)) throw new Error('仅允许打开 http/https 链接');
    await shell.openExternal(url);
  });
  ipcMain.handle(IPC.ClipboardWriteText, async (_e, text: string) => { clipboard.writeText(String(text ?? '')); });
  ipcMain.handle(IPC.ShowItemInFolder, async (_e, fullPath: string) => {
    let exists = false;
    try { exists = (await fs.promises.stat(fullPath)).isFile(); } catch { exists = false; }
    if (fullPath && exists) shell.showItemInFolder(path.normalize(fullPath));
    else { const dir = path.dirname(fullPath || ''); const res = await shell.openPath(dir); if (res) throw new Error(res); }
  });
  ipcMain.handle(IPC.ShowSaveDialog, async (_e, defaultPath?: string) => {
    if (!mainWindow) return null;
    const r = await dialog.showSaveDialog(mainWindow, { defaultPath: defaultPath ?? 'session.html', filters: [{ name: 'HTML', extensions: ['html'] }] });
    return r.canceled ? null : (r.filePath ?? null);
  });
  ipcMain.handle(IPC.ListFiles, async (_e, dirPath: string) => {
    // 仅允许枚举已注册 workspace 目录（workspaces.json 中的 cwd）之内的路径（issue 2）。
    if (!dirPath || !(await isWithinWorkspaces(dirPath))) {
      sendToRenderer(IPC.OmpStderr, { sessionPath: '', line: '[list-files] blocked: path is not inside any registered workspace' });
      return [];
    }
    return listDir(dirPath);
  });

  // renderer 就绪（多进程下不再直接起 omp，仅标记；renderer 按需 acquire）
  ipcMain.handle(IPC.RendererReady, async () => { /* no-op: pool 按需 lazy acquire */ });

  // ---- 工作空间 ----
  ipcMain.handle(IPC.WorkspacesGet, async () => await loadWorkspacesFile());
  ipcMain.handle(IPC.WorkspacesSave, async (_e, file: WorkspacesFile) => {
    if (!sensitiveLimiter.allow('workspaces-save')) throw new Error('操作过于频繁，请稍后再试');
    if (!file || file.version !== 1) throw new Error('invalid workspaces file');
    if (!Array.isArray(file.workspaces)) throw new Error('invalid workspaces: workspaces must be an array');
    // hook 配置变更后需重起 omp 进程才生效，但不在保存时批量驱逐——那会误杀正在工作的进程
    // （等 LLM 回复 / 处理文件 / 弹工具确认框）。改用懒驱逐：acquire 时比对 hooks，命中变更才在
    // 下一轮交互（会话空闲、处于两轮之间）时重起该进程，不中断任何进行中的任务。
    await saveWorkspacesFile(file);
  });
  ipcMain.handle(IPC.DialogOpenDir, async (_e, defaultPath?: string) => {
    if (!mainWindow) return null;
    const r = await dialog.showOpenDialog(mainWindow, { title: '选择工作目录', properties: ['openDirectory'], defaultPath: defaultPath || undefined });
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  });
  // 添加文件到对话：多选文件，返回绝对路径 + 名称 + 大小（渲染进程据此拼进 prompt / 展示芯片）
  ipcMain.handle(IPC.DialogOpenFiles, async (_e, defaultPath?: string) => {
    if (!mainWindow) return null;
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择要添加到对话的文件',
      properties: ['openFile', 'multiSelections'],
      defaultPath: defaultPath || undefined,
    });
    if (r.canceled || r.filePaths.length === 0) return null;
    // #10：改用异步 fs.promises.stat，避免在主进程 IPC handler 中同步阻塞所有渲染进程的 IPC 响应
    return await Promise.all(
      r.filePaths.map(async (p) => {
        let size = 0;
        try { size = (await fs.promises.stat(p)).size; } catch { /* 读不到大小就用 0 */ }
        return { path: p, name: path.basename(p), size };
      }),
    );
  });

  // ---- 图片：粘贴/拖拽落盘 + 读取为 data URL ----
  ipcMain.handle(IPC.SavePastedImage, async (_e, data: ArrayBuffer, ext: string) => {
    // 扩展名白名单（决定能不能存）：png/jpg/jpeg/gif/webp/bmp/svg
    const SAVE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);
    // resize 白名单（仅位图；gif/svg 不支持/会丢信息，原样写盘）
    const RESIZE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp']);
    const MAX_BYTES = 10 * 1024 * 1024; // 10MB 上限

    const e = (ext || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!SAVE_EXT.has(e)) throw new Error('不支持的图片格式: ' + (ext || ''));
    const bytes: Buffer = Buffer.from(data);
    if (bytes.byteLength > MAX_BYTES) throw new Error('图片过大（超过 10MB），请改用更小的图片');

    const dir = path.join(app.getPath('userData'), 'pasted-images');
    await fs.promises.mkdir(dir, { recursive: true });

    let out: Buffer = bytes;
    let outExt = e;
    // 大位图自动缩放（最长边 1280px），缩小跨进程 data URL / 磁盘占用；gif/svg 跳过
    if (RESIZE_EXT.has(e) && bytes.byteLength > 1024 * 1024) {
      try {
        const img = nativeImage.createFromBuffer(bytes);
        if (!img.isEmpty()) {
          const d = img.getSize();
          const maxW = 1280;
          if (d.width > maxW) {
            const rbuf = img.resize({ width: maxW }).toPNG();
            if (rbuf && rbuf.byteLength) { out = rbuf; outExt = 'png'; } // resize 后统一转 PNG，避免格式错位
          }
        }
      } catch { /* resize 失败就原样写盘 */ }
    }

    const name = `paste-${Date.now()}-${randomUUID().slice(0, 8)}.${outExt}`;
    const filePath = path.join(dir, name);
    await fs.promises.writeFile(filePath, out);
    return { path: filePath, name, size: out.byteLength } as PastedImageResult;
  });

  ipcMain.handle(IPC.ReadImageAsDataUrl, async (_e, filePath: string) => {
    const MIME: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
    };
    const VIEW_EXT = new Set(Object.keys(MIME));
    const e = path.extname(filePath || '').toLowerCase().replace(/^\./, '').replace(/[^a-z0-9]/g, '');
    if (!VIEW_EXT.has(e)) throw new Error('不支持的图片格式');

    // 安全白名单：仅允许读取 pasted-images/ 或工作区内的图片，防本地文件泄露（含符号链接逃逸）
    const userDataDir = app.getPath('userData');
    const pastedDir = path.join(userDataDir, 'pasted-images');
    let pastedDirReal: string | null = null;
    try { pastedDirReal = (await fs.promises.realpath(pastedDir)).toLowerCase(); } catch { pastedDirReal = null; }
    let allowed = false;
    if (pastedDirReal) {
      let real: string;
      try { real = (await fs.promises.realpath(filePath)).toLowerCase(); }
      catch { real = path.resolve(filePath).toLowerCase(); }
      if (real === pastedDirReal || real.startsWith(pastedDirReal + path.sep)) allowed = true;
    }
    if (!allowed && (await isWithinWorkspaces(filePath))) allowed = true;
    if (!allowed) throw new Error('禁止读取该路径的图片');

    const buf = await fs.promises.readFile(filePath);
    const b64 = buf.toString('base64');
    const mime = MIME[e] || 'application/octet-stream';
    return { dataUrl: `data:${mime};base64,${b64}` } as ImageDataUrlResult;
  });


  // 启动清理：删除 pasted-images/ 中超过 14 天的文件，避免无限增长（fire-and-forget）
  void cleanupPastedImages();

  // ---- 钩子（Hooks）管理 ----
  ipcMain.handle(IPC.OmpPickHookFiles, async () => {
    if (!mainWindow) return null;
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择钩子文件（.ts）',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'TypeScript', extensions: ['ts'] }],
    });
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths;
  });
  ipcMain.handle(IPC.OmpParseHookFiles, async (_e, paths: string[]) => {
    if (!Array.isArray(paths)) return [];
    return await Promise.all(paths.map((p) => parseHookFile(p)));
  });

  // ---- 自定义 CSS 导入 ----
  ipcMain.handle(IPC.OmpPickCssFile, async () => {
    if (!mainWindow) return null;
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择 CSS 文件（.css）',
      properties: ['openFile'],
      filters: [{ name: 'CSS', extensions: ['css'] }],
    });
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  });
  ipcMain.handle(IPC.OmpReadCssFile, async (_e, filePath: string) => {
    try {
      // 安全校验（issue 6）：符号链接绕过。renderer 可传入指向系统文件（如 /etc/passwd）
      // 的符号链接，仅校验"源路径"的 .css 扩展名无法拦截（源是 evil.css，目标是任意文件）。
      // 修复：先用 realpath 解析出真实目标，再对"目标"做扩展名 + 工作区边界双重校验。
      if (typeof filePath !== 'string' || !filePath) return { content: '', error: 'invalid path' };
      let realPath: string;
      try {
        realPath = await fs.promises.realpath(filePath);
      } catch {
        return { content: '', error: 'file not accessible' };
      }
      if (path.extname(realPath).toLowerCase() !== '.css') {
        return { content: '', error: 'only .css files are allowed' };
      }
      // 边界校验：realpath 后的真实目标必须位于已注册工作区之内，杜绝 symlink 逃逸读取任意文件。
      if (!(await isWithinWorkspaces(realPath))) {
        return { content: '', error: 'css file must be inside a registered workspace' };
      }
      const content = await fs.promises.readFile(realPath, 'utf8');
      return { content };
    } catch (e: any) {
      return { content: '', error: String(e?.message ?? e) };
    }
  });
  ipcMain.handle(IPC.OmpSyncCustomCss, async (_e, list: CustomCssConfig[]) => {
    if (!Array.isArray(list)) return { error: 'invalid list' };
    return await syncCustomCss(list);
  });

  // ---- 上下文文件读写（AGENTS.md / SYSTEM.md / APPEND_SYSTEM.md / RULES.md）----
  ipcMain.handle(IPC.ContextFileRead, async (_e, filePath: string) => {
    if (typeof filePath !== 'string' || !filePath) return '';
    try {
      return await fs.promises.readFile(filePath, 'utf8');
    } catch {
      return ''; // 文件不存在返回空串
    }
  });
  ipcMain.handle(IPC.ContextFileWrite, async (_e, filePath: string, content: string) => {
    if (typeof filePath !== 'string' || !filePath) throw new Error('无效路径');
    // 空内容 = 删除文件（清理不需要的上下文）
    if (!content || !content.trim()) {
      try { await fs.promises.unlink(filePath); } catch { /* 不存在也无妨 */ }
      return;
    }
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, content, 'utf8');
  });

  // ---- 模型配置 ----
  ipcMain.handle(IPC.OmpModelsRead, async () => await readModelsConfig());
  ipcMain.handle(IPC.OmpModelsWriteProvider, async (_e, id: string, cfg: OmpProviderConfig) => {
    if (!sensitiveLimiter.allow('models-write')) throw new Error('操作过于频繁，请稍后再试');
    await writeProvider(id, cfg);
  });
  ipcMain.handle(IPC.OmpModelsDeleteProvider, async (_e, id: string) => {
    if (!sensitiveLimiter.allow('models-delete')) throw new Error('操作过于频繁，请稍后再试');
    await deleteProvider(id);
  });

  // ---- 自定义标题栏 ----
  if (USE_CUSTOM_TITLE_BAR) {
    ipcMain.handle(IPC.WindowMinimize, () => mainWindow?.minimize());
    ipcMain.handle(IPC.WindowMaximize, () => { if (!mainWindow) return; if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize(); });
    ipcMain.handle(IPC.WindowClose, () => mainWindow?.close());
    ipcMain.handle(IPC.WindowIsMaximized, () => mainWindow?.isMaximized() ?? false);
    ipcMain.handle(IPC.MenuReload, () => mainWindow?.webContents.reload());
    ipcMain.handle(IPC.MenuForceReload, () => mainWindow?.webContents.reloadIgnoringCache());
    ipcMain.handle(IPC.MenuToggleDevTools, () => { if (!mainWindow) return; if (mainWindow.webContents.isDevToolsOpened()) mainWindow.webContents.closeDevTools(); else mainWindow.webContents.openDevTools(); });
    ipcMain.handle(IPC.MenuResetZoom, () => mainWindow?.webContents.setZoomLevel(0));
    ipcMain.handle(IPC.MenuZoomIn, () => { const wc = mainWindow?.webContents; if (wc) wc.setZoomLevel(wc.getZoomLevel() + 0.5); });
    ipcMain.handle(IPC.MenuZoomOut, () => { const wc = mainWindow?.webContents; if (wc) wc.setZoomLevel(wc.getZoomLevel() - 0.5); });
    ipcMain.handle(IPC.MenuToggleFullscreen, () => { if (!mainWindow) return; mainWindow.setFullScreen(!mainWindow.isFullScreen()); });
    ipcMain.handle(IPC.MenuShowAbout, () => showAboutDialog());
    ipcMain.handle(IPC.MenuStatsClick, () => { mainWindow?.webContents.send(IPC.MenuStats); });
  }
}

app.whenReady().then(() => {
  ompPath = resolveOmpPath();
  if (!ompPath) {
    dialog.showErrorBox('未找到 OMP', '无法在系统中找到 omp 命令行工具（oh-my-pi）。\n\n请先安装 omp，并确保 omp 命令在系统 PATH 中可用。\n\n常见安装方式：\n  bun install -g oh-my-pi\n\n或通过环境变量 OMP_PATH 手动指定路径。');
    app.quit();
    return;
  }
  ompVersion = resolveOmpVersion(ompPath);

  // 启动时确保 vision 模式为 on（默认 auto 不会对已配置视觉模型的 provider 强制启用 inspect_image）
  try { execSync(`"${ompPath}" config set inspect_image.mode on`, { encoding: 'utf8', timeout: 5000 }); } catch { /* best-effort */ }

  // 初始化进程池
  pool = new OmpProcessPool(ompPath, {
    onFrame: (sessionPath, frame) => {
      // 交互式 UI 请求（confirm/select/input/editor/open_url）入队等用户应答：
      // pin 该会话，防止它在用户犹豫期间被 LRU 淘汰（等待中不输出帧，会被误判最闲）。
      const fr = frame as { type?: string; method?: string };
      if (fr.type === 'extension_ui_request' && ['confirm', 'select', 'input', 'editor', 'open_url'].includes(fr.method ?? '')) {
        pool?.pin(sessionPath);
      }
      sendToRenderer(IPC.RpcEvent, { ...(frame as object), __sessionPath: sessionPath });
    },
    onReady: (sessionPath) => sendToRenderer(IPC.RpcReady, sessionPath),
    onExit: (sessionPath, code) => { pool?.unpin(sessionPath); sendToRenderer(IPC.OmpExit, { sessionPath, code }); },
    onStderr: (sessionPath, line) => sendToRenderer(IPC.OmpStderr, { sessionPath, line }),
    onLog: (line) => { /* pool 内部日志（如 LRU 淘汰），静默 */ },
  });

  registerIpc();
  createWindow();
  buildAppMenu();

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

function buildAppMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? ([{ role: 'appMenu' }] as MenuItemConstructorOptions[]) : []),
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'help', label: 'Help', submenu: [
      { label: '关于 OMP UI', click: () => showAboutDialog() },
      { type: 'separator' },
      { label: 'Stats (会话统计)', click: () => { mainWindow?.webContents.send(IPC.MenuStats); } },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function showAboutDialog(): void {
  const lines = [`OMP UI 版本：${UI_VERSION}`, `OMP 版本：${ompVersion || '未知'}`, `连接的 OMP：${ompPath || '未连接'}`];
  const opts: Electron.MessageBoxOptions = { type: 'info', title: '关于 OMP UI', message: 'OMP UI', detail: lines.join('\n'), buttons: ['确定'], noLink: true };
  if (mainWindow && !mainWindow.isDestroyed()) void dialog.showMessageBox(mainWindow, opts);
  else void dialog.showMessageBox(opts);
}

app.on('window-all-closed', () => {
  appQuitting = true;
  pool?.killAll();
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  appQuitting = true;
  pool?.killAll();
});

async function listDir(dirPath: string): Promise<FileEntry[]> {
  // 全异步 + 并发 stat：避免在主进程事件循环里做同步 I/O
  // （dist/、out/ 这类几百上千文件的构建产物目录，同步逐项 statSync 会阻塞主进程）。
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const filtered = entries.filter((e) => {
      if (e.name.startsWith('.') && e.name !== '.gitignore') return false;
      if (e.name === 'node_modules' || e.name === '.git') return false;
      return true;
    });
    const result = (await Promise.all(
      filtered.map(async (e): Promise<FileEntry | null> => {
        const full = path.join(dirPath, e.name);
        try {
          const stat = await fs.promises.stat(full);
          return { name: e.name, path: full, isDir: stat.isDirectory(), size: stat.isFile() ? stat.size : undefined, mtime: stat.mtimeMs };
        } catch { return null; /* 无权限/坏链接等，跳过 */ }
      }),
    )).filter((x): x is FileEntry => x !== null);
    result.sort((a, b) => { if (a.isDir !== b.isDir) return a.isDir ? -1 : 1; return a.name.localeCompare(b.name); });
    return result;
  } catch { return []; }
}

// ---- 钩子（Hooks）静态解析 + 参数解析 ----

/** 判断 dirPath 是否位于已注册 workspace（workspaces.json 中的 cwd）目录之内。
 *  比较前把两边 realpath + 小写归一化，容忍大小写不敏感文件系统（如 Windows）。 */
async function isWithinWorkspaces(dirPath: string): Promise<boolean> {
  let target: string;
  try {
    target = (await fs.promises.realpath(dirPath)).toLowerCase();
  } catch {
    try { target = path.resolve(dirPath).toLowerCase(); } catch { return false; }
  }
  const wf = await loadWorkspacesFile();
  for (const w of wf.workspaces) {
    let base: string;
    try { base = (await fs.promises.realpath(w.cwd)).toLowerCase(); } catch { base = path.resolve(w.cwd).toLowerCase(); }
    if (target === base || target.startsWith(base + path.sep)) return true;
  }
  return false;
}

/** 删除 userData/pasted-images 中超过 14 天的文件，避免粘贴图片无限增长。
 *  只触碰 pasted-images 目录本身，任何异常都吞掉（不影响启动）。 */
async function cleanupPastedImages(): Promise<void> {
  try {
    const dir = path.join(app.getPath('userData'), 'pasted-images');
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch { return; } // 目录不存在则跳过
    const MAX_AGE = 14 * 24 * 3600 * 1000;
    const now = Date.now();
    await Promise.all(entries.filter((en) => en.isFile()).map(async (en) => {
      try {
        const fp = path.join(dir, en.name);
        const st = await fs.promises.stat(fp);
        if (now - st.mtimeMs > MAX_AGE) await fs.promises.unlink(fp);
      } catch { /* ignore */ }
    }));
  } catch { /* ignore */ }
}

/** 静态解析一个 .ts 钩子文件：默认导出 / 具名导出 / pi.on 事件名。不执行代码。 */
async function parseHookFile(filePath: string): Promise<HookFileInfo> {
  const base: HookFileInfo = { path: filePath, hasDefault: false, namedHooks: [], events: [] };
  try {
    const src = await fs.promises.readFile(filePath, 'utf8');
    // 去掉块注释；行注释仅剥离"行首（允许前导空白）的 //"（保守策略，issue 80）：
    // 避免误伤字符串里的 URL（如 "https://..."）或含 // 的合法内容。
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    // 默认导出（函数 / 类 / 箭头 / 标识符）
    base.hasDefault =
      /export\s+default\s+(?:async\s+)?(?:function|class|\()/.test(noComments) ||
      /export\s+default\s+[\w$]/.test(noComments);
    // 具名导出（函数 / const / let / var）
    const namedRe = /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
    const named = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = namedRe.exec(noComments))) {
      const name = m[1] || m[2];
      if (name) named.add(name);
    }
    base.namedHooks = [...named];
    // pi.on("event", ...) 事件名
    const evtRe = /pi\s*\.\s*on\s*\(\s*['"]([\w-]+)['"]/g;
    const events = new Set<string>();
    while ((m = evtRe.exec(noComments))) { if (m[1]) events.add(m[1]); }
    base.events = [...events];
  } catch (e) {
    base.error = e instanceof Error ? e.message : String(e);
  }
  return base;
}

/** 包装文件名：清洗后的完整路径（去 hash 化，同路径必同名、异路径必异名，杜绝碰撞）。
 *  仅当清洗结果过长（Windows 路径长度上限风险）时截尾 + 追加短 hash 兜底唯一性。 */
function hookWrapperName(hookPath: string): string {
  const sanitized = hookPath.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  if (sanitized.length <= 140) return `${sanitized}.ts`;
  let h = 0;
  for (let i = 0; i < hookPath.length; i++) h = (h * 31 + hookPath.charCodeAt(i)) | 0;
  return `${sanitized.slice(-120)}-${Math.abs(h).toString(36)}.ts`;
}

/** 每个 session 独立的 hook 缓存子目录（以 session 路径的 sha1 命名），
 *  使并发 acquire 时各 session 只清理自己的目录，杜绝误删他人刚写入的 wrapper（issue 3）。 */
function sessionHookCacheDir(sessionPath: string): string {
  const h = createHash('sha1').update(sessionPath).digest('hex');
  return path.join(app.getPath('userData'), 'hook-cache', h);
}

/** 把持久化的钩子配置解析成 omp 启动参数 `--hook=<path>` 列表。
 *  - 整文件默认导出（fileLevel）→ 直接传原文件。
 *  - 多单元（具名导出）→ 生成过滤包装文件（只调用启用的单元），传包装文件。
 *  包装文件写到 userData/hook-cache/<session-hash>/；每次解析后只清理"本 session
 *  子目录"内不在本次期望集合的陈旧文件（不碰其他 session，避免并发竞态）。 */
async function resolveHookArgs(hooks?: HookFileConfig[], sessionPath?: string): Promise<string[]> {
  const args: string[] = [];
  const cacheDir = sessionPath ? sessionHookCacheDir(sessionPath) : path.join(app.getPath('userData'), 'hook-cache');
  const expected = new Set<string>();
  if (hooks && hooks.length > 0) {
    try { await fs.promises.mkdir(cacheDir, { recursive: true }); } catch { /* noop */ }
    for (const cfg of hooks) {
      if (!cfg.enabled || !cfg.units || cfg.units.length === 0) continue;
      const fileLevelUnit = cfg.units.find((u) => u.fileLevel);
      if (fileLevelUnit) {
        args.push(cfg.path); // 整文件一个钩子：直接传原文件
        continue;
      }
      // 多单元：取启用的单元名（省略 enabledUnits = 全部启用）
      const enabled = cfg.enabledUnits && cfg.enabledUnits.length
        ? cfg.enabledUnits
        : cfg.units.map((u) => u.name);
      const active = enabled.filter((n) => cfg.units.some((u) => u.name === n));
      if (active.length === 0) continue;
      const importPath = JSON.stringify(cfg.path);
      const calls = active
        .map((n) => `  if (typeof __mod[${JSON.stringify(n)}] === "function") __mod[${JSON.stringify(n)}](pi);`)
        .join('\n');
      const wrapper =
        `// AUTO-GENERATED by OMP-UI — do not edit\n` +
        `import * as __mod from ${importPath};\n` +
        `export default function (pi: any) {\n${calls}\n}\n`;
      const fileName = hookWrapperName(cfg.path);
      const outPath = path.join(cacheDir, fileName);
      try {
        await fs.promises.writeFile(outPath, wrapper, 'utf8');
        expected.add(fileName);
        args.push(outPath);
      } catch { /* 写失败则跳过该文件 */ }
    }
  }
  // 仅清理本 session 子目录下的废弃 wrapper（不影响其他 session，避免并发竞态）
  try {
    const files = await fs.promises.readdir(cacheDir);
    for (const f of files) {
      if (!expected.has(f)) {
        try { await fs.promises.unlink(path.join(cacheDir, f)); } catch { /* noop */ }
      }
    }
  } catch { /* 目录不存在则无需清理 */ }
  return args;
}
