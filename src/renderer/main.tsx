import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { installDiagnostics, reportRender } from './diagnostics';
import './styles.css';

// 诊断埋点必须在 App 挂载前安装：白屏事故现场此前完全没有留痕（见 diagnostics.ts 说明）
installDiagnostics();

function reportDiag(lines: string[]): void {
  try {
    (globalThis as { omp?: { diagLog?: (l: string[]) => void } }).omp?.diagLog?.(lines);
  } catch {
    /* noop */
  }
}

/**
 * 渲染错误兜底。React 18 遇到未捕获的渲染错误会**卸载整棵树** —— 表现就是白屏。
 * 此前工程里没有任何 ErrorBoundary，任何一处组件抛错都会静默变白屏；这里兜住并显示
 * 可操作的降级界面（错误 + 堆栈 + 重载按钮），同时把现场写入诊断日志。
 */
class RenderErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    reportDiag([
      `!! React render error: ${error.message}`,
      `   componentStack: ${String(info.componentStack ?? '').slice(0, 3000)}`,
      ...(error.stack ? [`   ${String(error.stack).slice(0, 3000)}`] : []),
    ]);
  }

  render(): React.ReactNode {
    const err = this.state.error;
    if (!err) return this.props.children;
    return (
      <div
        style={{
          height: '100vh', overflow: 'auto', padding: 24,
          background: '#0d1117', color: '#c9d1d9',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
        }}
      >
        <h2 style={{ margin: '0 0 12px', color: '#f85149' }}>界面渲染出错（已阻止白屏）</h2>
        <p style={{ margin: '0 0 12px', color: '#8b949e' }}>
          该错误已写入 userData/logs/ui-YYYY-MM-DD.log。可先重载界面继续用，并把这段信息反馈。
        </p>
        <pre
          style={{
            margin: 0, padding: 12, borderRadius: 6, background: '#161b22',
            fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }}
        >
          {err.message}
          {'\n\n'}
          {String(err.stack ?? '').slice(0, 2000)}
        </pre>
        <button
          type="button"
          onClick={() => location.reload()}
          style={{
            marginTop: 12, padding: '6px 14px', borderRadius: 6, cursor: 'pointer',
            border: '1px solid #30363d', background: '#21262d', color: '#c9d1d9',
          }}
        >
          重载界面
        </button>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RenderErrorBoundary>
      {/* Profiler 统计每秒渲染次数与实际耗时：诊断模块据此区分「帧太多」与「render 空转」 */}
      <React.Profiler id="App" onRender={(_id, _phase, actualDuration) => reportRender(actualDuration)}>
        <App />
      </React.Profiler>
    </RenderErrorBoundary>
  </React.StrictMode>,
);
