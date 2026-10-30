import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const publicBase = process.env.BEEFTV_PUBLIC_BASE?.trim() || "/";
const apiProxyTarget = process.env.VITE_API_PROXY_TARGET?.trim() || "http://127.0.0.1:8080";

export default defineConfig({
    base: publicBase,
    plugins: [react()],
    server: {
        proxy: {
            "/studio/api": { target: "http://127.0.0.1:8080", changeOrigin: true },
            "/api": { target: apiProxyTarget, changeOrigin: true, xfwd: true },
        },
    },
    resolve: {
        alias: {
            "@toiv": resolve(here, "src/toiv"),
            "@content-lock": resolve(here, "../canvas/web/src/content-lock.ts"),
        },
    },
});
