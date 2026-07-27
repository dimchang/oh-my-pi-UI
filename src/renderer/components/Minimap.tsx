import React, { useEffect, useRef } from 'react';

/**
 * 密度滚动条小地图（移植自 Tiffa）。
 * 纯 Canvas + 原生 ResizeObserver / MutationObserver / scroll，零依赖。
 * 右侧一条 14px 色带：用户消息=强调色(宽)、助手消息=中性灰(窄)，叠加跟随滚动的视口框，点击/拖拽跳转。
 */

const MINIMAP_WIDTH = 14;
const SCROLLABLE_THRESHOLD = 40; // 低于此差值则不显示 minimap
const MIN_BLOCK_H = 2; // 色块最小高度，保证极短消息可见
const MIN_VIEWPORT_H = 6; // 视口框最小高度
const USER_X = 3;
const USER_W = 8;
const ASSISTANT_X = 4;
const ASSISTANT_W = 6;

/** 主题变量是 HSL 三元组（如 "210 90% 50%"），转成 canvas 可用的 hsla 字符串 */
function hsl(varVal: string, alpha: number): string {
  const parts = varVal.trim().split(/\s+/);
  if (parts.length < 3) return `rgba(128,128,128,${alpha})`;
  return `hsla(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
}

export const Minimap: React.FC<{ scrollRef: React.RefObject<HTMLDivElement | null> }> = ({ scrollRef }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const draggingRef = useRef(false);
  const redrawPendingRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const scrollEl = scrollRef.current;
    if (!canvas || !scrollEl) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let cssW = MINIMAP_WIDTH;
    let cssH = 0;

    const syncSize = () => {
      const h = scrollEl.clientHeight;
      const w = MINIMAP_WIDTH;
      cssW = w;
      cssH = h;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // 绘制坐标用 CSS 像素，高分屏清晰
    };

    const draw = () => {
      const root = document.documentElement;
      const userHsl = getComputedStyle(root).getPropertyValue('--accent-main-000').trim();
      const textHsl = getComputedStyle(root).getPropertyValue('--text-400').trim();

      const scrollHeight = scrollEl.scrollHeight;
      const clientHeight = scrollEl.clientHeight;
      const scrollTop = scrollEl.scrollTop;

      // 可滚动性判定：不可滚动则隐藏 minimap 并恢复原生滚动条
      if (scrollHeight <= clientHeight + SCROLLABLE_THRESHOLD) {
        canvas.style.display = 'none';
        scrollEl.classList.remove('minimap-active');
        return;
      }
      canvas.style.display = 'block';
      scrollEl.classList.add('minimap-active');

      const w = cssW;
      const h = cssH;
      ctx.clearRect(0, 0, w, h);
      if (scrollHeight <= 0) return;

      const scale = h / scrollHeight;
      // 滚动内容顶部在视口中的坐标：用于把每个消息的视口坐标换算成 scroll 内容坐标
      const rect = scrollEl.getBoundingClientRect();
      const contentTopInViewport = rect.top - scrollTop;

      const msgs = scrollEl.querySelectorAll<HTMLElement>('.message');

      // 先画助手（窄、半透明，在后）
      ctx.fillStyle = hsl(textHsl, 0.45);
      for (const el of msgs) {
        if (!el.classList.contains('assistant')) continue;
        const r = el.getBoundingClientRect();
        const y = (r.top - contentTopInViewport) * scale;
        const bh = Math.max(r.height * scale, MIN_BLOCK_H);
        ctx.fillRect(ASSISTANT_X, y, ASSISTANT_W, bh);
      }
      // 再画用户（宽、实心，在前）一眼区分角色与密度
      ctx.fillStyle = hsl(userHsl, 1);
      for (const el of msgs) {
        if (!el.classList.contains('user')) continue;
        const r = el.getBoundingClientRect();
        const y = (r.top - contentTopInViewport) * scale;
        const bh = Math.max(r.height * scale, MIN_BLOCK_H);
        ctx.fillRect(USER_X, y, USER_W, bh);
      }

      // 视口指示框：实时反映当前可见区域
      const vy = scrollTop * scale;
      const vh = Math.max(clientHeight * scale, MIN_VIEWPORT_H);
      ctx.fillStyle = 'rgba(128,128,128,0.18)';
      ctx.fillRect(0, vy, w, vh);
      ctx.strokeStyle = 'rgba(128,128,128,0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, vy + 0.5, w - 1, vh - 1);
    };

    const runRedraw = () => {
      redrawPendingRef.current = false;
      draw();
    };
    // 节流：redrawPending 防止一帧内多次重绘；rAF 为主，setTimeout 兜底（后台页 rAF 可能不触发）
    const scheduleRedraw = () => {
      if (redrawPendingRef.current) return;
      redrawPendingRef.current = true;
      requestAnimationFrame(runRedraw);
      window.setTimeout(() => {
        if (redrawPendingRef.current) runRedraw();
      }, 100);
    };

    const jump = (clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
      const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
      // 拖拽时临时切 auto，避免 smooth 平滑滚动拖慢跟随
      const prev = scrollEl.style.scrollBehavior;
      scrollEl.style.scrollBehavior = 'auto';
      scrollEl.scrollTop = ratio * maxScroll;
      scrollEl.style.scrollBehavior = prev;
    };

    syncSize();
    scheduleRedraw();

    const ro = new ResizeObserver(() => {
      syncSize();
      scheduleRedraw();
    });
    ro.observe(scrollEl);

    const mo = new MutationObserver(() => scheduleRedraw());
    mo.observe(scrollEl, { childList: true, subtree: true, characterData: true });

    const onScroll = () => scheduleRedraw();
    scrollEl.addEventListener('scroll', onScroll, { passive: true });

    const onMouseDown = (e: MouseEvent) => {
      draggingRef.current = true;
      jump(e.clientY);
    };
    const onMouseMove = (e: MouseEvent) => {
      if (draggingRef.current) jump(e.clientY);
    };
    const onMouseUp = () => {
      draggingRef.current = false;
    };

    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    return () => {
      ro.disconnect();
      mo.disconnect();
      scrollEl.removeEventListener('scroll', onScroll);
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [scrollRef]);

  return <canvas id="minimap" ref={canvasRef} style={{ display: 'none' }} />;
};
