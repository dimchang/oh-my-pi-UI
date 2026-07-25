/**
 * main.ts — Electron 主进程入口：建窗、起 OmpProcessPool、注册 IPC。
 *
 * 多进程架构（v0.2.0）：每会话绑定独立 omp 进程，切换会话不中断。
 * pool 上限 5（可配），LRU 淘汰 idle 进程，懒加载。
 */

import { app, BrowserWindow, ipcMain, shell, dialog, clipboard, Menu, type MenuItemConstructorOptions } from 'electron';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
import { OmpProcessPool } from './omp-pool';
import { listSessions, deleteSession, readSessionMessages, readUserEntries } from '../src/main/session-store';
import { readModelsConfig, writeProvider, deleteProvider } from './omp-config';
import { IPC } from '../src/shared/ipc-channels';
import type { FileEntry, WorkspacesFile, ApprovalMode, OmpProviderConfig, HookFileConfig, HookFileInfo, CustomCssConfig } from '../src/shared/ipc-channels';
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
    if (m) return m[1];
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
const WORK_DIR = process.env.OMP_WORKDIR ?? process.cwd();

let mainWindow: BrowserWindow | null = null;
let pool: OmpProcessPool | null = null;
let appQuitting = false;

const WORKSPACES_FILE = path.join(app.getPath('userData'), 'workspaces.json');

function emptyWorkspacesFile(): WorkspacesFile {
  return { version: 1, workspaces: [], currentId: null };
}

function loadWorkspacesFile(): WorkspacesFile {
  try {
    if (!fs.existsSync(WORKSPACES_FILE)) return emptyWorkspacesFile();
    const raw = fs.readFileSync(WORKSPACES_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<WorkspacesFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.workspaces)) return emptyWorkspacesFile();
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
    };
  } catch { return emptyWorkspacesFile(); }
}

