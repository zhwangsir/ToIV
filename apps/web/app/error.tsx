"use client";

// 路由级错误边界(Next.js App Router error.tsx 约定,2026-08-16 审计补建)。
// 覆盖根页面 app/page.tsx —— 首页(对话)/生成/作品库/设置等全部 SPA 视图:
// 此前视图渲染抛错直接穿透到 global-error 整页白屏,现收敛为友好面板 + 重试 + 返回首页。
// 与 global-error 的分工:global-error 兜根布局层(无 globals.css,只能内联色值);
// 本边界在根布局内渲染,token 可用,直接复用 ui/ErrorBoundary 的 err-* 视觉语言。
// agent-runs 段由 Team A 的嵌套 error.tsx 接管(嵌套边界优先,本文件不重复建设)。
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import { Icon } from "@/components/ui/Icon";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // 无 Sentry DSN 时 captureException 为 no-op(与 global-error 同一约定)
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="err-boundary" role="alert">
      <div className="err-icon">
        <Icon name="error" size={32} />
      </div>
      <h2 className="err-title">页面加载失败</h2>
      <p className="err-msg">{error.message || "应用发生未预期的错误"}</p>
      <div className="err-actions">
        <button type="button" className="btn" onClick={reset}>
          <Icon name="refresh" size={14} />
          <span>重试</span>
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            // 回首页(默认对话门户);整页跳转避开可能损坏的客户端状态
            window.location.href = "/";
          }}
        >
          <Icon name="chat" size={14} />
          <span>返回首页</span>
        </button>
      </div>
    </div>
  );
}
