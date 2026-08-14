import Link from "next/link";

/**
 * 全站 404(本地化,QA-FULL-2026-08-11 P3)。
 * Next.js App Router 约定文件;未匹配路由自动渲染,替代默认英文页。
 * 2026-08-14 UI-A:走设计系统 token(globals.css 已加载,var() 无需 fallback),
 * 清除旧紫 #5b5bd6 与硬编码色值;画布/暗角继承全局 body 样式。
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
        gap: "var(--space-4)",
        padding: "var(--space-6)",
        textAlign: "center",
        color: "var(--text-primary)",
        fontFamily: "var(--font-sans)",
      }}
    >
      <p
        style={{
          fontSize: 64,
          fontWeight: "var(--font-bold)",
          lineHeight: 1,
          margin: 0,
          color: "var(--accent)",
          fontFamily: "var(--font-mono)",
        }}
      >
        404
      </p>
      <h1
        style={{
          fontSize: "var(--text-title)",
          fontWeight: "var(--font-semibold)",
          margin: 0,
        }}
      >
        页面不存在或已被移动
      </h1>
      <p style={{ fontSize: "var(--text-body)", color: "var(--text-muted)", margin: 0 }}>
        你访问的地址没有对应的内容,请检查链接是否正确。
      </p>
      <Link
        href="/"
        style={{
          marginTop: "var(--space-2)",
          padding: "10px 24px",
          borderRadius: "var(--radius-control)",
          background: "var(--accent)",
          color: "var(--text-on-accent)",
          textDecoration: "none",
          fontSize: "var(--text-body)",
          fontWeight: "var(--font-medium)",
        }}
      >
        返回首页
      </Link>
    </main>
  );
}
