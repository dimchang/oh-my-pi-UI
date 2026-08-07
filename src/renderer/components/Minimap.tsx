import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type ChatMessage } from '../store';

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

export const Minimap: React.FC<{
  scrollRef: React.RefObject<HTMLDivElement | null>;
  messages: ChatMessage[];
  onJump: (index: number) => void;
}> = ({ scrollRef, messages, onJump }) => {
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
    // DOM 高频变化（流式期间字符级变更）的回调加 100ms 防抖，
    // 避免每帧读 scrollHeight/clientHeight 触发强制同步布局。
    let timer: ReturnType<typeof setTimeout> | null = null;
    const debouncedUpdate = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(updateVisibility, 100);
    };

    updateVisibility(); // 初始调用
    const ro = new ResizeObserver(updateVisibility); // resize 频率低，无需防抖
    ro.observe(el);
    const mo = new MutationObserver(debouncedUpdate);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    el.addEventListener('scroll', updateVisibility, { passive: true }); // scroll 需实时响应
    return () => {
      if (timer) clearTimeout(timer);
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

  // ---- 点击跳转（交给 ChatView 的 scrollToMessage：窗口内 scrollIntoView / 窗口外先移动窗口）----
  const onBarClick = useCallback(() => {
    if (nearestIdx >= 0 && nearestIdx < tickItems.length) {
      onJump(tickItems[nearestIdx]!.msgIndex);
    }
  }, [nearestIdx, tickItems, onJump]);

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
