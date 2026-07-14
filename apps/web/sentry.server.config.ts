// Sentry 服务端(Node.js runtime)初始化。
// 由 @sentry/nextjs 在服务端运行时自动加载(装上 @sentry/nextjs + next.config.mjs 包裹后生效)。
// 捕获 SSR / API route / server actions 中的未捕获异常。DSN 同客户端配置可一致。
// 未配 DSN 时 init 仍执行但 Sentry 内部 no-op,不会有任何上报。
//
// 注:@sentry/nextjs 尚未 npm install 时,@ts-ignore 规避 tsc 报错;装上后此行自动生效。
// @ts-ignore
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1, // 10% 性能采样
  environment: process.env.NODE_ENV,
});
