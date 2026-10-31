// Next.js instrumentation 约定文件(@sentry/nextjs v9)。
// register() 在服务端启动时调用一次:Node.js runtime 加载 Sentry 服务端配置
// (原 sentry.server.config.ts 的自动加载在 v9 改由本文件显式驱动,消除 build 告警)。
// onRequestError 捕获服务端请求处理中的未捕获异常(RSC/路由处理器)。
import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
