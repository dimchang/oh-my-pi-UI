import React from 'react';

/** 扁平化单色图标集合：全部用 stroke="currentColor"，颜色随主题/悬停自动变化。
 *  仅保留「OMP 就绪/未就绪」状态小绿点为彩色元素（见 StatusBar）。 */

export type IconName =
  | 'folder'
  | 'folderOpen'
  | 'file'
  | 'skill'
  | 'todo'
  | 'plus'
  | 'send'
  | 'attach'
  | 'shield'
  | 'chevron'
  | 'stop'
  | 'model'
  | 'plug'
  | 'steer'
  | 'restart'
  // 设置页侧栏扁平化单色图标（替换原 emoji）
  | 'cog'
  | 'robot'
  | 'pkg'
  // 输入行为二态按钮
  | 'queue'
  | 'guide';

const PATHS: Record<IconName, React.ReactNode> = {
  folder: <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />,
  folderOpen: (
    <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2H6z" />
  ),
  file: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </>
  ),
  skill: (
    <>
      <rect width="7" height="7" x="14" y="3" rx="1" />
      <rect width="9" height="7" x="3" y="14" rx="1" />
      <rect width="7" height="7" x="14" y="14" rx="1" />
      <rect width="7" height="7" x="3" y="3" rx="1" />
    </>
  ),
  todo: (
    <>
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  send: (
    <>
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </>
  ),
  attach: (
    <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.61 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  ),
  shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  chevron: <path d="m6 9 6 6 6-6" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  model: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 1v2" />
      <path d="M15 1v2" />
      <path d="M9 21v2" />
      <path d="M15 21v2" />
      <path d="M21 9h2" />
      <path d="M21 14h2" />
      <path d="M3 9h2" />
      <path d="M3 14h2" />
    </>
  ),
  plug: (
    <>
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
    </>
  ),
  // 改写下一轮（steer）：带弯钩的右向箭头，隐喻"转下一条"
  steer: (
    <>
      <path d="M9 14l5-5 0 0" />
      <path d="M4 20a8 8 0 0 1 8-8h7" />
      <path d="M15 7l5 0 0 5" />
    </>
  ),
  // 立即重起：圆形重置箭头，隐喻"立即重起当前 agent 轮"
  restart: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </>
  ),
  // 设置（系统配置）侧栏图标：单线齿轮，24x24 苹果风
  cog: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  // 智能体（agent）侧栏图标：单线机器人
  robot: (
    <>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M12 2v5" />
      <circle cx="8.5" cy="13" r="1.2" />
      <circle cx="15.5" cy="13" r="1.2" />
      <path d="M9 17h6" />
    </>
  ),
  // 模型（package）侧栏图标：单线立方体
  pkg: (
    <>
      <path d="M21 8 12 3 3 8v8l9 5 9-5V8z" />
      <path d="M3.3 7.7 12 13l8.7-5.3" />
      <path d="M12 22V13" />
    </>
  ),
  // 排队（queue）：右向下二个堆叠条，隐喻"在当前轮后追加"
  queue: (
    <>
      <path d="M4 6h10" />
      <path d="M4 12h10" />
      <path d="M4 18h6" />
      <path d="M16 12l4 3-4 3" />
    </>
  ),
  // 引导（guide）：魔力棒，隐喻"中途引导"
  guide: (
    <>
      <path d="M9 4l1.5 1.5L9 7" />
      <path d="M14 4l-1.5 1.5L14 7" />
      <path d="M12 8v3" />
      <path d="M5 14h14" />
      <path d="M7 17h10" />
      <path d="M9 20h6" />
    </>
  ),
};

export const Icon: React.FC<{
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
}> = ({ name, size = 16, className, strokeWidth = 2 }) => (
  <svg
    className={`icon ${className ?? ''}`}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {PATHS[name]}
  </svg>
);
