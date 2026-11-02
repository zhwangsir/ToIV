// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// ToIV apps/freezone-web — CE + mock API overlay on vendor DramaClaw frontend.
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import { execSync } from "node:child_process";
import path from "path";
import { fileURLToPath } from "node:url";
import { toivMockApiPlugin } from "./plugins/toiv-mock-api";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function datePrefix(d: Date = new Date()): string {
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}-`;
}

const DEFAULT_APP_VERSION = "v0.0.0-toiv-freezone";

function resolveAppVersion(): string {
  if (process.env.VITE_APP_VERSION) return process.env.VITE_APP_VERSION;
  try {
    const tag = execSync("git describe --tags --abbrev=0", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (tag) return tag;
  } catch {
    /* ignore */
  }
  return DEFAULT_APP_VERSION;
}

function resolveBuildId(): string {
  try {
    const described = execSync("git describe --tags --always --dirty", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (described) return `${datePrefix()}${described}`;
  } catch {
    /* ignore */
  }
  return `${datePrefix()}${Date.now()}`;
}

const APP_VERSION = resolveAppVersion();
const BUILD_ID = resolveBuildId();

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const useMock = env.VITE_TOIV_MOCK !== "0";
  // Built assets served under Prime at /freezone/; vite dev stays at /.
  const base = command === "build" ? "/freezone/" : "/";

  return {
    base,
    plugins: [
      TanStackRouterVite(),
      react(),
      tailwindcss(),
      ...(useMock ? [toivMockApiPlugin()] : []),
      {
        name: "emit-version-json",
        generateBundle() {
          this.emitFile({
            type: "asset",
            fileName: "version.json",
            source: JSON.stringify({ version: APP_VERSION, buildId: BUILD_ID }),
          });
        },
      },
      {
        name: "toiv-embed-headers",
        configureServer(server) {
          server.middlewares.use((_req, res, next) => {
            // Allow Prime (different origin/port) to iframe this app in local verify.
            res.setHeader("Content-Security-Policy", "frame-ancestors *");
            next();
          });
        },
      },
    ],
    define: {
      __APP_VERSION__: JSON.stringify(APP_VERSION),
      __BUILD_ID__: JSON.stringify(BUILD_ID),
      "import.meta.env.VITE_EDITION": JSON.stringify(env.VITE_EDITION || "ce"),
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes("node_modules")) return;
            if (id.includes("@tanstack")) return "tanstack";
            if (id.includes("@base-ui")) return "baseui";
            if (id.includes("react-hook-form") || id.includes("@hookform") || id.includes("/zod/"))
              return "forms";
            if (id.includes("i18next") || id.includes("react-i18next")) return "i18n";
            if (id.includes("lucide-react")) return "icons";
            if (id.includes("@xyflow")) return "xyflow";
          },
        },
      },
    },
    worker: { format: "es" },
    optimizeDeps: {
      exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"],
    },
    server: {
      host: true,
      port: 5174,
      strictPort: true,
      // Mock handles /api/v1; do not proxy to a missing SuperTale BE.
      proxy: useMock
        ? undefined
        : {
            "/api/v1": {
              target: env.VITE_API_URL || "http://127.0.0.1:8780",
              changeOrigin: true,
              ws: true,
            },
          },
    },
    preview: {
      host: true,
      port: 4174,
      strictPort: true,
    },
  };
});
