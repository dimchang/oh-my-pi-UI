import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useApp, isImageFile, type ChatMessage, type MessagePart, type TextPart } from '../store';
import { ToolCard } from './ToolCard';
import { Icon } from './Icon';
import { Minimap } from './Minimap';
import {
  computeTurnStats,
  formatTurnSummary,
  groupTurns,
  splitTurnParts,
} from '../utils/turn-view';

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
/** 渲染一组文本 part（最终回答 / 用户提示词）：markdown，或「看起来像源码/文件内容」时
 *  按代码块渲染并默认折叠（避免 JSDoc `*`、路径列表被 markdown 错误解析成列表）。 */
const TextParts: React.FC<{ parts: TextPart[] }> = ({ parts }) => (
  <>
    {parts.map((p, i) => {
      const text = p.text;
      if (looksLikeFileContent(text)) {
        return (
          <CollapsibleCodeBlock key={`text-${i}`} codeText={text}>
            <code>{text}</code>
          </CollapsibleCodeBlock>
        );
      }
      return (
        <ReactMarkdown key={`text-${i}`} remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
          {text}
        </ReactMarkdown>
      );
    })}
  </>
);

/** 用户消息（及其它非 assistant 角色）气泡。assistant 的回合由 AssistantTurn 渲染。 */
const MessageItem = React.memo(function MessageItem({ msg }: { msg: ChatMessage }) {
  const [copied, setCopied] = useState(false);
  // 复制用户提示词：拼接全部 text part（思考/工具卡/附件不参与）
  const copyUserText = () => {
    const text = msg.parts.filter((p) => p.kind === 'text').map((p) => p.text).join('\n\n');
    void window.omp.copyText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }).catch(() => undefined);
  };
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
        <TextParts parts={msg.parts.filter((p): p is TextPart => p.kind === 'text' && !p.narration)} />
        {msg.streaming && <span style={{ color: 'var(--text-faint)' }}>▍</span>}
      </div>
      {msg.role === 'user' && msg.attachments && msg.attachments.length > 0 && (
        <div className="msg-attachments">
          {msg.attachments.map((a) => (
            <MsgAttachmentChip key={a.path} att={a} />
          ))}
        </div>
      )}
      {msg.role === 'user' && (
        <button
          type="button"
          className={`msg-copy${copied ? ' copied' : ''}`}
          title={copied ? '已复制' : '复制提示词'}
          onClick={copyUserText}
        >
          <Icon name="copy" size={13} />
        </button>
      )}
      {msg.role !== 'assistant' && msg.usage?.totalTokens !== undefined && (
        <div className="msg-usage">
          {msg.usage.totalTokens} tokens{msg.usage.duration ? ` · ${(msg.usage.duration / 1000).toFixed(1)}s` : ''}
        </div>
      )}
    </div>
  );
});

/** 一个回合的 assistant 部分 —— 用户视角的「一个回答」。
 *
 *  渲染结构严格为：**一行**「思考过程」折叠条 → 详细最终回复。
 *  omp 一次 run 会产生成百条 assistant 消息（每次模型响应一条），全部折叠进这**同一条**折叠条
 *  （thinking / 工具卡 / 过程说明按原序展开可见），摘要行给出回合级汇总；最终回复留在折叠条外。 */
const AssistantTurn = React.memo(function AssistantTurn({ msgs }: { msgs: ChatMessage[] }) {
  const first = msgs[0]!;
  const streaming = msgs.some((m) => m.streaming);
  const { folded, reply } = splitTurnParts(msgs, streaming);
  const summary = formatTurnSummary(computeTurnStats(msgs));
  const error = msgs.find((m) => m.error)?.error;
  // 折叠体内大回合可达数百个 ToolCard —— 折叠状态下不挂载（`<details>` 的 children 仍会进 DOM），
  // 展开才渲染，避免「打开会话把几百张工具卡全建出来」的卡顿。
  const [open, setOpen] = useState(false);
  return (
    <div
      className="message assistant"
      data-msg-id={first.id}
      style={error ? { borderLeft: '2px solid var(--red)', paddingLeft: 10 } : undefined}
    >
      <div className="msg-role assistant" style={error ? { color: 'var(--red)' } : undefined}>
        MyPi{error ? ' · 出错' : ''}
      </div>
      <div className="msg-body">
        {folded.length > 0 && (
          <details
            className="thinking narration"
            onToggle={(e) => setOpen(e.currentTarget.open)}
          >
            <summary>{summary}</summary>
            {open && (
              <div className="thinking-body markdown">
                {folded.map((p, i) => {
                  if (p.kind === 'thinking') return <div key={`think-${i}`} style={{ whiteSpace: 'pre-wrap' }}>{p.text}</div>;
                  if (p.kind === 'tool') return <ToolCard key={`tool-${p.toolCallId}`} tool={p} />;
                  return (
                    <ReactMarkdown key={`nar-${i}`} remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
                      {(p as TextPart).text}
                    </ReactMarkdown>
                  );
                })}
              </div>
            )}
          </details>
        )}
        <TextParts parts={reply} />
        {streaming && <span style={{ color: 'var(--text-faint)' }}>▍</span>}
      </div>
    </div>
  );
});

