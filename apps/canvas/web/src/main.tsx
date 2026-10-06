import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import { bootstrapAppearance } from "@/services/appearance-bootstrap";
import { bootstrapDesktopRuntime } from "@/services/desktop-runtime";
import { hydrateLocalCanvasProjectsFromBackend } from "@/services/local-workspace-repository";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

async function startApplication() {
    await bootstrapDesktopRuntime();
    // 浏览器缓存晚于后端读入完成时，会用旧连接数组盖掉刚合并的画布。
    await useCanvasStore.persist.rehydrate();
    await hydrateLocalCanvasProjectsFromBackend();
    await bootstrapAppearance().finally(() => import("./application"));
}

void startApplication();

// C6 全平台(2026-10-07)：/studio 生产挂载下注册 PWA service worker（安装壳+深链离线可达）。
// 桌面(Wails)/本地预览/开发模式不注册；sw.js 由 public/ 原样进入 dist，scope=/studio/。
if (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    import.meta.env.PROD &&
    typeof window !== "undefined" &&
    window.location.pathname.startsWith("/studio")
) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("/studio/sw.js", { scope: "/studio/" }).catch(() => {
            // 注册失败不影响应用本身（离线壳是增强能力）
        });
    });
}
