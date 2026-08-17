"use client";

/**
 * Agent Team 详情页路由级错误边界(Next.js App Router 约定):
 * 根因修复后的兜底——渲染异常时显示友好面板(重试/返回任务列表),不再整页白屏。
 * 复用 globals.css 的 err-* 面板样式(与 ui/ErrorBoundary 同源)。
 */
import * as Sentry from "@sentry/nextjs";
import Link from "next/link";
import { useEffect } from "react";
import { Icon } from "@/components/ui/Icon";

export default function AgentRunDetailError({
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
      <h2 className="err-title">任务详情加载失败</h2>
      <p className="err-msg">{error.message || "未知错误"}</p>
      <div className="err-actions">
        <button type="button" className="btn" onClick={reset}>
          <Icon name="refresh" size={14} />
          <span>重试</span>
        </button>
        <Link href="/agent-runs" className="btn btn-ghost">
          <Icon name="chevron-left" size={14} />
          <span>返回列表</span>
        </Link>
      </div>
    </div>
  );
}