function saveWorkspacesFile(file: WorkspacesFile): void {
  try {
    fs.mkdirSync(path.dirname(WORKSPACES_FILE), { recursive: true });
    fs.writeFileSync(WORKSPACES_FILE, JSON.stringify(file, null, 2), 'utf8');
  } catch (e) {
    sendToRenderer(IPC.OmpStderr, { sessionPath: '', line: `[workspaces-save-error] ${e instanceof Error ? e.message : String(e)}` });
  }
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

const USE_CUSTOM_TITLE_BAR = process.platform === 'win32';

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280, height: 840, minWidth: 900, minHeight: 600,
    backgroundColor: '#0d1117', title: 'OMP — Codex',
    frame: !USE_CUSTOM_TITLE_BAR,
    titleBarStyle: USE_CUSTOM_TITLE_BAR ? 'hidden' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
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

/** 定位 styles.css：优先开发源码路径，其次打包输出路径。 */
function findStylesCssPath(): string | null {
  const candidates = [
    path.join(__dirname, '..', '..', 'src', 'renderer', 'styles.css'),
    path.join(__dirname, '..', '..', 'out', 'renderer', 'styles.css'),
    path.join(__dirname, '..', 'renderer', 'styles.css'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** 移除 styles.css 中所有 OMP-UI 自定义 CSS 区块。 */
function stripCustomCssBlocks(css: string): string {
  const lines = css.split('\n');
  const out: string[] = [];
  let inBlock = false;
  let currentId: string | null = null;
  for (const line of lines) {
    const beginMatch = line.match(/\/\* OMP-UI-CUSTOM-CSS-BEGIN: ([\w-]+) mode=(embed|link) path="([^"]*)" \*\//);
    if (beginMatch) {
      inBlock = true;
      currentId = beginMatch[1];
      continue;
    }
    const endMatch = line.match(/\/\* OMP-UI-CUSTOM-CSS-END: ([\w-]+) \*\//);
    if (endMatch && endMatch[1] === currentId) {
      inBlock = false;
      currentId = null;
      continue;
    }
    if (!inBlock) out.push(line);
  }
  return out.join('\n');
}

/** 生成一个自定义 CSS 区块。 */
function buildCustomCssBlock(c: CustomCssConfig): string | null {
  if (c.mode === 'link') {
    const fileUrl = pathToFileURL(c.path).href;
    return `/* OMP-UI-CUSTOM-CSS-BEGIN: ${c.id} mode=link path="${c.path.replace(/"/g, '\\"')}" */\n@import url("${fileUrl}");\n/* OMP-UI-CUSTOM-CSS-END: ${c.id} */`;
  }
  try {
    const content = fs.readFileSync(c.path, 'utf8');
    return `/* OMP-UI-CUSTOM-CSS-BEGIN: ${c.id} mode=embed path="${c.path.replace(/"/g, '\\"')}" */\n${content}\n/* OMP-UI-CUSTOM-CSS-END: ${c.id} */`;
  } catch {
    return null;
  }
}

/** 把自定义 CSS 列表同步到 styles.css。
 *  - embed：内容追加到文件尾部；
 *  - link：@import 插入到文件顶部（@charset 之后、其他规则之前）；
 *  - 禁用/不存在的条目会被移除。 */
function syncCustomCss(list: CustomCssConfig[]): { error?: string } {
  const stylesPath = findStylesCssPath();
  if (!stylesPath) return { error: '未找到 styles.css（开发态应为 src/renderer/styles.css，打包后应为 out/renderer/styles.css）' };
  try {
    let css = fs.readFileSync(stylesPath, 'utf8');
    css = stripCustomCssBlocks(css);

    const enabled = (list ?? []).filter((c) => c && c.enabled);
    const imports: string[] = [];
    const embeds: string[] = [];
    for (const c of enabled) {
      const block = buildCustomCssBlock(c);
      if (!block) continue;
      if (c.mode === 'link') imports.push(block);
      else embeds.push(block);
    }

    // 把 link 的 @import 放在文件顶部（CSS 规范要求在其他规则之前）
    if (imports.length > 0) {
      const lines = css.split('\n');
      let insertIdx = 0;
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (!t) continue;
        if (t.startsWith('/*') && t.endsWith('*/')) continue;
        if (t.startsWith('@charset')) continue;
        insertIdx = i;
        break;
      }
      lines.splice(insertIdx, 0, imports.join('\n\n') + '\n');
      css = lines.join('\n');
    }

    // embed 追加到文件末尾
    if (embeds.length > 0) {
      css = css.trimEnd() + '\n\n' + embeds.join('\n\n') + '\n';
    }

    fs.writeFileSync(stylesPath, css, 'utf8');
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
      } finally {
        // 不论成败都释放该会话的 UI pin（应答已结束）。
        // 失败（进程已离线）时 IPC 会 reject，由渲染端弹错提示，不静默吞掉。
        pool.unpin(sessionPath);
      }
      return { type: 'response', command: 'extension_ui_response', success: true };
    }
    return pool.send(sessionPath, cmd);
  });

  ipcMain.handle(IPC.OmpAcquire, async (_e, sessionPath: string, cwd: string, approvalMode?: ApprovalMode) => {
    if (!pool) throw new Error('pool not initialized');
    // 钩子是全局的，续接/恢复的历史会话也一并加载（读取持久化配置，解析出 --hook 参数）。
    const hooks = resolveHookArgs(loadWorkspacesFile().hooks);
    await pool.acquire(sessionPath, cwd, approvalMode ?? 'write', hooks);
  });

  ipcMain.handle(IPC.OmpNewSession, async (_e, cwd: string, approvalMode?: ApprovalMode) => {
    if (!pool) throw new Error('pool not initialized');
    // 新建会话：spawn 不带 -r/-c（新 .jsonl），用 tempKey 绑定。
    // 真实 path 在首条消息 agent_end 后落盘，renderer refreshSessions 时迁移 tempKey→realPath。
    const tempKey = '__new_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    // 读取持久化的系统提示词 + 钩子，注入到新会话。
    const wf = loadWorkspacesFile();
    const systemPrompt = wf.systemPrompt;
    const hooks = resolveHookArgs(wf.hooks);
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
  ipcMain.handle(IPC.SessionDelete, async (_e, p: string) => { deleteSession(p); });
  ipcMain.handle(IPC.SessionMessages, async (_e, p: string) => readSessionMessages(p));
  ipcMain.handle(IPC.SessionUserEntries, async (_e, p: string) => readUserEntries(p));

  ipcMain.handle(IPC.GetOmpInfo, async () => ({ path: ompPath, version: ompVersion || 'unknown' }));

  ipcMain.handle(IPC.OpenExternal, async (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
    else { const res = await shell.openPath(url); if (res) throw new Error(res); }
  });
  ipcMain.handle(IPC.ClipboardWriteText, async (_e, text: string) => { clipboard.writeText(String(text ?? '')); });
  ipcMain.handle(IPC.ShowItemInFolder, async (_e, fullPath: string) => {
    if (fullPath && fs.existsSync(fullPath)) shell.showItemInFolder(path.normalize(fullPath));
    else { const dir = path.dirname(fullPath || ''); const res = await shell.openPath(dir); if (res) throw new Error(res); }
  });
  ipcMain.handle(IPC.ShowSaveDialog, async (_e, defaultPath?: string) => {
    if (!mainWindow) return null;
    const r = await dialog.showSaveDialog(mainWindow, { defaultPath: defaultPath ?? 'session.html', filters: [{ name: 'HTML', extensions: ['html'] }] });
    return r.canceled ? null : (r.filePath ?? null);
  });
  ipcMain.handle(IPC.ListFiles, async (_e, dirPath: string) => listDir(dirPath));

  // renderer 就绪（多进程下不再直接起 omp，仅标记；renderer 按需 acquire）
  ipcMain.handle(IPC.RendererReady, async () => { /* no-op: pool 按需 lazy acquire */ });

  // ---- 工作空间 ----
  ipcMain.handle(IPC.WorkspacesGet, async () => loadWorkspacesFile());
  ipcMain.handle(IPC.WorkspacesSave, async (_e, file: WorkspacesFile) => {
    if (!file || file.version !== 1) throw new Error('invalid workspaces file');
    saveWorkspacesFile(file);
  });
  ipcMain.handle(IPC.DialogOpenDir, async (_e, defaultPath?: string) => {
    if (!mainWindow) return null;
    const r = await dialog.showOpenDialog(mainWindow, { title: '选择工作目录', properties: ['openDirectory'], defaultPath: defaultPath || undefined });
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  });

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
    return paths.map((p) => parseHookFile(p));
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
      const content = fs.readFileSync(filePath, 'utf8');
      return { content };
    } catch (e: any) {
      return { content: '', error: String(e?.message ?? e) };
    }
  });
  ipcMain.handle(IPC.OmpSyncCustomCss, async (_e, list: CustomCssConfig[]) => {
    if (!Array.isArray(list)) return { error: 'invalid list' };
    return syncCustomCss(list);
  });

  // ---- 模型配置 ----
  ipcMain.handle(IPC.OmpModelsRead, async () => readModelsConfig());
  ipcMain.handle(IPC.OmpModelsWriteProvider, async (_e, id: string, cfg: OmpProviderConfig) => { writeProvider(id, cfg); });
  ipcMain.handle(IPC.OmpModelsDeleteProvider, async (_e, id: string) => { deleteProvider(id); });

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
  if (!USE_CUSTOM_TITLE_BAR) buildAppMenu();

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

function buildAppMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? ([{ role: 'appMenu' }] as MenuItemConstructorOptions[]) : []),
    { label: 'File', submenu: [isMac ? { role: 'close' } : { role: 'quit' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
    { role: 'help', label: 'Help', submenu: [{ label: '关于 OMP UI', click: () => showAboutDialog() }] },
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

function listDir(dirPath: string): FileEntry[] {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const result: FileEntry[] = [];
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.gitignore') continue;
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(dirPath, e.name);
      try {
        const stat = fs.statSync(full);
        result.push({ name: e.name, path: full, isDir: stat.isDirectory(), size: stat.isFile() ? stat.size : undefined, mtime: stat.mtimeMs });
      } catch { /* skip */ }
    }
    result.sort((a, b) => { if (a.isDir !== b.isDir) return a.isDir ? -1 : 1; return a.name.localeCompare(b.name); });
    return result;
  } catch { return []; }
}

// ---- 钩子（Hooks）静态解析 + 参数解析 ----

/** 静态解析一个 .ts 钩子文件：默认导出 / 具名导出 / pi.on 事件名。不执行代码。 */
function parseHookFile(filePath: string): HookFileInfo {
  const base: HookFileInfo = { path: filePath, hasDefault: false, namedHooks: [], events: [] };
  try {
    const src = fs.readFileSync(filePath, 'utf8');
    // 去掉块注释与行注释，避免误匹配（保留换行以不影响后续按行匹配）
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])(\/\/.*)$/gm, '$1');
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
    while ((m = evtRe.exec(noComments))) events.add(m[1]);
    base.events = [...events];
  } catch (e) {
    base.error = e instanceof Error ? e.message : String(e);
  }
  return base;
}

/** 把持久化的钩子配置解析成 omp 启动参数 `--hook=<path>` 列表。
 *  - 整文件默认导出（fileLevel）→ 直接传原文件。
 *  - 多单元（具名导出）→ 生成过滤包装文件（只调用启用的单元），传包装文件。
 *  包装文件写到 userData/hook-cache，每次解析时覆盖。 */
function resolveHookArgs(hooks?: HookFileConfig[]): string[] {
  if (!hooks || hooks.length === 0) return [];
  const args: string[] = [];
  const cacheDir = path.join(app.getPath('userData'), 'hook-cache');
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch { /* noop */ }
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
    // 文件名用路径 hash，稳定且避免特殊字符
    let h = 0;
    for (let i = 0; i < cfg.path.length; i++) h = (h * 31 + cfg.path.charCodeAt(i)) | 0;
    const outPath = path.join(cacheDir, `${Math.abs(h).toString(36)}.ts`);
    try {
      fs.writeFileSync(outPath, wrapper, 'utf8');
      args.push(outPath);
    } catch { /* 写失败则跳过该文件 */ }
  }
  return args;
}
