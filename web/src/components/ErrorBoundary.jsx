/**
 * ErrorBoundary.jsx — 懒加载 chunk 加载失败兜底（网络差/资源丢失时防白屏）。
 * React.lazy 的 chunk 加载失败会抛错，没有边界捕获就整页白屏。
 * 这里包住 Suspense，失败时显示提示而非崩溃。
 */
import { Component } from 'react';

export default class ErrorBoundary extends Component {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          className="skin-hint"
          style={{
            position: 'fixed',
            top: 20,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 2000,
            background: 'var(--panel-2)',
            padding: '10px 16px',
            borderRadius: 8,
            border: '1px solid var(--border)',
          }}
        >
          ⚠️ 功能加载失败，请刷新页面重试
        </div>
      );
    }
    return this.props.children;
  }
}
