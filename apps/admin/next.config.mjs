/** @type {import('next').NextConfig} */
const nextConfig = {
  // 独立管理系统:所有后端调用经本服务反代到同机 core API(免 CORS,token 不出内网)
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://localhost:8090/api/:path*",
      },
    ];
  },
};

export default nextConfig;
