import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { resolveHeavyMediaEnabled } from "./media-build-mode";

const webDir = dirname(fileURLToPath(import.meta.url));
const appVersion = "dogfood-local";
const appChangelog = "";
const heavyMediaEnabled = resolveHeavyMediaEnabled(process.env.BEEFTV_FULL_MEDIA_RESOURCES);

export default defineConfig({
  base: "/",
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __APP_CHANGELOG__: JSON.stringify(appChangelog),
    __BEEFTV_HEAVY_MEDIA_ENABLED__: JSON.stringify(heavyMediaEnabled),
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(appVersion),
  },
  server: {
    host: "127.0.0.1",
    port: 3010,
    proxy: {
      "/api/workspace": { target: "http://192.168.71.47:3100", changeOrigin: true, rewrite: (p) => "/studio" + p },
      "/api/canvas-projects": { target: "http://192.168.71.47:3100", changeOrigin: true, rewrite: (p) => "/studio" + p },
      "/api/canvas": { target: "http://192.168.71.47:3100", changeOrigin: true, rewrite: (p) => "/studio" + p },
      "/api": { target: "http://192.168.71.47:8090", changeOrigin: true },
    },
  },
  resolve: {
    alias: {
      "@": resolve(webDir, "src"),
      "@toiv-web": resolve(webDir, "../../web"),
    },
  },
});
