import Link from "next/link";

/**
 * 全站 404(本地化,QA-FULL-2026-08-11 P3)。
 * Next.js App Router 约定文件;未匹配路由自动渲染,替代默认英文页。
 */
export default function NotFound() {
  return (
    <main
      id="main"
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "var(--space-4, 16px)",
        padding: "var(--space-6, 24px)",
        textAlign: "center",
        color: "var(--text-primary, #1a1a1a)",
        fontFamily: "var(--font-inter), sans-serif",
      }}
    >
      <p
        style={{
          fontSize: 64,
          fontWeight: 700,
          lineHeight: 1,
          margin: 0,
          color: "var(--accent, #5b5bd6)",
          fontFamily: "var(--font-jetbrains), monospace",
        }}
      >
        404
      </p>
      <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>
        页面不存在或已被移动
      </h1>
      <p style={{ fontSize: 14, color: "var(--text-muted, #888)", margin: 0 }}>
        你访问的地址没有对应的内容,请检查链接是否正确。
      </p>
      <Link
        href="/"
        style={{
          marginTop: "var(--space-2, 8px)",
          padding: "10px 24px",
          borderRadius: "var(--radius-md, 8px)",
          background: "var(--accent, #5b5bd6)",
          color: "#fff",
          textDecoration: "none",
          fontSize: 14,
          fontWeight: 500,
        }}
      >
        返回首页
      </Link>
    </main>
  );
}
