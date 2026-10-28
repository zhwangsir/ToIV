import { useEffect, useLayoutEffect, useMemo, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";

import { AppWorkspaceShell } from "@/components/layout/app-top-nav";
import { DesktopIcons } from "@/components/desktop/desktop-icons";
import { DesktopStartMenu } from "@/components/desktop/desktop-start-menu";
import { DesktopTaskbar } from "@/components/desktop/desktop-taskbar";
import { DesktopWindowFrame } from "@/components/desktop/desktop-window";
import { DEFAULT_THEME_ID, getAppDef, resolveAppIdByPath } from "@/lib/desktop/catalog";
import { syncDesktopRoute, useDesktopStore } from "@/stores/use-desktop-store";
import { cn } from "@/lib/utils";
import "@/styles/desktop-shell.css";

/**
 * DesktopShell (方案 A · M1骨架 + M2真封装)
 * - 根壳：桌面网格 + 开始 + 任务栏 + 窗管
 * - AppWorkspaceShell 仅作窗内 chrome（B1 250/67/56）；桌面无双壳侧栏
 * - M2 首批：create/drama/tasks/market-tools/settings/library 单例进窗
 * - M2.1：可卸未装深链不静默装回 → 跳转应用商店 + toast
 * - 皮肤：themeId 默认 toiv-noir；只动 chrome，App 内容区仍 BeefTV+A6
 * - COSMOS_SEED：默认不挂根壳；品牌种子文案 ToIV（Cosmos 新项目另挂）
 */
export function DesktopShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const themeId = useDesktopStore((s) => s.prefs.themeId) || DEFAULT_THEME_ID;
  const startOpen = useDesktopStore((s) => s.startOpen);
  const setStartOpen = useDesktopStore((s) => s.setStartOpen);
  const stack = useDesktopStore((s) => s.windows.stack);
  const focusedId = useDesktopStore((s) => s.windows.focusedId);
  const openApp = useDesktopStore((s) => s.openApp);
  const notice = useDesktopStore((s) => s.notice);
  const clearNotice = useDesktopStore((s) => s.clearNotice);
  const focusWindow = useDesktopStore((s) => s.focusWindow);
  const minimizeWindow = useDesktopStore((s) => s.minimizeWindow);
  const maximizeWindow = useDesktopStore((s) => s.maximizeWindow);
  const restoreWindow = useDesktopStore((s) => s.restoreWindow);
  const closeWindow = useDesktopStore((s) => s.closeWindow);

  const routeAppId = resolveAppIdByPath(pathname);
  const isDesktopHome = pathname === "/" || pathname === "";

  // M2：深链与窗态同步放 layout，避免首帧无窗
  // M2.1：可卸未装 → denied → replace 到应用商店（可带 ?app= 高亮卡片）
  useLayoutEffect(() => {
    if (isDesktopHome) return;
    const result = syncDesktopRoute(pathname, search);
    if (result.status === "denied") {
      navigate(`/desktop/store?app=${encodeURIComponent(result.appId)}`, { replace: true });
    }
  }, [pathname, search, isDesktopHome, navigate]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => clearNotice(), 3200);
    return () => window.clearTimeout(t);
  }, [notice, clearNotice]);

  const focused = useMemo(() => stack.find((w) => w.instanceId === focusedId) ?? null, [stack, focusedId]);
  const visibleWindows = stack.filter((w) => w.state !== "minimized");

  const launch = (appId: string) => {
    const def = getAppDef(appId);
    if (!def) return;
    const instanceId = openApp(appId, def.entry);
    if (!instanceId) {
      navigate(`/desktop/store?app=${encodeURIComponent(appId)}`);
      setStartOpen(false);
      return;
    }
    navigate(def.entry);
    setStartOpen(false);
  };

  const handleTaskClick = (instanceId: string) => {
    const win = stack.find((w) => w.instanceId === instanceId);
    if (!win) return;
    if (win.state === "minimized") {
      restoreWindow(instanceId);
      navigate(win.entry);
      return;
    }
    if (win.instanceId === focusedId) {
      minimizeWindow(instanceId);
      const next = useDesktopStore.getState().windows.focusedId;
      const nextWin = useDesktopStore.getState().windows.stack.find((w) => w.instanceId === next);
      navigate(nextWin?.entry ?? "/");
      return;
    }
    focusWindow(instanceId);
    navigate(win.entry);
  };

  const handleClose = (instanceId: string) => {
    const wasFocused = focusedId === instanceId;
    closeWindow(instanceId);
    if (!wasFocused) return;
    const next = useDesktopStore.getState().windows.focusedId;
    const nextWin = useDesktopStore.getState().windows.stack.find((w) => w.instanceId === next && w.state !== "minimized");
    navigate(nextWin?.entry ?? "/");
  };

  const handleMinimize = (instanceId: string) => {
    minimizeWindow(instanceId);
    const next = useDesktopStore.getState().windows.focusedId;
    const nextWin = useDesktopStore.getState().windows.stack.find((w) => w.instanceId === next);
    navigate(nextWin?.entry ?? "/");
  };

  const showLiveContent = Boolean(routeAppId && focused && focused.appId === routeAppId && focused.state !== "minimized");

  /** canvas editor: still keep taskbar (TL); chrome hide stays inside AppWorkspaceShell */
  const wrapWithAppChrome = (node: ReactNode) => {
    const def = routeAppId ? getAppDef(routeAppId) : null;
    if (!def || def.chrome === "none" || def.chrome === "store") {
      return <div className="h-full min-h-0 overflow-hidden">{node}</div>;
    }
    return <AppWorkspaceShell>{node}</AppWorkspaceShell>;
  };

  return (
    <div className={cn("toiv-desktop-shell")} data-theme={themeId} data-desktop-shell="m2.1">
      {notice ? (
        <div className="toiv-desktop-toast" role="status" data-notice={notice.kind}>
          {notice.message}
          <button type="button" className="toiv-desktop-toast__go" onClick={() => navigate(`/desktop/store?app=${encodeURIComponent(notice.appId)}`)}>
            打开应用商店
          </button>
        </div>
      ) : null}
      <div className="toiv-desktop-stage">
        <DesktopIcons onOpen={launch} />

        <div className="toiv-desktop-windows" aria-live="polite">
          {visibleWindows.map((win) => {
            const isActiveContent = showLiveContent && win.instanceId === focused?.instanceId;
            return (
              <DesktopWindowFrame
                key={win.instanceId}
                win={win}
                focused={win.instanceId === focusedId}
                activeContent={isActiveContent}
                onFocus={() => {
                  focusWindow(win.instanceId);
                  if (win.entry && win.entry !== `${pathname}${search}`) navigate(win.entry);
                }}
                onMinimize={() => handleMinimize(win.instanceId)}
                onToggleMaximize={() => (win.state === "maximized" ? restoreWindow(win.instanceId) : maximizeWindow(win.instanceId))}
                onClose={() => handleClose(win.instanceId)}
              >
                {isActiveContent ? wrapWithAppChrome(children) : null}
              </DesktopWindowFrame>
            );
          })}
        </div>

        {startOpen ? (
          <DesktopStartMenu
            onOpen={launch}
            onOpenStore={() => launch("app-store")}
          />
        ) : null}
      </div>

      <DesktopTaskbar
        onStart={() => setStartOpen(!startOpen)}
        onTaskClick={handleTaskClick}
        onOpenPinned={launch}
      />

      {/* Desktop home: no window — children (empty host) not painted in stage */}
      {isDesktopHome ? <div className="sr-only">{children}</div> : null}
    </div>
  );
}
