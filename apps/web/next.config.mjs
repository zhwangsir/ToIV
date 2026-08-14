/** @type {import('next').NextConfig} */
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 发版指纹(发版防御三件套之一)──────────────────────────────────────
// 背景:ToIV 经 openresty 双入口 + frp 分发,发版时 .next 整体替换,用户端旧 HTML
// 引用的 chunk 随之失效。客户端需要能侦测「部署侧已是新构建」并软提示刷新。
// 指纹同一值三处同源生效,保证任意两处比对必然一致:
//   ① generateBuildId → Next 自身的 .next/BUILD_ID(/version.json 运行时读它);
//   ② env.NEXT_PUBLIC_BUILD_ID → 构建期烘焙进客户端 bundle(lib/releaseWatch.ts 读);
//   ③ 部署侧 /version.json 路由读的是 rsync 上去的 .next/BUILD_ID —— 回滚只恢复
//     .next 快照时指纹也随之回滚,不会出现「bundle 旧、指纹新」的假提示。
// 格式:YYYYMMDD-HHmmss-<git短sha>[-dirty](UTC)。必须每次构建都不同(含时间戳):
// 常量指纹会让两次不同发版看起来相同,静默失去更新提示。
function resolveBuildFingerprint() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp =
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  let git = "nogit";
  try {
    const sha = execSync("git rev-parse --short HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const dirty = execSync("git status --porcelain", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
      ? "-dirty"
      : "";
    if (sha) git = `${sha}${dirty}`;
  } catch {
    // 非 git 检出(如源码包):退回纯时间戳,仍保证每次构建不同
  }
  // BUILD_ID 会出现在静态资源路径段,剔除非 URL 安全字符
  return `${stamp}-${git}`.replace(/[^a-zA-Z0-9._-]/g, "-");
}

const BUILD_FINGERPRINT = resolveBuildFingerprint();

const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  // Next 原生 BUILD_ID 采用我们的构建指纹(模块级常量,同次构建内与下方 env 烘焙值一致)
  generateBuildId: async () => BUILD_FINGERPRINT,
  // 烘焙进客户端 bundle,运行时代码经 process.env.NEXT_PUBLIC_BUILD_ID 读取
  env: { NEXT_PUBLIC_BUILD_ID: BUILD_FINGERPRINT },
  outputFileTracingRoot: __dirname,
  allowedDevOrigins: ["localhost", "127.0.0.1"],
  // 生产构建剥离 console(保留 error/warn 供线上排障);开发环境不动,保留完整调试输出
  compiler: {
    removeConsole:
      process.env.NODE_ENV === "production"
        ? { exclude: ["error", "warn"] }
        : false,
  },
  // rewrite 代理 /api 时,Next 默认只放行 10MB body → 视频上传会 socket hang up。
  // 拉到极大(等效不限;上传只受带宽/磁盘限制,与本服务无关,按用户要求不设上限)。
  experimental: {
    proxyTimeout: 3_600_000,
    middlewareClientMaxBodySize: "1024gb",
  },
  // LAN 直连兜底:公网走 cloud OpenResty 路由 /api(不经 Next);但在局域网直接访问
  // web:3100 时,/api 会打到 Next —— 这条 rewrite 把它转发到同 compose 网络的 api 容器,
  // 让 LAN 内(与 spark02 同网段)上传视频走本地高速链路,绕开 spark02↔cloud ~17KB/s 慢腿。
  // 本地开发(无 docker)时 fallback 到 localhost:8090,避免只起前端时报 502。
  async rewrites() {
    const apiBase = process.env.INTERNAL_API_BASE
      || process.env.NEXT_PUBLIC_API_BASE
      || "http://localhost:8090";
    return [
      {
        source: "/api/:path*",
        destination: `${apiBase}/api/:path*`,
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
