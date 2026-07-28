/**
 * SettingsContext — 全局上下文文件设置（~/.omp/agent/ 下的 AGENTS.md 和 RULES.md）。
 * 入口：设置面板 →「全局上下文」标签页。
 */

import React, { useEffect, useState, useCallback } from 'react';
import { Icon } from './Icon';

interface GlobalSlot {
  key: string;
  label: string;
  fileName: string;
  description: string;
  timing: string;
}

const GLOBAL_SLOTS: GlobalSlot[] = [
  {
    key: 'agents',
    label: 'AGENTS.md',
    fileName: 'AGENTS.md',
    description: '全局笔记 — 跨项目的通用约定、偏好、工作流说明。注入到每个项目的系统提示词中。',
    timing: '新会话开始时生效',
  },
  {
    key: 'rules',
    label: 'RULES.md',
    fileName: 'RULES.md',
    description: '全局粘性规则 — 全文注入每轮请求。适合语言偏好、回复格式等需持续生效的规则。',
    timing: '新会话开始时生效（已运行的会话需新建或重启）',
  },
];

/** 获取全局 agent 目录路径（从主进程 getOmpInfo 获取） */

export const SettingsContext: React.FC = () => {
  const [activeSlot, setActiveSlot] = useState<GlobalSlot>(GLOBAL_SLOTS[0]!);
  const [contents, setContents] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [agentDir, setAgentDir] = useState('');

  // 从主进程获取全局 agent 目录
  useEffect(() => {
    void window.omp.getOmpInfo().then((info) => {
      const dir = (info as { agentDir?: string }).agentDir;
      if (dir) setAgentDir(dir.replace(/\\/g, '/'));
    }).catch(() => undefined);
  }, []);

  // 加载文件
  useEffect(() => {
    if (!agentDir) return;
    let cancelled = false;
    void Promise.all(
      GLOBAL_SLOTS.map((s) => window.omp.readContextFile(`${agentDir}/${s.fileName}`)),
    ).then((results) => {
      if (cancelled) return;
      const map: Record<string, string> = {};
      GLOBAL_SLOTS.forEach((s, i) => { map[s.key] = results[i] ?? ''; });
      setContents(map);
      setDraft(map[activeSlot.key] ?? '');
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [agentDir]);

  const switchSlot = useCallback((slot: GlobalSlot) => {
    setActiveSlot(slot);
    setDraft(contents[slot.key] ?? '');
  }, [contents]);

  const handleSave = async () => {
    if (!agentDir) return;
    setSaving(true);
    try {
      await window.omp.writeContextFile(`${agentDir}/${activeSlot.fileName}`, draft);
      setContents((prev) => ({ ...prev, [activeSlot.key]: draft }));
    } catch (e) {
      console.error('保存失败', e);
    } finally {
      setSaving(false);
    }
  };

  const dirty = draft !== (contents[activeSlot.key] ?? '');

  if (!agentDir) {
    return <div className="settings-section"><p style={{ opacity: 0.6 }}>正在定位全局配置目录…</p></div>;
  }

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">全局上下文文件</h3>
      <p className="settings-section-desc">
        这些文件位于 <code>{agentDir}/</code>，对所有项目生效。
        项目级配置请右键工作空间 →「项目设置」。
      </p>

      <div className="ctx-tabs">
        {GLOBAL_SLOTS.map((s) => (
          <button
            key={s.key}
            className={`ctx-tab ${activeSlot.key === s.key ? 'active' : ''}`}
            onClick={() => switchSlot(s)}
          >
            {s.label}
            {contents[s.key]?.trim() && <span className="ctx-tab-dot" title="已配置" />}
          </button>
        ))}
      </div>

      <div className="ctx-file-info">
        <div className="ctx-file-desc">{activeSlot.description}</div>
        <div className="ctx-file-timing">
          <Icon name="clock" size={12} />
          <span>{activeSlot.timing}</span>
        </div>
      </div>

      <textarea
        className="ctx-editor"
        value={loaded ? draft : '加载中…'}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={`在此编辑全局 ${activeSlot.label} 内容…\n留空保存 = 删除该文件`}
        spellCheck={false}
        rows={12}
      />

      <div className="ctx-footer">
        <span className="ctx-hint">
          保存后需新建会话或重启当前会话进程才能生效
        </span>
        <button className="btn btn-primary" disabled={!dirty || saving} onClick={handleSave}>
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  );
};
