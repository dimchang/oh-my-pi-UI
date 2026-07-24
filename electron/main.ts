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
import { fileURLToPath } from 'url';

app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
import { OmpProcessPool } from './omp-pool';
import { listSessions, deleteSession, readSessionMessages, readUserEntries } from '../src/main/session-store';
import { readModelsConfig, writeProvider, deleteProvider } from './omp-config';
import { IPC } from '../src/shared/ipc-channels';
import type { FileEntry, WorkspacesFile, ApprovalMode, OmpProviderConfig } from '../src/shared/ipc-channels';
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

function registerIpc(): void {
  // ---- 多进程 RPC 路由 ----
  ipcMain.handle(IPC.RpcSend, async (_e, sessionPath: string, cmd: RpcCommand) => {
    if (!pool) throw new Error('pool not initialized');
    // extension_ui_response 无需等待 response（应答帧），直接 write
    if (cmd.type === 'extension_ui_response') {
      pool.write(sessionPath, cmd as ExtensionUIResponseCommand);
      return { type: 'response', command: 'extension_ui_response', success: true };
    }
    return pool.send(sessionPath, cmd);
  });

  ipcMain.handle(IPC.OmpAcquire, async (_e, sessionPath: string, cwd: string, approvalMode?: ApprovalMode) => {
    if (!pool) throw new Error('pool not initialized');
    await pool.acquire(sessionPath, cwd, approvalMode ?? 'write');
  });

  ipcMain.handle(IPC.OmpNewSession, async (_e, cwd: string, approvalMode?: ApprovalMode) => {
    if (!pool) throw new Error('pool not initialized');
    // 新建会话：spawn 不带 -r/-c（新 .jsonl），用 tempKey 绑定。
    // 真实 path 在首条消息 agent_end 后落盘，renderer refreshSessions 时迁移 tempKey→realPath。
    const tempKey = '__new_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    await pool.acquireNew(tempKey, cwd, approvalMode ?? 'write');
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
    onFrame: (sessionPath, frame) => sendToRenderer(IPC.RpcEvent, { ...(frame as object), __sessionPath: sessionPath }),
    onReady: (sessionPath) => sendToRenderer(IPC.RpcReady, sessionPath),
    onExit: (sessionPath, code) => sendToRenderer(IPC.OmpExit, { sessionPath, code }),
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
