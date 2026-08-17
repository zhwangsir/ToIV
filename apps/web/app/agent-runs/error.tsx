"use client";

/**
 * Agent Team 列表页路由级错误边界(Next.js App Router 约定):
 * 根因修复后的兜底——渲染异常时显示友好面板(重试/返回首页),不再整页白屏。
 * 复用 globals.css 的 err-* 面板样式(与 ui/ErrorBoundary 同源)。
 */
import * as Sentry from "@sentry/nextjs";
import Link from "next/link";
import { useEffect } from "react";
import { Icon } from "@/components/ui/Icon";

export default function AgentRunsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="err-boundary" role="alert">
      <div className="err-icon">
        <Icon name="error" size={32} />
      </div>
      <h2 className="err-title">任务列表加载失败</h2>
      <p className="err-msg">{error.message || "未知错误"}</p>
      <div className="err-actions">
        <button type="button" className="btn" onClick={reset}>
          <Icon name="refresh" size={14} />
          <span>重试</span>
        </button>
        <Link href="/" className="btn btn-ghost">
          <Icon name="home" size={14} />
          <span>返回首页</span>
        </Link>
      </div>
    </div>
  );
}
