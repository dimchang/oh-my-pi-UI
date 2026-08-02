import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, isImageFile, type Attachment } from '../store';
import { rpc } from '../rpc-client';
import { ModelPicker } from './ModelPicker';
import { ThinkingPicker } from './ThinkingPicker';
import { PermissionPicker } from './PermissionPicker';
import { Icon } from './Icon';
import type { ApprovalMode } from '../../shared/ipc-channels';
import type { SlashCommand } from '../../shared/rpc-types';

/** 单条附件芯片：图片附件懒加载缩略图，文件附件走原 file 芯片。
 *  缩略图加载失败（文件被清理/无权限）自动回退为文件芯片，绝不白屏。 */
const AttachmentChip: React.FC<{
  att: Attachment;
  onRemove: (p: string) => void;
  onOpen: (p: string) => void;
}> = ({ att, onRemove, onOpen }) => {
  const [thumb, setThumb] = useState<string | null>(null);
  const [thumbErr, setThumbErr] = useState(false);
  const isImg = isImageFile(att.name);
  useEffect(() => {
    if (!isImg) return;
    let cancelled = false;
    window.omp.readImageAsDataUrl(att.path)
      .then((r) => { if (!cancelled) setThumb(r.dataUrl); })
      .catch(() => { if (!cancelled) setThumbErr(true); });
    return () => { cancelled = true; };
  }, [att.path, isImg]);

  if (isImg && thumb && !thumbErr) {
    return (
      <span className="attachment-chip attachment-chip-img" title={att.path}>
        <img className="attachment-thumb" src={thumb} alt={att.name} onClick={() => onOpen(att.path)} />
        <button type="button" className="attachment-remove" title="移除附件" onClick={() => onRemove(att.path)}>
          <Icon name="close" size={12} />
        </button>
      </span>
    );
  }
  return (
    <span className="attachment-chip" title={att.path}>
      <Icon name="file" size={13} />
      <span
        className="attachment-name"
        role="button"
        tabIndex={0}
        onClick={() => onOpen(att.path)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onOpen(att.path); }}
      >{att.name}</span>
      <button type="button" className="attachment-remove" title="移除附件" onClick={() => onRemove(att.path)}>
        <Icon name="close" size={12} />
      </button>
    </span>
  );
};

