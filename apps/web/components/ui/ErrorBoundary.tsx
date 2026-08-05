"use client";

import { Component, ErrorInfo, ReactNode } from "react";
import { Icon } from "./Icon";

interface Props {
  children: ReactNode;
  /** 视图名,用于错误提示 */
  viewName?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * 视图级错误边界:防止单个视图崩溃导致整个 app 白屏。
 * 捕获子树渲染异常,显示降级 UI + 重试按钮,保留侧栏/顶栏可用。
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 开发环境输出完整错误信息,便于调试
    console.error("[ErrorBoundary]", this.props.viewName ?? "unknown", error, info.componentStack);
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    const name = this.props.viewName ?? "视图";
    return (
      <div className="err-boundary" role="alert">
        <div className="err-icon">
          <Icon name="error" size={32} />
        </div>
        <h2 className="err-title">{name}加载失败</h2>
        <p className="err-msg">
          {this.state.error?.message ?? "未知错误"}
        </p>
        <div className="err-actions">
          <button className="btn" onClick={this.handleReset}>
            <Icon name="refresh" size={14} />
            <span>重试</span>
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => {
              // 回到首页 assistant 视图
              window.location.href = "/?view=assistant";
            }}
          >
            <Icon name="chat" size={14} />
            <span>回到助手</span>
          </button>
        </div>
        <style jsx>{`
          .err-boundary {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 60vh;
            padding: var(--space-7);
            gap: var(--space-4);
            text-align: center;
          }
          .err-icon {
            color: var(--err);
            opacity: 0.6;
          }
          .err-title {
            font-size: 1.25rem;
            font-weight: 600;
            color: var(--text-primary);
            margin: 0;
          }
          .err-msg {
            font-size: 0.875rem;
            color: var(--text-muted);
            font-family: var(--font-mono);
            max-width: 600px;
            word-break: break-word;
            margin: 0;
          }
          .err-actions {
            display: flex;
            gap: var(--space-3);
            margin-top: var(--space-3);
          }
        `}</style>
      </div>
    );
  }
}