/**
 * 固定窗口虚拟化（方案 A，替代 react-virtuoso，v0.4.29；v0.5.5 窗口单位改为「回合」）：
 * - 只渲染 allTurns 的固定窗口（最近 30 个回合），向上滚动时窗口前移（替换而非增长）。
 * - 窗口单位必须是回合而不是消息条数：一个 80 步的巨型 agent run 折叠后只渲染 ~2 行，
 *   若窗口整段落入这种 run（80 条全是 assistant 消息、无用户消息），内容高度 < 视口
 *   → scrollHeight ≈ clientHeight → 产生不了 scroll 事件 → 「滚动加载更多」永远无法
 *   触发 → 视图死锁，只有跳底按钮能逃出（2026-09-15 用户截图复现，session 01a0a074）。
 *   按回合切窗保证任何切片至少渲染 30 个回合（≥30 条折叠摘要行），永远可滚。
 * - 打开会话 / 首次异步加载完成：窗口定位到最后 + 滚动到底（看到最近消息）。
 * - 流式时若在底部则跟随；用户上滚后不强行拉回。
 */
const WINDOW_TURNS = 30;
const LOAD_MORE_TURNS = 15;

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
  const innerRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);
  /** 是否停在真实底部（stickBottom 的 state 镜像，仅用于渲染「跳到最新」按钮）。 */
  const [atBottom, setAtBottom] = useState(true);
  /** 用户滚动意图：程序化钉底（rAF）与 Chromium scroll anchoring 也会触发 scroll 事件，
   *  必须与真实用户滚动区分，否则"仍在底部"会被误判成"用户已上滚"→ 失去跟随。 */
  const userScrollActive = useRef(false);
  const lastUserScrollAt = useRef(0);
  const prevSessionRef = useRef(currentSessionPath);
  const prevLenRef = useRef(messages.length);
  /** 最近一次 scroll 事件的 scrollTop（所有事件都记，含程序化钉底产生的），
   *  用于方向判定：用户向上滚哪怕 1px 也立即解除吸底。 */
  const lastScrollTopRef = useRef(0);
  /** load-more 进行中标记：窗口前移到 rAF 补偿完成前不再重复触发，
   *  防止一次快速滚动爆发内多个 scroll 事件把窗口连跳多格（跳过的历史直接看不到）。 */
  const loadMoreLockRef = useRef(false);
  const total = messages.length;
  // 全量回合（消息 → 一问一答回合视图）。窗口在「回合空间」滑动，渲染时切片。
  const allTurns = useMemo(() => groupTurns(messages), [messages]);
  const turnCount = allTurns.length;
  /** 消息下标 → 回合下标映射（Minimap / scrollToMessage 按消息索引跳转时换算窗口位置）。 */
  const turnIndexOfMsg = useMemo(() => {
    const map: number[] = [];
    for (let ti = 0; ti < allTurns.length; ti++) {
      const t = allTurns[ti]!;
      if (t.user) map.push(ti);
      for (let k = 0; k < t.asst.length; k++) map.push(ti);
    }
    return map;
  }, [allTurns]);
  const [windowStartTurn, setWindowStartTurn] = useState(() => Math.max(0, turnCount - WINDOW_TURNS));
  const maxStartTurn = Math.max(0, turnCount - WINDOW_TURNS);
  const startTurn = Math.max(0, Math.min(windowStartTurn, maxStartTurn));
  const visibleTurns = useMemo(
    () => allTurns.slice(startTurn, startTurn + WINDOW_TURNS),
    [allTurns, startTurn],
  );
  const hasMore = startTurn > 0;
  // 「剩余 N 条」仍按消息计数（与用户熟悉的口径一致）：窗口首回合之前的消息总数
  const remainingMsgs = useMemo(() => {
    let n = 0;
    for (let i = 0; i < startTurn; i++) {
      const t = allTurns[i]!;
      n += (t.user ? 1 : 0) + t.asst.length;
    }
    return n;
  }, [allTurns, startTurn]);
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
      setAtBottom(true);
      setWindowStartTurn(Math.max(0, turnCount - WINDOW_TURNS));
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    } else {
      prevLenRef.current = total;
    }
  }, [currentSessionPath, total, turnCount]);

  // 用户滚动意图标记：滚轮 / 触摸 / 键盘 / 指针按下（含拖拽原生滚动条）。
  // pointerdown→up 覆盖"按住拖动滚动条"期间的所有 scroll 事件。
  useEffect(() => {
    const mark = () => { lastUserScrollAt.current = Date.now(); };
    const down = () => { userScrollActive.current = true; mark(); };
    const up = () => { userScrollActive.current = false; mark(); };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('wheel', mark, { passive: true });
    window.addEventListener('touchmove', mark, { passive: true });
    window.addEventListener('keydown', mark);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('wheel', mark);
      window.removeEventListener('touchmove', mark);
      window.removeEventListener('keydown', mark);
    };
  }, []);

  // 消息追加/更新（流式）：若在底部则跟随（窗口保持最后 + 滚到底）；用户上滚后不拉回
  useEffect(() => {
    if (stickBottom.current && turnCount > 0) {
      setWindowStartTurn(Math.max(0, turnCount - WINDOW_TURNS));
      setAtBottom(true);
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
  }, [messages, turnCount]);

  // 吸底跟随（ResizeObserver）：内容尺寸任何变化（图片 onload、代码高亮、markdown
  // 二次布局、分批上屏）都把视口钉回底部。修「打开会话没跳到最后」：定位只在消息
  // 数组变化时滚一次，之后图片等晚成型内容撑高正文 → 视口被顶离底部且无人再跟随。
  // 用户上滚（stickBottom=false）时不打扰；依赖 loading/empty 态变化重连（loading
  // 分支不渲染 .chat-inner，ref 为 null 时跳过）。
  useEffect(() => {
    const inner = innerRef.current;
    const el = scrollRef.current;
    if (!inner || !el) return;
    const ro = new ResizeObserver(() => {
      if (stickBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [isLoading, showEmpty]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // ① 方向判定（所有事件都比对，含非 userDriven 的）：scrollTop 减小 = 用户在向上
    // 滚 → 立即解除吸底。不能只靠 nearBottom<60px 阈值：平滑滚轮/触控板单步增量常
    // <60px，且流式期间 ResizeObserver/跟随 effect 每帧钉底，用户在累积出 60px 前
    // 就被拽回 → 「拉不上去，只看得到最后的信息」（2026-09-14 用户报告）。
    if (el.scrollTop < lastScrollTopRef.current - 0.5) {
      stickBottom.current = false;
      setAtBottom(false);
    }
    lastScrollTopRef.current = el.scrollTop;
    // ② 只认「用户意图驱动」的滚动：程序化钉底（rAF 设 scrollTop）与 Chromium 的
    // scroll anchoring（窗口跳变后自动调 scrollTop）同样触发 scroll 事件。若一并纳入
    // 判定，会把"仍在底部"误判为"用户已上滚" → 失去跟随 → 最新回复只显示一半且不再
    // 补滚（2026-09-13 用户截图复现）。
    const userDriven = userScrollActive.current || Date.now() - lastUserScrollAt.current < 400;
    if (!userDriven) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    // ③ 恢复吸底只看 nearBottom（在底部附近 = 回到底部）；向上方向的解除已在 ① 完成。
    stickBottom.current = nearBottom;
    // 滚到底部且窗口落后于会话末尾（startTurn + WINDOW < turnCount）→ 窗口直接推进到最新。
    // 修「停在中间切片滚不到最后」：用户上滚阅读期间 agent 继续跑，窗口停住（设计如此，
    // 不拉回）；之后用户滚回 DOM 底部时，DOM 底 ≠ 会话底 —— 最新消息不在窗口里，
    // 渲染出来的只有旧切片末尾 + 空白，永远滚不到最后。这里补上"到底边 → 向前推进"。
    const windowBehind = startTurn < maxStartTurn;
    if (nearBottom && windowBehind) {
      setWindowStartTurn(maxStartTurn);
      requestAnimationFrame(() => {
        const el2 = scrollRef.current;
        if (el2) el2.scrollTop = el2.scrollHeight;
      });
    }
    setAtBottom(nearBottom && !windowBehind);
    // 滚动到顶部时加载更多历史（窗口前移 LOAD_MORE_TURNS 个回合，DOM 恒定）
    if (el.scrollTop < 100 && hasMore && !loadMoreLockRef.current) {
      loadMoreLockRef.current = true;
      const prevScrollHeight = el.scrollHeight;
      const prevScrollTop = el.scrollTop;
      setWindowStartTurn((w) => Math.max(0, w - LOAD_MORE_TURNS));
      // 保持滚动位置（新增内容在顶部 → scrollTop 下移差值）
      requestAnimationFrame(() => {
        const newEl = scrollRef.current;
        if (newEl) {
          const delta = newEl.scrollHeight - prevScrollHeight;
          newEl.scrollTop = prevScrollTop + delta;
        }
        loadMoreLockRef.current = false;
      });
    }
  };

  // 跳到最新：无视当前状态，窗口归位到最后 + 吸底（浮层按钮出口，保证任何
  // 异常定位状态下用户都能一键回到最新消息）。
  const jumpToLatest = useCallback(() => {
    stickBottom.current = true;
    setAtBottom(true);
    setWindowStartTurn(maxStartTurn);
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, [maxStartTurn]);

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
    // 目标不在窗口：移动窗口让目标所在回合位于中部，渲染后定位
    const ti = turnIndexOfMsg[index] ?? 0;
    const targetStart = Math.max(0, Math.min(ti - Math.floor(WINDOW_TURNS / 2), maxStartTurn));
    setWindowStartTurn(targetStart);
    setTimeout(() => {
      const el2 = scrollRef.current;
      const msg2 = messages[index];
      if (!el2 || !msg2) return;
      const node2 = el2.querySelector(`[data-msg-id="${CSS.escape(msg2.id)}"]`);
      if (node2) node2.scrollIntoView({ behavior: 'auto', block: 'center' });
    }, 80);
  }, [messages, turnIndexOfMsg, maxStartTurn]);

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
          <div className="chat-inner" ref={innerRef}>
            {showEmpty ? (
              <EmptyHeader />
            ) : (
              <>
                {hasMore && (
                  <div className="chat-load-more" style={{ textAlign: 'center', padding: '8px 0', color: 'var(--text-faint)', fontSize: 12 }}>
                    ↑ 滚动加载更多（剩余 {remainingMsgs} 条）
                  </div>
                )}
                {/* 一个回合渲染为：用户消息 → assistant 回合（一行折叠条 + 最终回复）。
                    注意两者必须**都**渲染 —— 回合的 assistant 消息挂在同一条用户消息的 Turn 上，
                    只渲染其中一个就会把整个回答吞掉（2026-09-13 用户截图：只剩用户气泡、回复全消失）。
                    key 用回合内首条消息 id（user 优先），与窗口位置无关，避免窗口前移时整列表重建。 */}
                {visibleTurns.map((t, i) => (
                  <React.Fragment key={t.user ? t.user.id : `t${startTurn + i}-${t.asst[0]?.id ?? 'x'}`}>
                    {t.user && <MessageItem msg={t.user} />}
                    {t.asst.length > 0 && <AssistantTurn msgs={t.asst} />}
                  </React.Fragment>
                ))}
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
        {/* 未停在真实底部（用户上滚 or 窗口落后）→ 提供一键回到最新的出口。
            不依赖 stickBottom 的自动判定，任何异常定位状态都能手动兜回。 */}
        {!atBottom && !showEmpty && (
          <button
            type="button"
            className="chat-jump-latest"
            title="跳到最新消息"
            onClick={jumpToLatest}
          >
            <Icon name="chevron" size={16} />
          </button>
        )}
        <Minimap scrollRef={scrollRef} messages={messages} onJump={scrollToMessage} />
      </div>
      {ctxMenu}
    </LinkMenuContext.Provider>
  );
};
