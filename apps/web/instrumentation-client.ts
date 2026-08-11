// Sentry 浏览器端初始化(@sentry/nextjs v9 instrumentation 约定)。
// v9 起 sentry.client.config.ts 弃用,客户端初始化迁移到本文件(QA-FULL-2026-08-11 P3,
// 消除 build 期 deprecation 告警)。@sentry/nextjs 自动加载,无需手动 import。
// DSN 走 NEXT_PUBLIC_ 前缀,会暴露到浏览器(Sentry DSN 公开安全,仅用于事件投递,无密钥权限)。
// 未配 DSN 时 init 仍执行但 Sentry 内部 no-op,不会有任何上报。
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1, // 10% 性能采样(平衡成本与可观测性)
  environment: process.env.NODE_ENV,
});

// v9 客户端路由跳转埋点钩子(App Router 导航性能采样)
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
