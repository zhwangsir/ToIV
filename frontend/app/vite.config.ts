import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const publicBase = process.env.BEEFTV_PUBLIC_BASE?.trim() || "/";
const apiProxyTarget = process.env.VITE_API_PROXY_TARGET?.trim() || "http://127.0.0.1:8090";
const canvasProxyTarget = process.env.VITE_CANVAS_PROXY_TARGET?.trim() || "http://127.0.0.1:8080";
const gatewayTarget = process.env.VITE_STUDIO_GATEWAY_TARGET?.trim() || "http://127.0.0.1:3100";
// 本地仓画布在 vendor/canvas，远端部署布局在 apps/canvas（frontend/app → apps/prime/web）
export function resolvePolicyModule(appDir: string): string | undefined {
    const roots = ["../../vendor/canvas/web/src", "../../canvas/web/src"].map(rel => resolve(appDir, rel));
    return ["content-lock.ts", "content-policy.ts"]
        .flatMap(file => roots.map(root => resolve(root, file)))
        .find(file => existsSync(file));
}

const policyModule = resolvePolicyModule(here);
if (!policyModule) throw new Error("Missing shared canvas content policy");

export default defineConfig({
    base: publicBase,
    plugins: [react()],
    server: {
        proxy: {
            "/studio/api": { target: canvasProxyTarget, changeOrigin: true, rewrite: path => path.replace(/^\/studio\/api/, "/api") },
            "/studio/auth": { target: gatewayTarget, changeOrigin: true, xfwd: true },
            "/api": { target: apiProxyTarget, changeOrigin: true, xfwd: true },
        },
    },
    resolve: {
        alias: {
            "@toiv": resolve(here, "src/toiv"),
            "@content-lock": policyModule,
        },
    },
});
