import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useApp, isImageFile, type ChatMessage } from '../store';
import { ToolCard } from './ToolCard';
import { Icon } from './Icon';
import { Minimap } from './Minimap';

/** 单条消息附件芯片：图片懒加载缩略图（进入视口才请求 data URL），文件走原芯片。
 *  缩略图加载失败（文件被清理/无权限）自动回退为文件芯片，绝不让整条消息渲染崩溃或白屏。 */
const MsgAttachmentChip: React.FC<{ att: { path: string; name: string; size?: number } }> = ({ att }) => {
  const isImg = isImageFile(att.name);
  const [thumb, setThumb] = useState<string | null>(null);
  const [thumbErr, setThumbErr] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const requestedRef = useRef(false);

  useEffect(() => {
    if (!isImg || requestedRef.current) return;
    const el = ref.current;
    if (!el) return;
    // 懒加载：进入视口才请求 data URL
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !requestedRef.current) {
        requestedRef.current = true;
        io.disconnect();
        window.omp.readImageAsDataUrl(att.path)
          .then((r) => setThumb(r.dataUrl))
          .catch(() => setThumbErr(true));
      }
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [att.path, isImg]);

  if (isImg && thumb && !thumbErr) {
    return (
      <button type="button" className="msg-attachment-chip msg-attachment-img" ref={ref} title={att.path}
        onClick={() => { void window.omp.showItemInFolder(att.path).catch(() => undefined); }}>
        <img src={thumb} alt={att.name} />
      </button>
    );
  }
  // 文件芯片（或图片尚未加载/失败回退）
  return (
    <button type="button" className="msg-attachment-chip" ref={ref} title={att.path}
      onClick={() => { void window.omp.showItemInFolder(att.path).catch(() => undefined); }}>
      <Icon name="file" size={13} />
      <span>{att.name}</span>
    </button>
  );
};

/** ReactMarkdown 的 remark 插件：提到模块作用域，稳定引用，避免每次渲染重建 AST。 */
const REMARK_PLUGINS = [remarkGfm];

/** 从 React children 中递归提取纯文本（用于 CollapsibleCodeBlock 的稳定依赖）。 */
function extractText(node: React.ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (React.isValidElement(node)) {
    return extractText((node.props as { children?: React.ReactNode }).children);
  }
  return '';
}

