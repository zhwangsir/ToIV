// Sentry 浏览器端初始化(@sentry/nextjs v9 instrumentation 约定)。
// v9 起 sentry.client.config.ts 弃用,客户端初始化迁移到本文件(QA-FULL-2026-08-11 P3,
// 消除 build 期 deprecation 告警)。@sentry/nextjs 自动加载,无需手动 import。
// DSN 走 NEXT_PUBLIC_ 前缀,会暴露到浏览器(Sentry DSN 公开安全,仅用于事件投递,无密钥权限)。
// 未配 DSN 时 init 仍执行但 Sentry 内部 no-op,不会有任何上报。
import * as Sentry from "@sentry/nextjs";
import { installDomReconciliationGuard } from "@/lib/domGuard";
import { installChunkLoadRecovery } from "@/lib/chunkLoadRecovery";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1, // 10% 性能采样(平衡成本与可观测性)
  environment: process.env.NODE_ENV,
});

// ── 发版防御三件套之二、之三(仅生产)────────────────────────────────
// instrumentation-client 是 Next App Router 约定的客户端最早入口,先于页面组件
// 与 React hydration 执行,适合安放必须「抢在 React 前面」的全局补丁:
//   ③ 翻译插件防崩:补丁须在 React 首次协调(removeChild/insertBefore)前装好;
//   ② chunk 404 自动恢复:发版后旧 HTML 引用失效 chunk,捕获后自动刷新一次兜底。
// dev 不启用:guard 会掩盖真实 DOM bug;chunk 错误由 HMR 处理,无需整页刷新。
if (process.env.NODE_ENV === "production") {
  installDomReconciliationGuard();
  installChunkLoadRecovery();
}

// v9 客户端路由跳转埋点钩子(App Router 导航性能采样)
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
