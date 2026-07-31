import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useApp, type ChatMessage } from '../store';
import { ToolCard } from './ToolCard';
import { Icon } from './Icon';
import { Minimap } from './Minimap';

/** 正文里 markdown 代码块默认折叠（超过 ~6 行时收起） */
const CollapsibleCodeBlock: React.FC<{ children: React.ReactNode; node?: unknown }> = ({ children, node: _node }) => {
  const [expanded, setExpanded] = useState(false);
  const [needsCollapse, setNeedsCollapse] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  useLayoutEffect(() => {
    const el = preRef.current;
    if (!el) return;
    // 150px ≈ 120px max-height + padding；超出则显示折叠按钮。
    // 用函数式更新并与当前值比较，避免 children 每次渲染都是新引用导致的重渲染循环（issue 14）
    const shouldCollapse = el.scrollHeight > 150;
    setNeedsCollapse((prev) => (prev === shouldCollapse ? prev : shouldCollapse));
  }, [children]);

  return (
    <div className="collapsible-pre-wrap">
      <pre
        ref={preRef}
        style={needsCollapse && !expanded ? { maxHeight: 120, overflow: 'hidden' } : undefined}
      >
        {children}
      </pre>
      {needsCollapse && (
        <button
          className="collapsible-pre-toggle"
          onClick={(e) => { e.preventDefault(); setExpanded((v) => !v); }}
          type="button"
        >
          {expanded ? '收起 ▲' : '展开 ▼'}
        </button>
      )}
    </div>
  );
};

/** 判断一段文本是否像是原始文件/代码内容（而非普通 markdown 正文）。
 *  用于把模型直接贴出的文件内容（如 JSDoc 注释、源码、grep 结果）按 <pre> 渲染，
 *  避免 `*` 行被解释成 markdown 列表、同时启用默认折叠。 */
