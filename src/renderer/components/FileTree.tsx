import React, { useEffect, useState, useCallback } from 'react';
import type { FileEntry } from '../../shared/ipc-channels';

function formatSize(bytes?: number): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const FileTree: React.FC<{ cwd: string }> = ({ cwd }) => {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');

  const load = useCallback((dir: string) => {
    void window.omp.listFiles(dir).then((list) => {
      setEntries(list);
      setError('');
    }).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (cwd) load(cwd);
  }, [cwd, load]);

  const toggle = useCallback(async (entry: FileEntry) => {
    if (!entry.isDir) return;
    const key = entry.path;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const renderEntry = (entry: FileEntry, depth: number): React.ReactElement => {
    const isOpen = expanded.has(entry.path);
    const icon = entry.isDir ? (isOpen ? '📂' : '📁') : '📄';
    return (
      <div key={entry.path}>
        <div
          className="ft-item"
          style={{ paddingLeft: 12 + depth * 16 }}
          onClick={() => toggle(entry)}
          title={entry.path}
        >
          <span className="ft-icon">{icon}</span>
          <span className="ft-name">{entry.name}</span>
          {!entry.isDir && <span className="ft-size">{formatSize(entry.size)}</span>}
        </div>
        {entry.isDir && isOpen && (
          <DirChildren dir={entry.path} depth={depth + 1} />
        )}
      </div>
    );
  };

  const DirChildren: React.FC<{ dir: string; depth: number }> = ({ dir, depth }) => {
    const [kids, setKids] = useState<FileEntry[]>([]);
    useEffect(() => {
      void window.omp.listFiles(dir).then(setKids).catch(() => undefined);
    }, [dir]);
    return <>{kids.map((e) => renderEntry(e, depth))}</>;
  };

  return (
    <div className="file-tree">
      <div className="panel-header">
        <span>文件</span>
        <button className="btn" onClick={() => load(cwd)} title="刷新">↻</button>
      </div>
      {error ? (
        <div className="panel-empty">{error}</div>
      ) : entries.length === 0 ? (
        <div className="panel-empty">空目录</div>
      ) : (
        <div className="ft-list">
          {entries.map((e) => renderEntry(e, 1))}
        </div>
      )}
    </div>
  );
};