export const InputBox: React.FC<{
  onSend: (text: string, attachments?: Attachment[]) => void;
  onGuide: (text: string, attachments?: Attachment[]) => void;
  onQueue: (text: string, attachments?: Attachment[]) => void;
  onAbort: () => void;
  onChangeApprovalMode: (mode: ApprovalMode) => void;
}> = ({ onSend, onGuide, onQueue, onAbort, onChangeApprovalMode }) => {
  const [draft, setDraft] = useState('');
  const [selIdx, setSelIdx] = useState(0);
  const [focused, setFocused] = useState(false);
  const isStreaming = useApp((s) => s.isStreaming);
  const isAborting = useApp((s) => s.isAborting);
  const ready = useApp((s) => s.ready);
  const slashCommands = useApp((s) => s.slashCommands);
  const draftInput = useApp((s) => s.draftInput);
  const setDraftInput = useApp((s) => s.setDraftInput);
  // Enter 默认行为：'guide'（默认，mid-run 介入）/ 'queue'（等当前轮跑完）
  // Shift+Enter 自动取反
  const inputBehavior = useApp((s) => s.inputBehavior ?? 'guide');
  const cwd = useApp((s) => s.currentWorkspace()?.cwd ?? '');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // 拖拽高亮状态：dragDepth 计数器避免子元素触发 dragleave 导致高亮闪烁/误复位
  const dragDepthRef = useRef(0);
  const [isDragOver, setIsDragOver] = useState(false);
  // 提交防重复：onSend 把状态切到 streaming 有一帧延迟，期间按两次 Enter 会重复发送
  const submittingRef = useRef(false);

  // 一次性输入回填（分叉等场景）：draftInput 非空时填入 textarea 并立即消费
  useEffect(() => {
    if (draftInput !== undefined && draftInput !== '') {
      setDraft(draftInput);
      setDraftInput(''); // consume — 置空避免重复填入
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (ta) {
          ta.style.height = 'auto';
          ta.style.height = Math.min(ta.scrollHeight, 320) + 'px';
          ta.focus();
        }
      });
    }
  }, [draftInput, setDraftInput]);

  // 兜底：用户输入 / 但命令列表为空时，主动拉取一次（防止 onReady 时拉取失败导致永远无命令）
  const cmdFetchedRef = useRef(false);
  useEffect(() => {
    if (draft.startsWith('/') && slashCommands.length === 0 && !cmdFetchedRef.current) {
      cmdFetchedRef.current = true;
      const sp = useApp.getState().currentSessionPath;
      if (sp) {
        // 会话可能只是浏览（未拉起进程）：先按需拉起，再拉命令列表
        void useApp.getState().ensureOnline(sp).then((ok) => {
          if (!ok) return;
          void rpc.getAvailableCommands(sp).then((r) => {
            if (r.success && r.data) {
              const cmds = r.data.commands;
              if (Array.isArray(cmds) && cmds.length > 0) {
                useApp.getState().setState({ slashCommands: cmds as SlashCommand[] });
              }
            }
          }).catch(() => undefined);
        });
      }
      // 5秒后允许再次尝试（避免永久锁死）
      setTimeout(() => { cmdFetchedRef.current = false; }, 5000);
    }
  }, [draft, slashCommands]);

  const slashMatch = useMemo(() => {
    if (!focused) return null; // 失焦时关闭弹窗
    if (!draft.startsWith('/')) return null;
    const afterSlash = draft.slice(1);
    // 命令名后出现空格 → 用户正在输入参数，关闭弹窗让 Enter 正常提交
    if (/\s/.test(afterSlash)) return null;
    const q = afterSlash.toLowerCase();
    const list = slashCommands.filter(
      (c) => c.name.toLowerCase().startsWith(q) || c.aliases?.some((a) => a.toLowerCase().startsWith(q)),
    );
    return { q, list };
  }, [draft, slashCommands, focused]);

  const autoGrow = () => {
    const ta = taRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 320) + 'px';
    }
  };

  // 附件：从文件选择框添加（项目内或任意外部文件），按路径去重
  const onPickFiles = async () => {
    try {
      const picked = await window.omp.pickFiles(cwd || undefined);
      if (!picked || picked.length === 0) return;
      setAttachments((prev) => {
        const existing = new Set(prev.map((a) => a.path));
        const added = picked.filter((p) => !existing.has(p.path));
        return added.length ? [...prev, ...added] : prev;
      });
    } catch (err) {
      console.error('pickFiles 失败', err);
    }
  };

  const removeAttachment = (path: string) => {
    setAttachments((prev) => prev.filter((a) => a.path !== path));
  };

  // 打开附件：本地文件走 shell.showItemInFolder（在文件管理器中定位并高亮）
  const openAttachment = (path: string) => {
    void window.omp.showItemInFolder(path).catch((err) => console.error('openAttachment 失败', err));
  };

  // 把一张图片存盘并加入待发送附件（粘贴 / 拖拽共用）。渲染侧先做大小前置校验（避免大图白序列化跨进程）。
  const addImageAttachment = async (buf: ArrayBuffer, ext: string) => {
    try {
      const res = await window.omp.savePastedImage(buf, ext);
      if (res) {
        setAttachments((prev) =>
          prev.some((x) => x.path === res.path) ? prev : [...prev, { path: res.path, name: res.name, size: res.size, kind: 'image' }],
        );
      }
    } catch (err) {
      console.error('保存图片附件失败', err);
    }
  };

  // 粘贴：仅当剪贴板含 image/* 才拦截；纯文本粘贴完全不拦（防回归：文本复制/粘贴行为不变）
  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageItems = Array.from(items).filter((it) => it.type.startsWith('image/'));
    if (imageItems.length === 0) return;
    e.preventDefault(); // 同步拦截，避免图片被塞进文本框
    const MAX = 10 * 1024 * 1024;
    for (const item of imageItems) {
      const blob = item.getAsFile();
      if (!blob) continue;
      if (blob.size > MAX) { console.warn('粘贴的图片超过 10MB，已忽略'); continue; }
      const buf = await blob.arrayBuffer();
      const ext = (item.type.split('/')[1] || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
      await addImageAttachment(buf, ext);
    }
  };

  // 拖拽：仅对 Files 类型生效；onDragOver 必须 preventDefault 否则 drop 不触发
  const isFileDrag = (e: React.DragEvent) => !!e.dataTransfer?.types?.includes('Files');
  const onDragEnter = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOver(true);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    dragDepthRef.current -= 1;
    if (dragDepthRef.current <= 0) { dragDepthRef.current = 0; setIsDragOver(false); }
  };
  const onDrop = async (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOver(false);
    const MAX = 10 * 1024 * 1024;
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
    for (const f of files) {
      if (f.size > MAX) { console.warn('拖入的图片超过 10MB，已忽略'); continue; }
      const buf = await f.arrayBuffer();
      const ext = (f.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
      await addImageAttachment(buf, ext);
    }
  };

  /**
   * 提交并按用户设置选择模式：
   *   - draft 为空：按了也无效
   *   - 生成空闲：onSend（普通 prompt）
   *   - 生成中：按 `inputBehavior` 决定 onGuide（mid-run 介入）或 onQueue（等当前轮跑完）
   *   切 Shift+Enter 走相反模式
   */
  const submit = (modeOverride?: 'send' | 'guide' | 'queue') => {
    const text = draft.trim();
    if (!text || !ready || isAborting || submittingRef.current) return;
    let mode: 'send' | 'guide' | 'queue' | null = null;
    if (modeOverride) {
      mode = modeOverride;
    } else if (!isStreaming) {
      mode = 'send';
    } else {
      mode = inputBehavior;
    }
    submittingRef.current = true;
    setDraft('');
    setAttachments([]); // 清空待发送附件（已随消息一并发出）
    requestAnimationFrame(autoGrow);
    if (mode === 'guide') onGuide(text, attachments);
    else if (mode === 'queue') onQueue(text, attachments);
    else onSend(text, attachments);
    // 释放：等状态切到 streaming 或超时后允许再次发送（避免异常时永久锁死）
    setTimeout(() => { submittingRef.current = false; }, 500);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashMatch && slashMatch.list.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelIdx((i) => (i + 1) % slashMatch.list.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSelIdx((i) => (i - 1 + slashMatch.list.length) % slashMatch.list.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        const c = slashMatch.list[selIdx];
        if (c) {
          const takesArgs = !!(c.input?.hint || (c.subcommands && c.subcommands.length > 0));
          if (takesArgs) {
            // 需要参数的命令：补全名称 + 空格，让用户继续输入参数
            setDraft('/' + c.name + ' ');
          } else {
            // 无参数命令：补全后直接提交
            setDraft('');
            requestAnimationFrame(autoGrow);
            onSend('/' + c.name);
          }
        }
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // Enter = 默认行为（inputBehavior）；生成空闲时退化 onSend
      submit();
    } else if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      // Shift+Enter = 取反：inputBehavior='guide' → queue，'queue' → guide；空闲时退化 onSend
      const flipped = inputBehavior === 'guide' ? 'queue' : 'guide';
      if (!isStreaming) submit('send');
      else submit(flipped);
    } else if (e.key === 'Escape' && isStreaming) {
      onAbort();
    }
  };

  // placeholder 根据当前模式 + 设置变化
  //   引导 (guide) = steer mid-run：当前 tool 完成后立即按新方向继续（跳过剩余 tool 队列）
  //   排队 (queue) = follow_up：等当前 agent turn 跑完再处理，不打断当前 tool/t
  // 有附件也算有输入（即使正文为空也能发送）
  const hasInput = draft.trim() !== '' || attachments.length > 0;
  const placeholder = !ready
    ? '正在连接 omp…'
    : isStreaming
      ? (inputBehavior === 'guide'
          ? '正在生成…Enter 引导（mid-run：当前 tool 完成后立即按新方向继续），Shift+Enter 排队'
          : '正在生成…Enter 排队（等当前轮跑完再处理），Shift+Enter 引导')
      : '给 MyPi 派个任务…（/ 打开命令，Esc 中止）';

  return (
    <div className="input-area">
      <div className="input-inner">
        {slashMatch && slashMatch.list.length > 0 && (
          <div className="slash-popup">
            {slashMatch.list.map((c, i) => (
              <div
                key={c.name}
                className={`slash-item ${i === selIdx ? 'sel' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  const takesArgs = !!(c.input?.hint || (c.subcommands && c.subcommands.length > 0));
                  if (takesArgs) {
                    setDraft('/' + c.name + ' ');
                    taRef.current?.focus();
                  } else {
                    setDraft('');
                    requestAnimationFrame(autoGrow);
                    onSend('/' + c.name);
                  }
                }}
              >
                <span className="slash-name">/{c.name}</span>
                {c.input?.hint && <span className="slash-hint">{c.input.hint}</span>}
                <span className="slash-desc">{c.description ?? ''}</span>
              </div>
            ))}
          </div>
        )}
        <div
          className={`input-box${isDragOver ? ' drag-over' : ''}`}
          onDragEnter={onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          {attachments.length > 0 && (
            <div className="attachment-chips">
              {attachments.map((a) => (
                <AttachmentChip key={a.path} att={a} onRemove={removeAttachment} onOpen={openAttachment} />
              ))}
            </div>
          )}
          <textarea
            ref={taRef}
            rows={2}
            value={draft}
            placeholder={placeholder}
            onChange={(e) => { setDraft(e.target.value); setSelIdx(0); autoGrow(); }}
            onFocus={() => {
              setFocused(true);
              // 仅浏览会话时进程未拉起：聚焦输入框即表示要开始对话，按需懒拉起
              const sp = useApp.getState().currentSessionPath;
              if (sp) void useApp.getState().ensureOnline(sp);
            }}
            onBlur={() => setFocused(false)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          <div className="input-toolbar">
            <div className="input-toolbar-left">
              <button className="input-tool-btn icon-only" type="button" title="添加附件（项目内或任意外部文件）" onClick={onPickFiles}>
                <Icon name="attach" size={16} />
              </button>
              <PermissionPicker onChange={onChangeApprovalMode} />
            </div>
            <div className="input-toolbar-right">
              <ThinkingPicker />
              <ModelPicker />
              {/* 单按钮：
                  - draft 为空：灰色 STOP（onAbort，仅生成中可点）
                  - draft 有内容 + 生成中：按 inputBehavior 显示琥珀「引导」或灰色「排队」
                  - draft 有内容 + 空闲：蓝色 SEND */}
              {!hasInput ? (
                <button
                  className="stop-btn-round"
                  onClick={onAbort}
                  disabled={!isStreaming || isAborting}
                  title={isStreaming ? '停止当前轮' : '（无输入时此按钮用于停止正在生成的内容）'}
                >
                  <Icon name="stop" size={14} />
                </button>
              ) : isStreaming ? (
                inputBehavior === 'guide' ? (
                  <button
                    className="guide-btn-round"
                    onClick={() => submit('guide')}
                    disabled={!ready}
                    title="Enter 引导（mid-run）：当前 tool 完成后立即按新方向继续（omp 会跳过剩余 tool 队列）。Shift+Enter = 排队。"
                  >
                    <Icon name="guide" size={14} />
                  </button>
                ) : (
                  <button
                    className="queue-btn-round"
                    onClick={() => submit('queue')}
                    disabled={!ready}
                    title="Enter 排队：等当前 agent turn 跑完再处理，不打断当前 tool/t。Shift+Enter = 引导。"
                  >
                    <Icon name="queue" size={14} />
                  </button>
                )
              ) : (
                <button
                  className="send-btn-round"
                  onClick={() => submit('send')}
                  disabled={!ready}
                  title="发送"
                >
                  <Icon name="send" size={16} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
