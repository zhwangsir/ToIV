import { useEffect, useRef, useState } from "react";

type BeforeInstallPromptEvent = Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: string }>;
};

const INSTALL_DISMISS_KEY = "studio.pwa.installDismissed";

/**
 * C6 全平台(2026-10-07)：PWA 安装引导 + SW 版本更新提示。
 * 挂在 application 根（路由外），底部居中浮条：
 *   · beforeinstallprompt 捕获后出「安装到桌面」引导（可本次会话关闭）；
 *   · sw.js VERSION 变更 → 新 SW waiting → 出「新版本可用」提示，点击 SKIP_WAITING
 *     并在 controllerchange 时刷新页面。
 * 移动端 Safari（无 beforeinstallprompt）不出安装条，仅共享更新条。
 */
export function PwaPrompts() {
    const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
    const [installDismissed, setInstallDismissed] = useState(false);
    const [updateReady, setUpdateReady] = useState(false);
    const waitingWorker = useRef<ServiceWorker | null>(null);
    const reloading = useRef(false);

    useEffect(() => {
        try {
            setInstallDismissed(sessionStorage.getItem(INSTALL_DISMISS_KEY) === "1");
        } catch {
            // sessionStorage 不可用（隐私模式）时按未关闭处理
        }
        const onBeforeInstall = (event: Event) => {
            event.preventDefault();
            setInstallEvent(event as BeforeInstallPromptEvent);
        };
        const onInstalled = () => setInstallEvent(null);
        window.addEventListener("beforeinstallprompt", onBeforeInstall);
        window.addEventListener("appinstalled", onInstalled);

        let registration: ServiceWorkerRegistration | undefined;
        const onControllerChange = () => {
            if (reloading.current) return;
            reloading.current = true;
            window.location.reload();
        };
        navigator.serviceWorker?.getRegistration("/studio/").then((reg) => {
            if (!reg) return;
            registration = reg;
            // 页面加载前更新已就位（检查发生在组件挂载前）：waiting 即提示
            if (reg.waiting && navigator.serviceWorker.controller) {
                waitingWorker.current = reg.waiting;
                setUpdateReady(true);
            }
            reg.addEventListener("updatefound", () => {
                const incoming = reg.installing;
                incoming?.addEventListener("statechange", () => {
                    if (incoming.state === "installed" && navigator.serviceWorker.controller) {
                        waitingWorker.current = incoming;
                        setUpdateReady(true);
                    }
                });
            });
        });
        navigator.serviceWorker?.addEventListener("controllerchange", onControllerChange);

        return () => {
            window.removeEventListener("beforeinstallprompt", onBeforeInstall);
            window.removeEventListener("appinstalled", onInstalled);
            navigator.serviceWorker?.removeEventListener("controllerchange", onControllerChange);
            void registration;
        };
    }, []);

    const dismissInstall = () => {
        setInstallDismissed(true);
        try {
            sessionStorage.setItem(INSTALL_DISMISS_KEY, "1");
        } catch {
            // 忽略
        }
    };

    const install = async () => {
        if (!installEvent) return;
        await installEvent.prompt();
        setInstallEvent(null);
    };

    const applyUpdate = () => {
        const worker = waitingWorker.current;
        if (worker) worker.postMessage({ type: "SKIP_WAITING" });
        else window.location.reload();
    };

    if (updateReady) {
        return (
            <div className="fixed bottom-6 left-1/2 z-[1200] -translate-x-1/2 rounded-full border border-[var(--border)] bg-[var(--card,#181818)] px-4 py-2.5 text-body text-[var(--foreground)] shadow-lg">
                <span className="mr-3">新版本已就绪</span>
                <button type="button" className="rounded-full bg-[var(--primary,#e0e0e0)] px-3 py-1 text-caption text-[var(--primary-foreground,#111)]" onClick={applyUpdate}>
                    刷新更新
                </button>
            </div>
        );
    }

    if (installEvent && !installDismissed) {
        return (
            <div className="fixed bottom-6 left-1/2 z-[1190] -translate-x-1/2 rounded-full border border-[var(--border)] bg-[var(--card,#181818)] px-4 py-2.5 text-body text-[var(--foreground)] shadow-lg">
                <span className="mr-3">把 ToIV Studio 安装到桌面，离线也能开</span>
                <button type="button" className="mr-2 rounded-full bg-[var(--primary,#e0e0e0)] px-3 py-1 text-caption text-[var(--primary-foreground,#111)]" onClick={install}>
                    安装
                </button>
                <button type="button" className="text-caption text-[var(--muted-foreground)]" onClick={dismissInstall}>
                    暂不
                </button>
            </div>
        );
    }

    return null;
}