/** 正文里 markdown 代码块默认折叠（超过 ~6 行时收起） */
const CollapsibleCodeBlock: React.FC<{
  children: React.ReactNode;
  node?: unknown;
  /** 代码文本内容，用于稳定依赖检测（替代 children 引用，避免每渲染都做同步测量） */
  codeText?: string;
}> = ({ children, node: _node, codeText }) => {
  const [expanded, setExpanded] = useState(false);
  const [needsCollapse, setNeedsCollapse] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  useLayoutEffect(() => {
    const el = preRef.current;
    if (!el) return;
    // 150px ≈ 120px max-height + padding；超出则显示折叠按钮。
    // 依赖 codeText（字符串，稳定）而非 children（React element，每次渲染都是新引用）。
    const shouldCollapse = el.scrollHeight > 150;
    setNeedsCollapse((prev) => (prev === shouldCollapse ? prev : shouldCollapse));
  }, [codeText]);

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

/** 链接右键菜单：由 ChatView 通过 context 提供打开函数（模块级组件无法访问组件状态，故走 context）。 */
const LinkMenuContext = React.createContext<(url: string, x: number, y: number) => void>(() => {});

/** 自定义 markdown 链接：左键保持内置浏览器行为（不改），右键弹菜单选 Chrome/Edge/默认/复制。 */
const MarkdownLink: React.FC<React.AnchorHTMLAttributes<HTMLAnchorElement>> = ({ href, children }) => {
  const openLinkMenu = React.useContext(LinkMenuContext);
  return (
    <a
      href={href}
      onContextMenu={(e) => {
        e.preventDefault();
        if (href) openLinkMenu(href, e.clientX, e.clientY);
      }}
    >
      {children}
    </a>
  );
};

/** ReactMarkdown 的 components：提到模块作用域，稳定引用 + 自动折叠代码块。
 *  pre 组件从 children 提取文本作为 CollapsibleCodeBlock 的稳定依赖；
 *  a 组件接管右键菜单（左键行为不变）。 */
const MARKDOWN_COMPONENTS: Components = {
  a: MarkdownLink,
  pre: ({ children }) => (
    <CollapsibleCodeBlock codeText={extractText(children)}>{children}</CollapsibleCodeBlock>
  ),
};

/** 链接右键菜单定位 clamp 到视口内，避免溢出屏幕。 */
function clampLinkMenuPos(x: number, y: number): { left: number; top: number } {
  const estW = 180;
  const estH = 160;
  return {
    left: Math.max(0, Math.min(x, window.innerWidth - estW)),
    top: Math.max(0, Math.min(y, window.innerHeight - estH)),
  };
}

/** 链接右键菜单：Chrome / Edge / 默认浏览器 / 复制链接（复用 .ctx-menu 样式）。 */
const LinkContextMenu: React.FC<{ url: string; x: number; y: number; onClose: () => void }> = ({ url, x, y, onClose }) => {
  React.useEffect(() => {
    const onDoc = () => onClose();
    const onOther = () => onClose();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    // click 而非 mousedown：避免 mousedown 提前关菜单导致 ctx-item 的 onClick 不触发。
    document.addEventListener('click', onDoc);
    document.addEventListener('omp:ctxmenu-open', onOther);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onDoc);
      document.removeEventListener('omp:ctxmenu-open', onOther);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const run = (fn: () => void) => { onClose(); fn(); };

  return createPortal(
    <div
      className="ctx-menu"
      style={{ ...clampLinkMenuPos(x, y), position: 'fixed' }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="ctx-item" onClick={() => run(() => { void window.omp.openInBrowser('chrome', url).catch(() => undefined); })}>用 Chrome 打开</div>
      <div className="ctx-item" onClick={() => run(() => { void window.omp.openInBrowser('edge', url).catch(() => undefined); })}>用 Edge 打开</div>
      <div className="ctx-item" onClick={() => run(() => { void window.omp.openExternal(url).catch(() => undefined); })}>用默认浏览器打开</div>
      <div className="ctx-sep" />
      <div className="ctx-item" onClick={() => run(() => { void window.omp.copyText(url).catch(() => undefined); })}>复制链接地址</div>
    </div>,
    document.body,
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
                <CollapsibleCodeBlock key={`text-${i}`} codeText={p.text}>
                  <code>{p.text}</code>
                </CollapsibleCodeBlock>
              );
            }
            return (
              <ReactMarkdown
                key={`text-${i}`}
                remarkPlugins={REMARK_PLUGINS}
                components={MARKDOWN_COMPONENTS}
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
            <MsgAttachmentChip key={a.path} att={a} />
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

/**
 * 固定窗口虚拟化（方案 A，替代 react-virtuoso，v0.4.29）：
 * - 只渲染 messages 的固定窗口（最近 80 条），向上滚动时窗口前移（替换而非增长）。
 * - DOM 恒定为 WINDOW_SIZE 条消息 → 长会话（数千条）翻到最前面也不会 DOM 爆炸（旧版卡顿根源）。
 * - 打开会话 / 首次异步加载完成：窗口定位到最后 + 滚动到底（看到最近消息）。
 * - 流式时若在底部则跟随；用户上滚后不强行拉回。
 */
const WINDOW_SIZE = 80;
const LOAD_MORE = 40;

/** 空会话占位。 */
const EmptyHeader: React.FC = () => (
  <div className="chat-empty">
    <h2>有什么可以帮你的？</h2>
    <p>输入任务，MyPi 会读写文件、跑命令来完成。</p>
  </div>
);

export const ChatView: React.FC = () => {
  const messages = useApp((s) => s.messages);
  const currentSessionPath = useApp((s) => s.currentSessionPath);
  const isCompacting = useApp((s) => s.isCompacting);
  const compactionInfo = useApp((s) => s.compactionInfo);
  const isRetrying = useApp((s) => s.isRetrying);
  const retryInfo = useApp((s) => s.retryInfo);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);
  const prevSessionRef = useRef(currentSessionPath);
  const prevLenRef = useRef(messages.length);

  const total = messages.length;
  const [windowStart, setWindowStart] = useState(() => Math.max(0, total - WINDOW_SIZE));
  const maxStart = Math.max(0, total - WINDOW_SIZE);
  const startIdx = Math.max(0, Math.min(windowStart, maxStart));
  const visible = messages.slice(startIdx, startIdx + WINDOW_SIZE);
  const hasMore = startIdx > 0;
  const showEmpty = total === 0 && !isCompacting && !isRetrying;
  // 有会话路径但消息为空 = 正在异步加载（首览历史会话）
  const isLoading = total === 0 && !!currentSessionPath;

  // 链接右键菜单状态
  const [linkMenu, setLinkMenu] = useState<{ url: string; x: number; y: number } | null>(null);
  const openLinkMenu = useCallback((url: string, x: number, y: number) => {
    document.dispatchEvent(new CustomEvent('omp:ctxmenu-open'));
    setLinkMenu({ url, x, y });
  }, []);

  // 会话切换 / 首次异步加载完成（0→N）：窗口定位到最后 + 滚到底
  useEffect(() => {
    const sessionChanged = prevSessionRef.current !== currentSessionPath;
    const firstLoad = prevLenRef.current === 0 && total > 0;
    if (sessionChanged || firstLoad) {
      prevSessionRef.current = currentSessionPath;
      prevLenRef.current = total;
      stickBottom.current = true;
      setWindowStart(Math.max(0, total - WINDOW_SIZE));
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    } else {
      prevLenRef.current = total;
    }
  }, [currentSessionPath, total]);

  // 消息追加/更新（流式）：若在底部则跟随（窗口保持最后 + 滚到底）；用户上滚后不拉回
  useEffect(() => {
    if (stickBottom.current && total > 0) {
      setWindowStart(Math.max(0, total - WINDOW_SIZE));
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
  }, [messages, total]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    // 滚动到顶部时加载更多历史（窗口前移 LOAD_MORE 条，DOM 恒定）
    if (el.scrollTop < 100 && hasMore) {
      const prevScrollHeight = el.scrollHeight;
      const prevScrollTop = el.scrollTop;
      setWindowStart((w) => Math.max(0, w - LOAD_MORE));
      // 保持滚动位置（新增内容在顶部 → scrollTop 下移差值）
      requestAnimationFrame(() => {
        const newEl = scrollRef.current;
        if (newEl) {
          const delta = newEl.scrollHeight - prevScrollHeight;
          newEl.scrollTop = prevScrollTop + delta;
        }
      });
    }
  };

  // Minimap 跳转：目标消息在当前窗口 → scrollIntoView；否则先移动窗口再定位
  const scrollToMessage = useCallback((index: number) => {
    const el = scrollRef.current;
    const msg = messages[index];
    if (!msg || !el) return;
    const node = el.querySelector(`[data-msg-id="${CSS.escape(msg.id)}"]`);
    if (node) {
      node.scrollIntoView({ behavior: 'auto', block: 'center' });
      return;
    }
    // 目标不在窗口：移动窗口让目标位于中部，渲染后定位
    const targetStart = Math.max(0, Math.min(index - Math.floor(WINDOW_SIZE / 2), maxStart));
    setWindowStart(targetStart);
    setTimeout(() => {
      const el2 = scrollRef.current;
      const msg2 = messages[index];
      if (!el2 || !msg2) return;
      const node2 = el2.querySelector(`[data-msg-id="${CSS.escape(msg2.id)}"]`);
      if (node2) node2.scrollIntoView({ behavior: 'auto', block: 'center' });
    }, 80);
  }, [messages, maxStart]);

  const ctxMenu = linkMenu && createPortal(
    <LinkContextMenu url={linkMenu.url} x={linkMenu.x} y={linkMenu.y} onClose={() => setLinkMenu(null)} />,
    document.body,
  );

  // 首次浏览历史会话：异步加载期间显示 loading，不渲染列表（避免空态闪烁）
  if (isLoading && !isCompacting && !isRetrying) {
    return (
      <LinkMenuContext.Provider value={openLinkMenu}>
        <div className="chat-area">
          <div
            className="chat-scroll"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <span style={{ color: 'var(--text-faint)' }}>加载中…</span>
          </div>
        </div>
        {ctxMenu}
      </LinkMenuContext.Provider>
    );
  }

  return (
    <LinkMenuContext.Provider value={openLinkMenu}>
      <div className="chat-area">
        <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
          <div className="chat-inner">
            {showEmpty ? (
              <EmptyHeader />
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
        <Minimap scrollRef={scrollRef} messages={messages} onJump={scrollToMessage} />
      </div>
      {ctxMenu}
    </LinkMenuContext.Provider>
  );
};
