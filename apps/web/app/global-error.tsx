"use client";

// 全局错误边界(Next.js App Router 约定 + @sentry/nextjs v9 推荐)。
// 捕获根布局层渲染错误并上报 Sentry;无 Sentry DSN 时 captureException 为 no-op。
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
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
    <html lang="zh-CN">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          fontFamily: "sans-serif",
          background: "#fafafa",
          color: "#1a1a1a",
        }}
      >
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>
          页面出错了
        </h1>
        <p style={{ fontSize: 14, color: "#888", margin: 0 }}>
          应用发生未预期的错误,请尝试重新加载。
        </p>
        <button
          onClick={reset}
          style={{
            padding: "10px 24px",
            borderRadius: 8,
            border: "none",
            background: "#5b5bd6",
            color: "#fff",
            fontSize: 14,
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          重新加载
        </button>
      </body>
    </html>
  );
}
