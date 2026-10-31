import { dirname, resolve } from "node:path";
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, normalizePath, type Plugin } from "vite";

import { resolveHeavyMediaEnabled } from "./media-build-mode";

const webDir = realpathSync(dirname(fileURLToPath(import.meta.url)));
const policyPaths: string[] = JSON.parse(readFileSync(resolve(webDir, "tsconfig.json"), "utf8")).compilerOptions.paths["@content-lock"];
const policyCandidates = policyPaths.map((path) => normalizePath(resolve(webDir, path)));
const policyModule = policyCandidates.find((path) => existsSync(path));
// content-policy.ts 是主代码必需的中性回落实现；两个候选都不存在说明仓库不完整。
if (!policyModule) throw new Error(`missing content policy module, expected one of: ${policyCandidates.join(", ")}`);
const appVersion = process.env.CANVAS_BUILD_VERSION?.trim() || readFileSync(resolve(webDir, "../VERSION"), "utf8").trim();
const appChangelog = readFileSync(resolve(webDir, "../CHANGELOG.md"), "utf8");
const apiProxyTarget = process.env.VITE_API_PROXY_TARGET?.trim() || "http://127.0.0.1:8080";
const desktopLaunchToken = process.env.VITE_DESKTOP_LAUNCH_TOKEN?.trim();
const heavyMediaEnabled = resolveHeavyMediaEnabled(process.env.BEEFTV_FULL_MEDIA_RESOURCES);

function optionalPolicyPlugin(): Plugin {
    let cleanup: (() => void) | undefined;
    return {
        name: "optional-content-policy",
        configureServer(server) {
            let restarting = false;
            const onPolicyFileChange = (file: string) => {
                if (restarting || !policyCandidates.includes(normalizePath(file))) return;
                if (policyCandidates.find((path) => existsSync(path)) === policyModule) return;
                restarting = true;
                void server.restart().then(() => {
                    server.ws.send({ type: "full-reload" });
                }).catch((error: unknown) => {
                    server.config.logger.error(error instanceof Error ? error.stack ?? error.message : String(error));
                }).finally(() => {
                    restarting = false;
                });
            };
            const watcher = server.watcher;
            watcher.add(policyCandidates);
            watcher.on("add", onPolicyFileChange);
            watcher.on("unlink", onPolicyFileChange);
            cleanup = () => {
                watcher.off("add", onPolicyFileChange);
                watcher.off("unlink", onPolicyFileChange);
            };
        },
        closeBundle() {
            cleanup?.();
        },
    };
}

function pruneOptionalMediaPlugin() {
    return {
        name: "beeftv-prune-optional-media",
        closeBundle() {
            const dist = resolve(webDir, "dist");
            // The retired public welcome site is never part of the application.
            rmSync(resolve(dist, "welcome"), { recursive: true, force: true });
            if (heavyMediaEnabled) return;
            for (const directory of ["mediapipe", "lighting-presets", "three"]) {
                rmSync(resolve(dist, directory), { recursive: true, force: true });
            }
            rmSync(resolve(dist, "canvas/models/blaze-face-full-range-sparse.tflite"), { force: true });
            const staticDir = resolve(dist, "static");
            for (const file of readdirSync(staticDir)) {
                if (file.startsWith("ffmpeg-core-")) rmSync(resolve(staticDir, file), { force: true });
            }
        },
    };
}

// Sub-path browser deployment (toiv.wineryz.top/studio/): BEEFTV_PUBLIC_BASE=/studio/ plus
// VITE_CANVAS_BACKEND_URL=/studio/api. Default "/" keeps every other build unchanged.
const publicBase = process.env.BEEFTV_PUBLIC_BASE?.trim() || "/";

export default defineConfig({
    base: publicBase,
    plugins: [react(), optionalPolicyPlugin(), pruneOptionalMediaPlugin()],
    define: {
        __APP_VERSION__: JSON.stringify(appVersion),
        __APP_CHANGELOG__: JSON.stringify(appChangelog),
        __BEEFTV_HEAVY_MEDIA_ENABLED__: JSON.stringify(heavyMediaEnabled),
        "import.meta.env.VITE_APP_VERSION": JSON.stringify(appVersion),
    },
    server: {
        proxy: {
            "/api": {
                target: apiProxyTarget,
                changeOrigin: true,
                xfwd: true,
                ...(desktopLaunchToken ? { headers: { "X-Desktop-Token": desktopLaunchToken } } : {}),
            },
        },
    },
    resolve: {
        alias: {
            "@": resolve(webDir, "src"),
            "@content-lock": policyModule,
            // 意图 keepers 单源（apps/web/lib/intentKeepers.ts）
            "@toiv-web": resolve(webDir, "../../web"),
        },
    },
    build: {
        // Keep the SPA route `/assets` distinct from Vite's emitted static files.
        // Otherwise vite preview treats `/assets` as the physical asset directory
        // and a direct refresh of the asset library can return 404.
        assetsDir: "static",
        rolldownOptions: {
            output: {
                strictExecutionOrder: true,
                codeSplitting: {
                    // Keep route-level lazy imports isolated. Recursively merging dependencies
                    // pulls unrelated pages into the initial modulepreload graph.
                    includeDependenciesRecursively: false,
                    minSize: 40 * 1024,
                    groups: [
                        {
                            // Shared interop helpers must not be emitted into a route entry:
                            // AntD would import that entry back and execute its bootstrap early.
                            name: "vendor-babel-runtime",
                            minSize: 0,
                            test: /node_modules[\\/]@babel[\\/]runtime[\\/]/,
                            priority: 40,
                        },
                        {
                            name: "vendor-react",
                            test: /node_modules[\\/](?:react(?:-dom|-router|-router-dom)?|scheduler|zustand|use-sync-external-store|@tanstack[\\/](?:query-core|react-query))[\\/]/,
                            priority: 30,
                        },
                        {
                            name: "vendor-icons",
                            test: /node_modules[\\/](?:lucide-react|@ant-design[\\/]icons)[\\/]/,
                            priority: 20,
                            entriesAware: true,
                            entriesAwareMergeThreshold: 48 * 1024,
                        },
                        {
                            name: "vendor-antd",
                            test: /node_modules[\\/](?:antd|@ant-design|@rc-component|rc-[^\\/]+|dayjs)[\\/]/,
                            priority: 10,
                            entriesAware: true,
                            entriesAwareMergeThreshold: 80 * 1024,
                        },
                    ],
                },
            },
        },
    },
});
