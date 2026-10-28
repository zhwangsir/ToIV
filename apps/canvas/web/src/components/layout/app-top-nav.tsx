import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";

import { ModelSetupGuide } from "@/components/layout/model-setup-guide";
import { WorkspaceSidebarNav } from "@/components/layout/workspace-sidebar-nav";
import { WorkspaceTopBar } from "@/components/layout/workspace-top-bar";
import { WorkspaceTopBarExtensionProvider } from "@/components/layout/workspace-top-bar-extension";
import { readWorkspaceSidebarCollapsed, writeWorkspaceSidebarCollapsed } from "@/components/layout/workspace-sidebar-state";
import { useDesktopUpdateBootstrap } from "@/hooks/use-desktop-update";
import { cn } from "@/lib/utils";
import { isSpatialWorkbenchPath } from "@/lib/workspace-routes";
import { useUserStore } from "@/stores/use-user-store";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";

const WorkspaceCommandPalette = lazy(() => import("@/components/layout/workspace-command-palette").then((module) => ({ default: module.WorkspaceCommandPalette })));

/** ToIV 登录后根壳（B1 250/67/56 · A6 配色）。DesktopShell 属 Cosmos 种子，默认不套。 */
export function AppWorkspaceShell({ children }: { children: ReactNode }) {
    const { pathname } = useLocation();
    const navigate = useNavigate();
    const [mobileSidebarExpanded, setMobileSidebarExpanded] = useState(false);
    const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = useState(readWorkspaceSidebarCollapsed);
    const [creationSidebarExpanded, setCreationSidebarExpanded] = useState(false);
    const [paletteOpen, setPaletteOpen] = useState(false);
    const sessionHydrated = useUserStore((state) => state.hydrated);
    const storageMode = useUserStore((state) => state.storageMode);
    const user = useUserStore((state) => state.user);
    const localMode = isLocalWorkspaceMode() || storageMode === "local" || user?.username === "local";
    useDesktopUpdateBootstrap();

    const hideChrome = pathname.startsWith("/admin") || /^\/canvas\/[^/]+/.test(pathname);
    const spatialWorkbench = isSpatialWorkbenchPath(pathname);
    const creationWorkspace = pathname === "/create";
    const sidebarCollapsed = creationWorkspace ? !creationSidebarExpanded : desktopSidebarCollapsed;

    const isMobileViewport = () => window.innerWidth < 1024;

    const toggleSidebar = () => {
        if (isMobileViewport()) {
            setMobileSidebarExpanded((current) => !current);
            return;
        }
        if (creationWorkspace) {
            setCreationSidebarExpanded((current) => !current);
            return;
        }
        setDesktopSidebarCollapsed((current) => {
            const next = !current;
            writeWorkspaceSidebarCollapsed(next);
            return next;
        });
    };

    const expandDesktopSidebar = () => {
        setCreationSidebarExpanded(true);
        setDesktopSidebarCollapsed(false);
        writeWorkspaceSidebarCollapsed(false);
    };

    const collapseDesktopSidebar = () => {
        setCreationSidebarExpanded(false);
        setDesktopSidebarCollapsed(true);
        writeWorkspaceSidebarCollapsed(true);
    };

    const handleNavClick = () => {
        if (isMobileViewport()) setMobileSidebarExpanded(false);
    };

    // ⌘K / Ctrl+K 全局呼出搜索面板。
    useEffect(() => {
        const handler = (event: KeyboardEvent) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
                event.preventDefault();
                setPaletteOpen((open) => !open);
            }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, []);

    useEffect(() => {
        const handleWorkspaceNavigation = (rawEvent: Event) => {
            const event = rawEvent as CustomEvent<{ to?: string }>;
            if (!event.detail?.to) return;
            event.preventDefault();
            navigate(event.detail.to);
        };
        window.addEventListener("workspace:navigate", handleWorkspaceNavigation);
        return () => window.removeEventListener("workspace:navigate", handleWorkspaceNavigation);
    }, [navigate]);

    return (
        <WorkspaceTopBarExtensionProvider>
            <div className={cn("app-workspace-shell flex h-full min-h-0 w-full flex-col overflow-hidden", spatialWorkbench && "is-spatial", creationWorkspace && "is-creation-workspace")} data-window-chrome="1">
                {!hideChrome && mobileSidebarExpanded ? <button type="button" className="app-workspace-sidebar-scrim lg:hidden" aria-label="收起侧栏" onClick={() => setMobileSidebarExpanded(false)} /> : null}

                <div className="app-workspace-main-row flex min-h-0 min-w-0 flex-1 overflow-hidden">
                    {!hideChrome ? (
                        <aside
                            className={cn(
                                "app-workspace-sidebar flex h-full shrink-0 flex-col overflow-hidden",
                                mobileSidebarExpanded && "is-mobile-expanded",
                                sidebarCollapsed && "is-collapsed",
                            )}
                        >
                            <WorkspaceSidebarNav
                                collapsed={sidebarCollapsed}
                                onNavigate={handleNavClick}
                                onOpenSearch={() => setPaletteOpen(true)}
                                onExpand={expandDesktopSidebar}
                                onCollapse={collapseDesktopSidebar}
                            />
                        </aside>
                    ) : null}

                    <div className="app-workspace-stage relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                        {!hideChrome ? (
                            <WorkspaceTopBar
                                sidebarOpen={mobileSidebarExpanded || !sidebarCollapsed}
                                onToggleSidebar={toggleSidebar}
                            />
                        ) : null}
                        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">{children}</div>
                    </div>
                </div>

                {paletteOpen ? <Suspense fallback={null}><WorkspaceCommandPalette open onClose={() => setPaletteOpen(false)} /></Suspense> : null}
            </div>
            <ModelSetupGuide hidden={!sessionHydrated || localMode || pathname === "/login" || pathname === "/register" || pathname.startsWith("/admin") || pathname.startsWith("/assets")} />
        </WorkspaceTopBarExtensionProvider>
    );
}
