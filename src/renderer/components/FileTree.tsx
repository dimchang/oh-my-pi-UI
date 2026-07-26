import React, { useEffect, useState, useCallback } from 'react';
import type { FileEntry } from '../../shared/ipc-channels';

function formatSize(bytes?: number): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 递归节点组件（模块顶层，稳定类型引用）。
 * 之前 DirChildren 定义在 FileTree 函数体内，每次 FileTree 重渲染都会生成新的函数引用，
 * React 按组件类型比对会把它当成"新类型"，整体卸载重建其子树——已展开目录的 kids 状态
 * 丢失、重新 listFiles 拉取。提到顶层后，父级重渲染不再触发展开目录的重建。
 * expanded / onToggle 通过 props 传入，数据变化时正常重渲染但不卸载。
 */
const EntryNode: React.FC<{
  entry: FileEntry;
  depth: number;
  expanded: Set<string>;
  version: number;
  onToggle: (entry: FileEntry) => void;
}> = ({ entry, depth, expanded, version, onToggle }) => {
  const isOpen = expanded.has(entry.path);
  const icon = entry.isDir ? (isOpen ? '📂' : '📁') : '📄';
  return (
    <div key={entry.path}>
      <div
        className="ft-item"
        style={{ paddingLeft: 12 + depth * 16 }}
        onClick={() => onToggle(entry)}
        title={entry.path}
      >
        <span className="ft-icon">{icon}</span>
        <span className="ft-name">{entry.name}</span>
        {!entry.isDir && <span className="ft-size">{formatSize(entry.size)}</span>}
      </div>
      {entry.isDir && isOpen && (
        <DirChildren dir={entry.path} depth={depth + 1} expanded={expanded} version={version} onToggle={onToggle} />
      )}
    </div>
  );
};

const DirChildren: React.FC<{
  dir: string;
  depth: number;
  expanded: Set<string>;
  version: number;
  onToggle: (entry: FileEntry) => void;
}> = ({ dir, depth, expanded, version, onToggle }) => {
  const [kids, setKids] = useState<FileEntry[]>([]);
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    void window.omp.listFiles(dir).then((list) => {
      if (alive) { setKids(list); setErr(''); }
    }).catch((e) => {
      if (alive) { setKids([]); setErr(e instanceof Error ? e.message : String(e)); }
    });
    return () => {
      alive = false;
    };
    // version 变化（父级刷新）时重新拉取已展开子目录
  }, [dir, version]);
  if (err) {
    return <div className="panel-empty" style={{ paddingLeft: 12 + depth * 16 }}>{err}</div>;
  }
  return <>{kids.map((e) => <EntryNode key={e.path} entry={e} depth={depth} expanded={expanded} version={version} onToggle={onToggle} />)}</>;
};

export const FileTree: React.FC<{ cwd: string }> = ({ cwd }) => {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  /** 刷新版本号：每次刷新 +1，传给 DirChildren 作为 effect 依赖，强制已展开子目录重新拉取 */
  const [version, setVersion] = useState(0);

  const load = useCallback((dir: string) => {
    void window.omp.listFiles(dir).then((list) => {
      setEntries(list);
      setError('');
    }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    if (cwd) load(cwd);
  }, [cwd, load]);

  const toggle = useCallback((entry: FileEntry) => {
    if (!entry.isDir) return;
    const key = entry.path;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const refresh = useCallback(() => {
    if (!cwd) return;
    load(cwd);
    setVersion((v) => v + 1); // 让已展开子目录也重新拉取
  }, [cwd, load]);

  return (
    <div className="file-tree">
      <div className="panel-header">
        <span>文件</span>
        <button className="btn" onClick={refresh} title="刷新">↻</button>
      </div>
      {error ? (
        <div className="panel-empty">{error}</div>
      ) : entries.length === 0 ? (
        <div className="panel-empty">空目录</div>
      ) : (
        <div className="ft-list">
          {entries.map((e) => <EntryNode key={e.path} entry={e} depth={1} expanded={expanded} version={version} onToggle={toggle} />)}
        </div>
      )}
    </div>
  );
};
