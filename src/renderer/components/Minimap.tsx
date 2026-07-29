import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp, type ChatMessage } from '../store';

/**
 * 密度指示条（左侧集中横线簇）。
 *
 * 设计（参考截图）：
 * 1. 所有用户消息的横线**紧凑堆叠成一簇**，不是散布在整个聊天区高度
 * 2. 鼠标靠近时，**离鼠标最近的横线最长**，上下依次递减（距离驱动渐变长度）
 * 3. 不需要精准 hover 到某条线上——整个密度区都是热区
 * 4. 最近的那条自动弹出用户输入气泡；点击跳转
 */

const SCROLLABLE_THRESHOLD = 40;
const TICK_GAP = 3;            /* 横线间距 */
const LINE_H = 2;              /* 横线高度 */
const MIN_LINE_W = 8;          /* 最短横线宽 */
const MAX_LINE_W = 40;         /* 最长横线宽（最近那条） */
/** 洛伦兹衰减：y = 1/(1 + x²/σ²)，中间陡峭、边缘快速归零。σ 越小越陡 */
function lorentzFalloff(d: number, sigma: number): number {
  return 1 / (1 + (d * d) / (sigma * sigma));
}

/** 从 ChatMessage.parts 里提取用户输入纯文本 */
function getUserText(msg: ChatMessage): string {
  const texts: string[] = [];
  for (const p of msg.parts) {
    if (p.kind === 'text') texts.push(p.text);
  }
  return texts.join(' ').replace(/\s+/g, ' ').trim();
}

interface TickItem {
  id: string;
  msgIndex: number;
  totalMessages: number;
  preview: string;
}

export const Minimap: React.FC<{ scrollRef: React.RefObject<HTMLDivElement | null> }> = ({ scrollRef }) => {
  const messages = useApp((s) => s.messages);
  const [visible, setVisible] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const clusterRef = useRef<HTMLDivElement>(null);

  /** 鼠标在 bar 内的 Y 坐标（相对于 bar 顶部） */
  const [mouseY, setMouseY] = useState<number | null>(null);

  const tickItems = useMemo<TickItem[]>(() => {
    const items: TickItem[] = [];
    const total = messages.length;
    for (let i = 0; i < total; i++) {
      const msg = messages[i];
      if (!msg || msg.role !== 'user') continue;
      items.push({
        id: msg.id,
        msgIndex: i,
        totalMessages: total,
        preview: getUserText(msg),
      });
    }
    return items;
  }, [messages]);

  // ---- 可滚动性检测 ----
  const updateVisibility = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const canScroll = el.scrollHeight > el.clientHeight + SCROLLABLE_THRESHOLD;
    setVisible(canScroll && tickItems.length > 0);
  }, [scrollRef, tickItems.length]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateVisibility();
    const ro = new ResizeObserver(updateVisibility);
    ro.observe(el);
    const mo = new MutationObserver(updateVisibility);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    el.addEventListener('scroll', updateVisibility, { passive: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
      el.removeEventListener('scroll', updateVisibility);
    };
  }, [scrollRef, updateVisibility]);

  // ---- 鼠标跟踪：整个 bar 区域都是热区 ----
  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect) return;
    setMouseY(e.clientY - rect.top);
  }, []);

  const onMouseLeave = useCallback(() => {
    setMouseY(null);
  }, []);

  // ---- 计算每条线的宽度 + 找到最近的线 ----
  const { lineWidths, nearestIdx } = useMemo(() => {
    const n = tickItems.length;
    if (n === 0 || mouseY === null) {
      return { lineWidths: new Array(n).fill(MIN_LINE_W), nearestIdx: -1 };
    }

    // 每条线的中心 Y（紧凑堆叠，相对 cluster 内容区）
    const centers: number[] = [];
    for (let i = 0; i < n; i++) {
      centers.push(i * (TICK_GAP + LINE_H) + LINE_H / 2);
    }

    // 用实际 DOM 位置计算鼠标相对 cluster 的偏移（避免硬编码 padding 常量出错）
    let myRel = mouseY;
    if (barRef.current && clusterRef.current) {
      const barRect = barRef.current.getBoundingClientRect();
      const clRect = clusterRef.current.getBoundingClientRect();
      // cluster 相对 bar 的顶部偏移
      const clusterOffsetY = clRect.top - barRect.top;
      myRel = mouseY - clusterOffsetY;
    }

    let minDist = Infinity;
    let nearest = -1;
    const widths: number[] = [];

    for (let i = 0; i < n; i++) {
      const dist = Math.abs(centers[i]! - myRel);
      if (dist < minDist) { minDist = dist; nearest = i; }
      const f = lorentzFalloff(dist, 10); // σ=10：约 ±17px 处衰减到 0.25
      widths.push(Math.round(MIN_LINE_W + (MAX_LINE_W - MIN_LINE_W) * f));
    }

    return { lineWidths: widths, nearestIdx: nearest };
  }, [tickItems, mouseY]);

  // ---- 点击跳转（用 DOM 实际位置，而非比例估算）----
  const jumpTo = useCallback((item: TickItem) => {
    const el = scrollRef.current;
    if (!el) return;
    // 优先用 DOM 实际位置：消息元素有 data-msg-id 属性
    const msgEl = el.querySelector(`[data-msg-id="${item.id}"]`) as HTMLElement | null;
    if (msgEl) {
      // 消息在 DOM 中 → 精确滚动到该消息
      msgEl.scrollIntoView({ behavior: 'auto', block: 'center' });
      return;
    }
    // 消息不在 DOM 中（被虚拟化裁掉了）→ 退回比例估算
    if (item.totalMessages <= 0) return;
    const maxScroll = el.scrollHeight - el.clientHeight;
    const ratio = item.msgIndex / item.totalMessages;
    const prev = el.style.scrollBehavior;
    el.style.scrollBehavior = 'auto';
    el.scrollTop = ratio * maxScroll;
    el.style.scrollBehavior = prev;
  }, [scrollRef]);

  // 点击整个 bar 时跳转到最近的线对应的消息
  const onBarClick = useCallback(() => {
    if (nearestIdx >= 0 && nearestIdx < tickItems.length) jumpTo(tickItems[nearestIdx]!);
  }, [nearestIdx, tickItems, jumpTo]);

  if (!visible || tickItems.length === 0) return null;

  const isHovered = mouseY !== null;

  return (
    <div
      className="density-bar"
      ref={barRef}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      onClick={onBarClick}
    >
      <div className="density-cluster" ref={clusterRef} style={{ height: `${tickItems.length * (TICK_GAP + LINE_H) - TICK_GAP}px` }}>
        {tickItems.map((item, i) => {
          const w = i < lineWidths.length ? lineWidths[i] : MIN_LINE_W;
          const isNearest = i === nearestIdx && isHovered;
          return (
            <div key={item.id} className="density-tick" style={{ top: `${i * (TICK_GAP + LINE_H)}px` }}>
              <span
                className={`density-line${isNearest ? ' nearest' : ''}`}
                style={{ width: w }}
              />
              {/* 只有最近的一条显示 tooltip */}
              {isNearest && (
                <span className="density-tooltip">{item.preview || '(空消息)'}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