function looksLikeFileContent(text: string): boolean {
  if (text.includes('```')) return false; // 已有代码围栏，交给 markdown 处理
  const lines = text.split('\n');
  if (lines.length < 3) return false;
  const nonEmpty = lines.filter((l) => l.trim() !== '');
  if (nonEmpty.length < 2) return false;
  const first = nonEmpty[0]!.trim();
  // 常见源码/注释开头
  if (/^(\/\*\*?|\/\/|#|import\b|export\b|function\b|class\b|const\b|let\b|var\b|package\b|using\b|module\b|<\?xml|^[\[\{])/.test(first)) {
    return true;
  }
  // grep / glob 结果行：path[:line:content] 或纯路径
  if (/^[\w.\-\/\\\\]+(:\d+:)?.+/.test(first)) {
    const pathLike = nonEmpty.filter((l) => /^[\w.\-\/\\\\]+(:\d+:)?.+/.test(l.trim()));
    if (pathLike.length / nonEmpty.length > 0.7) return true;
  }
  return false;
}

const MessageItem = React.memo(function MessageItem({ msg }: { msg: ChatMessage }) {
  return (
      <div
        className={`message ${msg.role}${msg.steered ? ' steered' : ''}${msg.queued ? ' queued' : ''}`}
        data-msg-id={msg.id}
        style={msg.error ? { borderLeft: '2px solid var(--red)', paddingLeft: 10 } : undefined}
      >
      <div className={`msg-role ${msg.role}`} style={msg.error ? { color: 'var(--red)' } : undefined}>
        {msg.steered ? (<><Icon name="guide" size={12} /> 引导 (mid-run)</>) : msg.queued ? (<><Icon name="queue" size={12} /> 排队</>) : (msg.role === 'user' ? '你' : 'MyPi')}{msg.error ? ' · 出错' : ''}
      </div>
      <div className="msg-body">
        {msg.parts.map((p, i) => {
          if (p.kind === 'text') {
            // 若文本像是直接贴出的文件/代码内容，按代码块渲染并默认折叠，
            // 避免 JSDoc `*`、路径列表等被 markdown 错误解析。
            if (looksLikeFileContent(p.text)) {
              return (
                <CollapsibleCodeBlock key={`text-${i}`}>
                  <code>{p.text}</code>
                </CollapsibleCodeBlock>
              );
            }
            return (
              <ReactMarkdown
                key={`text-${i}`}
                remarkPlugins={[remarkGfm]}
                components={{
                  pre: ({ node: _node, children, ...props }) => (
                    <CollapsibleCodeBlock key={i} {...props}>{children}</CollapsibleCodeBlock>
                  ),
                }}
              >
                {p.text}
              </ReactMarkdown>
            );
          }
          if (p.kind === 'thinking') {
            return (
              <details key={`thinking-${i}`} className="thinking">
                <summary>思考过程</summary>
                <div className="thinking-body">{p.text}</div>
              </details>
            );
          }
          if (p.kind === 'tool') {
            return <ToolCard key={`tool-${p.toolCallId}`} tool={p} />;
          }
          return null;
        })}
        {msg.streaming && <span style={{ color: 'var(--text-faint)' }}>▍</span>}
      </div>
      {msg.role === 'user' && msg.attachments && msg.attachments.length > 0 && (
        <div className="msg-attachments">
          {msg.attachments.map((a) => (
            <button
              type="button"
              className="msg-attachment-chip"
              key={a.path}
              title={a.path}
              onClick={() => { void window.omp.showItemInFolder(a.path).catch(() => undefined); }}
            >
              <Icon name="file" size={13} />
              <span>{a.name}</span>
            </button>
          ))}
        </div>
      )}
      {msg.usage?.totalTokens !== undefined && (
        <div className="msg-usage">
          {msg.usage.totalTokens} tokens{msg.usage.duration ? ` · ${(msg.usage.duration / 1000).toFixed(1)}s` : ''}
        </div>
      )}
    </div>
  );
});

/** 虚拟化窗口：初始只渲染最后 N 条消息，滚动到顶部时加载更多。
 *  避免数百条消息（每条含多个 ToolCard）一次性渲染导致 DOM 爆炸。 */
const INITIAL_WINDOW = 80;
const LOAD_MORE_COUNT = 60;

export const ChatView: React.FC = () => {
  const messages = useApp((s) => s.messages);
  const isCompacting = useApp((s) => s.isCompacting);
  const compactionInfo = useApp((s) => s.compactionInfo);
  const isRetrying = useApp((s) => s.isRetrying);
  const retryInfo = useApp((s) => s.retryInfo);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);
  // 虚拟化：当前可见窗口大小（从末尾往前数）
  const [windowSize, setWindowSize] = useState(INITIAL_WINDOW);
  // 消息总数变化时重置窗口（切换会话）
  const prevLenRef = useRef(messages.length);
  if (messages.length < prevLenRef.current) {
    // 会话切换（消息数减少）→ 重置窗口
    setWindowSize(INITIAL_WINDOW);
  }
  prevLenRef.current = messages.length;

  const total = messages.length;
  const startIdx = Math.max(0, total - windowSize);
  const visible = messages.slice(startIdx);
  const hasMore = startIdx > 0;

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, isCompacting, isRetrying]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    // 滚动到顶部时加载更多历史消息
    if (el.scrollTop < 100 && hasMore) {
      const prevScrollHeight = el.scrollHeight;
      setWindowSize((w) => w + LOAD_MORE_COUNT);
      // 保持滚动位置（避免加载更多后跳到顶部）
      requestAnimationFrame(() => {
        const newEl = scrollRef.current;
        if (newEl) newEl.scrollTop = newEl.scrollHeight - prevScrollHeight;
      });
    }
  };

  return (
    <div className="chat-area">
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-inner">
          {total === 0 && !isCompacting && !isRetrying ? (
            <div className="chat-empty">
              <h2>有什么可以帮你的？</h2>
              <p>输入任务，MyPi 会读写文件、跑命令来完成。</p>
            </div>
          ) : (
            <>
              {hasMore && (
                <div className="chat-load-more" style={{ textAlign: 'center', padding: '8px 0', color: 'var(--text-faint)', fontSize: 12 }}>
                  ↑ 滚动加载更多（剩余 {startIdx} 条）
                </div>
              )}
              {visible.map((m) => <MessageItem key={m.id} msg={m} />)}
            </>
          )}
          {isCompacting && (
            <div className="status-bubble compacting">
              <span className="status-spinner" /> {compactionInfo || '压缩上下文中…'}
            </div>
          )}
          {isRetrying && (
            <div className="status-bubble retrying">
              <span className="status-spinner" /> {retryInfo || '重试中…'}
            </div>
          )}
        </div>
      </div>
      <Minimap scrollRef={scrollRef} />
    </div>
  );
};
