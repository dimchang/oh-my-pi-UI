/**
 * ProjectSettingsModal — 项目级上下文配置弹窗。
 * 入口：侧栏工作空间右键菜单 →「项目设置」。
 * 管理当前工作空间 .omp/ 目录下的 SYSTEM.md / APPEND_SYSTEM.md / RULES.md。
 */

import React, { useEffect, useState, useCallback } from 'react';
import type { Workspace } from '../../shared/ipc-channels';
import { useApp } from '../store';
import { rpc } from '../rpc-client';
import { cwdKey } from '../utils/path-key';
import { Icon } from './Icon';

interface FileSlot {
  key: string;
  label: string;
  fileName: string;
  description: string;
  timing: string;
}

const SLOTS: FileSlot[] = [
  {
    key: 'system',
    label: 'SYSTEM.md',
    fileName: 'SYSTEM.md',
    description: '完全替换 omp 内置系统提示词。仅当你清楚要移除什么时使用。',
    timing: '新会话开始时生效',
  },
  {
    key: 'append',
    label: 'APPEND_SYSTEM.md',
    fileName: 'APPEND_SYSTEM.md',
    description: '追加到内置系统提示词之后，不替换原有内容。适合添加项目专属指令。',
    timing: '新会话开始时生效',
  },
  {
    key: 'rules',
    label: 'RULES.md',
    fileName: 'RULES.md',
    description: '粘性规则 — 全文注入每轮请求的系统提示词中。适合编码规范、语言偏好等需持续生效的规则。',
    timing: '新会话开始时生效（已运行的会话需新建或重启）',
  },
];

export const ProjectSettingsModal: React.FC<{
  ws: Workspace;
  onClose: () => void;
}> = ({ ws, onClose }) => {
  const [activeSlot, setActiveSlot] = useState<FileSlot>(SLOTS[0]!);
  const [contents, setContents] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const sep = ws.cwd.includes('\\') ? '\\' : '/';
  const dirPath = `${ws.cwd}${sep}.omp`;

  // 加载所有文件内容
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      SLOTS.map((s) => window.omp.readContextFile(`${dirPath}${sep}${s.fileName}`)),
    ).then((results) => {
      if (cancelled) return;
      const map: Record<string, string> = {};
      SLOTS.forEach((s, i) => { map[s.key] = results[i] ?? ''; });
      setContents(map);
      setDraft(map[activeSlot.key] ?? '');
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [dirPath]);

  // 切换 tab 时同步草稿
  const switchSlot = useCallback((slot: FileSlot) => {
    setActiveSlot(slot);
    setDraft(contents[slot.key] ?? '');
  }, [contents]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await window.omp.writeContextFile(`${dirPath}${sep}${activeSlot.fileName}`, draft);
      setContents((prev) => ({ ...prev, [activeSlot.key]: draft }));
      // 保存成功后释放该工作空间的所有在线进程，下次交互时重新 spawn（新进程会读取更新后的文件）
      const st = useApp.getState();
      const wsKey = cwdKey(ws.cwd);
      for (const s of st.sessions) {
        if (cwdKey(s.cwd) === wsKey) {
          const ps = st.procStateMap[s.path];
          if (ps?.status === 'online') {
            void rpc.release(s.path).then(() => {
              useApp.getState().setProcState(s.path, { status: 'offline' });
            }).catch(() => undefined);
          }
        }
      }
    } catch (e) {
      console.error('保存失败', e);
    } finally {
      setSaving(false);
    }
  };

  const dirty = draft !== (contents[activeSlot.key] ?? '');

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal project-settings-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="proj-settings-header">
          <div className="proj-settings-title">
            <Icon name="cog" size={16} />
            <span>项目设置</span>
            <span className="proj-settings-path" title={ws.cwd}>{ws.displayName}</span>
          </div>
          <button className="settings-close" title="关闭" onClick={onClose}>✕</button>
        </div>

        <div className="proj-settings-body">
          <div className="proj-settings-nav">
            {SLOTS.map((s) => (
              <button
                key={s.key}
                className={`proj-nav-item ${activeSlot.key === s.key ? 'active' : ''}`}
                onClick={() => switchSlot(s)}
              >
                {s.label}
                {contents[s.key]?.trim() && <span className="proj-nav-dot" title="已配置" />}
              </button>
            ))}
          </div>

          <div className="proj-settings-content">
            <div className="proj-file-info">
              <div className="proj-file-desc">{activeSlot.description}</div>
              <div className="proj-file-timing">
                <Icon name="clock" size={12} />
                <span>{activeSlot.timing}</span>
              </div>
              <div className="proj-file-path">{dirPath}{sep}{activeSlot.fileName}</div>
            </div>

            <textarea
              className="proj-editor"
              value={loaded ? draft : '加载中…'}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={`在此编辑 ${activeSlot.label} 内容…\n留空保存 = 删除该文件（恢复默认行为）`}
              spellCheck={false}
            />

            <div className="proj-settings-footer">
              <span className="proj-hint">
                保存后自动重启该工作空间的会话进程，下次发消息即生效
              </span>
              <button
                className="btn btn-primary"
                disabled={!dirty || saving}
                onClick={handleSave}
              >
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
