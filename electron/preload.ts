/**
 * preload.ts — contextBridge 暴露 window.omp 给渲染进程。
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type OmpApi, type FileEntry, type PickedFile, type WorkspacesFile, type ApprovalMode, type OmpProviderConfig, type CustomCssConfig } from '../src/shared/ipc-channels';
import type { OmpFrame, RpcCommand } from '../src/shared/rpc-types';

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: OmpApi = {
  platform: process.platform,
  send: <T = unknown>(sessionPath: string, cmd: RpcCommand): Promise<T> =>
    ipcRenderer.invoke(IPC.RpcSend, sessionPath, cmd),
  acquire: (sessionPath: string, cwd: string, approvalMode?: ApprovalMode) =>
    ipcRenderer.invoke(IPC.OmpAcquire, sessionPath, cwd, approvalMode),
  newSessionForCwd: (cwd: string, approvalMode?: ApprovalMode) =>
    ipcRenderer.invoke(IPC.OmpNewSession, cwd, approvalMode),
  release: (sessionPath: string) => ipcRenderer.invoke(IPC.OmpRelease, sessionPath),
  renameKey: (oldKey: string, newKey: string) => ipcRenderer.invoke(IPC.OmpRenameKey, oldKey, newKey),
  listSessions: (cwd?: string) => ipcRenderer.invoke(IPC.SessionList, cwd),
  deleteSession: (p: string) => ipcRenderer.invoke(IPC.SessionDelete, p),
  readSessionMessages: (p: string) => ipcRenderer.invoke(IPC.SessionMessages, p),
  getSessionUserEntries: (p: string) => ipcRenderer.invoke(IPC.SessionUserEntries, p),
  getOmpInfo: () => ipcRenderer.invoke(IPC.GetOmpInfo),
  openExternal: (url: string) => ipcRenderer.invoke(IPC.OpenExternal, url),
  copyText: (text: string) => ipcRenderer.invoke(IPC.ClipboardWriteText, text),
  showItemInFolder: (fullPath: string) => ipcRenderer.invoke(IPC.ShowItemInFolder, fullPath),
  showSaveDialog: (defaultPath?: string) => ipcRenderer.invoke(IPC.ShowSaveDialog, defaultPath),
  listFiles: (dirPath: string) => ipcRenderer.invoke(IPC.ListFiles, dirPath),
  onEvent: (cb) => subscribe<OmpFrame & { __sessionPath?: string }>(IPC.RpcEvent, cb),
  onReady: (cb) => subscribe<string>(IPC.RpcReady, cb),
  onExit: (cb) => subscribe<{ sessionPath: string; code: number | null }>(IPC.OmpExit, cb),
  onStderr: (cb) => subscribe<{ sessionPath: string; line: string }>(IPC.OmpStderr, cb),
  onNotFound: (cb) => subscribe<string>(IPC.OmpNotFound, cb),
  // issue 85: RendererReady handler 为无参 no-op（pool 按需 lazy acquire），不再传死参 initialCwd
  notifyReady: () => ipcRenderer.invoke(IPC.RendererReady),

  // M5: 工作空间
  getWorkspaces: () => ipcRenderer.invoke(IPC.WorkspacesGet),
  saveWorkspaces: (file: WorkspacesFile) => ipcRenderer.invoke(IPC.WorkspacesSave, file),
  openDirDialog: (defaultPath?: string) => ipcRenderer.invoke(IPC.DialogOpenDir, defaultPath),
  pickFiles: (defaultPath?: string) => ipcRenderer.invoke(IPC.DialogOpenFiles, defaultPath),

  // 模型配置：读写 omp 原生 ~/.omp/agent/models.yml
  readModelsConfig: () => ipcRenderer.invoke(IPC.OmpModelsRead),
  writeOmpProvider: (id: string, cfg: OmpProviderConfig) =>
    ipcRenderer.invoke(IPC.OmpModelsWriteProvider, id, cfg),
  deleteOmpProvider: (id: string) => ipcRenderer.invoke(IPC.OmpModelsDeleteProvider, id),

  // 技能（Skills）管理
  skillsList: () => ipcRenderer.invoke(IPC.SkillsList),
  skillsDetail: (name: string) => ipcRenderer.invoke(IPC.SkillsDetail, name),
  skillsSetEnabled: (name: string, enabled: boolean) =>
    ipcRenderer.invoke(IPC.SkillsSetEnabled, name, enabled),
  skillsUninstall: (name: string) => ipcRenderer.invoke(IPC.SkillsUninstall, name),

  // 自定义标题栏窗口控制（Windows frameless 模式）
  minimizeWindow: () => ipcRenderer.invoke(IPC.WindowMinimize),
  maximizeWindow: () => ipcRenderer.invoke(IPC.WindowMaximize),
  closeWindow: () => ipcRenderer.invoke(IPC.WindowClose),
  isWindowMaximized: () => ipcRenderer.invoke(IPC.WindowIsMaximized),
  onWindowMaximizedChange: (cb) => subscribe<boolean>(IPC.WindowMaximizedChange, cb),

  // 自定义标题栏菜单动作
  menuReload: () => ipcRenderer.invoke(IPC.MenuReload),
  menuForceReload: () => ipcRenderer.invoke(IPC.MenuForceReload),
  menuToggleDevTools: () => ipcRenderer.invoke(IPC.MenuToggleDevTools),
  menuResetZoom: () => ipcRenderer.invoke(IPC.MenuResetZoom),
  menuZoomIn: () => ipcRenderer.invoke(IPC.MenuZoomIn),
  menuZoomOut: () => ipcRenderer.invoke(IPC.MenuZoomOut),
  menuToggleFullscreen: () => ipcRenderer.invoke(IPC.MenuToggleFullscreen),
  menuShowAbout: () => ipcRenderer.invoke(IPC.MenuShowAbout),
  menuStats: () => ipcRenderer.invoke(IPC.MenuStatsClick),
  onMenuStats: (cb) => subscribe<void>(IPC.MenuStats, cb),

  // 钩子（Hooks）管理
  pickHookFiles: () => ipcRenderer.invoke(IPC.OmpPickHookFiles),
  parseHookFiles: (paths: string[]) => ipcRenderer.invoke(IPC.OmpParseHookFiles, paths),

  // 自定义 CSS 导入
  pickCssFile: () => ipcRenderer.invoke(IPC.OmpPickCssFile),
  readCssFile: (path: string) => ipcRenderer.invoke(IPC.OmpReadCssFile, path),
  syncCustomCss: (list: CustomCssConfig[]) => ipcRenderer.invoke(IPC.OmpSyncCustomCss, list),

  // 上下文文件读写
  readContextFile: (filePath: string) => ipcRenderer.invoke(IPC.ContextFileRead, filePath),
  writeContextFile: (filePath: string, content: string) => ipcRenderer.invoke(IPC.ContextFileWrite, filePath, content),

  // 图片：粘贴/拖拽落盘 + 读取为 data URL
  savePastedImage: (data: ArrayBuffer, ext: string) =>
    ipcRenderer.invoke(IPC.SavePastedImage, data, ext),
  readImageAsDataUrl: (filePath: string) =>
    ipcRenderer.invoke(IPC.ReadImageAsDataUrl, filePath),
};

contextBridge.exposeInMainWorld('omp', api);
