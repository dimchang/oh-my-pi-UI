import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useApp, type ChatMessage } from '../store';
import { ToolCard } from './ToolCard';

/** 正文里 markdown 代码块默认折叠（超过 ~6 行时收起） */
const CollapsibleCodeBlock: React.FC<{ children: React.ReactNode; node?: unknown }> = ({ children }) => {
  const [expanded, setExpanded] = useState(false);
  const [needsCollapse, setNeedsCollapse] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const el = preRef.current;
    if (!el) return;
    // 150px ≈ 120px max-height + padding；超出则显示折叠按钮
    setNeedsCollapse(el.scrollHeight > 150);
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

const MessageItem: React.FC<{ msg: ChatMessage }> = ({ msg }) => {
  return (
    <div className={`message ${msg.role}`} style={msg.error ? { borderLeft: '2px solid var(--red)', paddingLeft: 10 } : undefined}>
      <div className={`msg-role ${msg.role}`} style={msg.error ? { color: 'var(--red)' } : undefined}>
        {msg.role === 'user' ? '你' : 'Codex'}{msg.error ? ' · 出错' : ''}
      </div>
      <div className="msg-body">
        {msg.parts.map((p, i) => {
          if (p.kind === 'text') {
            return (
              <ReactMarkdown
                key={i}
                remarkPlugins={[remarkGfm]}
                components={{
                  pre: ({ children, ...props }) => (
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
              <details key={i} className="thinking">
                <summary>思考过程</summary>
                <div className="thinking-body">{p.text}</div>
              </details>
            );
          }
          if (p.kind === 'tool') {
            return <ToolCard key={p.toolCallId ?? i} tool={p} />;
          }
          return null;
        })}
        {msg.streaming && <span style={{ color: 'var(--text-faint)' }}>▍</span>}
      </div>
      {msg.usage?.totalTokens !== undefined && (
        <div className="msg-usage">
          {msg.usage.totalTokens} tokens{msg.usage.duration ? ` · ${(msg.usage.duration / 1000).toFixed(1)}s` : ''}
        </div>
      )}
    </div>
  );
};

export const ChatView: React.FC = () => {
  const messages = useApp((s) => s.messages);
  const isCompacting = useApp((s) => s.isCompacting);
  const compactionInfo = useApp((s) => s.compactionInfo);
  const isRetrying = useApp((s) => s.isRetrying);
  const retryInfo = useApp((s) => s.retryInfo);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, isCompacting, isRetrying]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  return (
    <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
      <div className="chat-inner">
        {messages.length === 0 && !isCompacting && !isRetrying ? (
          <div className="chat-empty">
            <h2>有什么可以帮你的？</h2>
            <p>输入任务，Codex 会读写文件、跑命令来完成。</p>
          </div>
        ) : (
          messages.map((m) => <MessageItem key={m.id} msg={m} />)
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
  );
};
