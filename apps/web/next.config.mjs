/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  allowedDevOrigins: ["localhost", "127.0.0.1"],
  // rewrite 代理 /api 时,Next 默认只放行 10MB body → 视频上传会 socket hang up。
  // 放大到 700MB(略高于 api 的 600MB 上限),让 LAN 上传大视频经 rewrite 通。
  experimental: {
    proxyTimeout: 3600000,
    middlewareClientMaxBodySize: "700mb",
  },
  // LAN 直连兜底:公网走 cloud OpenResty 路由 /api(不经 Next);但在局域网直接访问
  // web:3100 时,/api 会打到 Next —— 这条 rewrite 把它转发到同 compose 网络的 api 容器,
  // 让 LAN 内(与 spark02 同网段)上传视频走本地高速链路,绕开 spark02↔cloud ~17KB/s 慢腿。
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.INTERNAL_API_BASE || "http://api:8080"}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
