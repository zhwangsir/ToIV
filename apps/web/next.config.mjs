/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  allowedDevOrigins: ["localhost", "127.0.0.1"],
  // rewrite 代理 /api 时,Next 默认只放行 10MB body → 视频上传会 socket hang up。
  // 拉到极大(等效不限;上传只受带宽/磁盘限制,与本服务无关,按用户要求不设上限)。
  experimental: {
    proxyTimeout: 3_600_000,
    middlewareClientMaxBodySize: "1024gb",
  },
  // LAN 直连兜底:公网走 cloud OpenResty 路由 /api(不经 Next);但在局域网直接访问
  // web:3100 时,/api 会打到 Next —— 这条 rewrite 把它转发到同 compose 网络的 api 容器,
  // 让 LAN 内(与 spark02 同网段)上传视频走本地高速链路,绕开 spark02↔cloud ~17KB/s 慢腿。
  // /comfy:把 ComfyUI 原生界面代理进同源,供 ComfyEmbed 用 iframe 嵌入。
  // ComfyUI 的 WebSocket(/ws、/queue 等)走 HTTP upgrade,Next rewrite 默认支持。
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.INTERNAL_API_BASE || "http://api:8080"}/api/:path*`,
      },
      {
        source: "/comfy/:path*",
        destination: `http://100.99.181.103:8002/:path*`,
      },
    ];
  },
};

// Sentry 包裹:用 createRequire 在 ESM 下尝试加载 @sentry/nextjs,未安装时静默跳过
// (本轮只准备接入骨架,留给用户 `npm install @sentry/nextjs` 后自动生效)。
// 装上后 withSentryConfig 会注入 source map 上传 + 运行时包装;未装则原样导出 nextConfig。
import { createRequire } from "module";
const require = createRequire(import.meta.url);

let withSentryConfig = null;
try {
  // @sentry/nextjs 未安装时 require 会抛 → 跳过包裹,不影响构建
  ({ withSentryConfig } = require("@sentry/nextjs"));
} catch {
  withSentryConfig = null;
}

const finalConfig = withSentryConfig
  ? withSentryConfig(nextConfig, {
      // 静默构建期日志(非错误)
      silent: true,
      // 上传 source map 所需的组织/项目/令牌;未配则跳过上传(仅本地构建用)
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
    })
  : nextConfig;

export default finalConfig;
