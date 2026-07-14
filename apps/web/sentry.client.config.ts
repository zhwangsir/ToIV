// Sentry 浏览器端初始化。
// 由 @sentry/nextjs 在客户端打包时自动加载(装上 @sentry/nextjs + next.config.mjs 包裹后生效)。
// DSN 走 NEXT_PUBLIC_ 前缀,会暴露到浏览器(Sentry DSN 公开安全,仅用于事件投递,无密钥权限)。
// 未配 DSN 时 init 仍执行但 Sentry 内部 no-op,不会有任何上报。
//
// 注:@sentry/nextjs 尚未 npm install 时,@ts-ignore 规避 tsc 报错;装上后此行自动生效。
// @ts-ignore
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1, // 10% 性能采样(平衡成本与可观测性)
  environment: process.env.NODE_ENV,
});
