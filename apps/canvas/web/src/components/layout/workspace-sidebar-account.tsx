import { LogOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import "./workspace-sidebar-account.css";
import { APP_BASE, gatePath } from "@/lib/app-base";
import { withToivAuth } from "@/services/api/request";

type GateUser = { id: string; name?: string; email?: string };

// ToIV staging: account entry for the ToIV login gate (GET /auth/me, POST /auth/logout).
// Renders nothing when the app is not behind the gate (desktop / local builds return 404/401).
export function WorkspaceSidebarAccount({ collapsed }: { collapsed?: boolean }) {
    const [user, setUser] = useState<GateUser | null>(null);
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let alive = true;
        // Staging: the gate's /auth/me. /studio (gate retired): ToIV's own /api/auth/me with the
        // shared toiv_token; Next answers /studio/auth/me with the SPA shell, so JSON parsing fails there.
        const fromGate = fetch(gatePath("/auth/me"), { credentials: "same-origin" })
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null);
        fromGate
            .then((d) => {
                if (d?.user?.id || !APP_BASE) return d?.user ?? null;
                const headers = withToivAuth();
                if (!headers.Authorization) return null; // signed out of ToIV: nothing to show
                return fetch("/api/auth/me", { credentials: "same-origin", headers })
                    .then((r) => (r.ok ? r.json() : null))
                    .then((m) => { const u = m?.user ?? m; return u?.id ? { id: String(u.id), name: u.display_name || u.name || u.username || "", email: u.email || "" } : null; })
                    .catch(() => null);
            })
            .then((u) => { if (alive && u?.id) setUser(u); })
            .catch(() => {});
        return () => { alive = false; };
    }, []);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: PointerEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false); };
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
        document.addEventListener("pointerdown", onDown);
        document.addEventListener("keydown", onKey);
        return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
    }, [open]);

    if (!user) return null;
    const label = user.email || user.name || "ToIV 用户";
    const initial = (user.name || user.email || "T").trim().charAt(0).toUpperCase();

    const logout = () => {
        fetch(gatePath("/auth/logout"), { method: "POST", credentials: "same-origin" })
            .finally(() => {
                // Under /studio the ToIV app owns login: drop its token too, then go to its login entry.
                if (APP_BASE) { try { window.localStorage.removeItem("toiv_token"); } catch { /* storage blocked */ } }
                window.location.href = APP_BASE ? "/?view=home" : "/login";
            });
    };

    return (
        <div ref={rootRef} className={cn("app-workspace-account", collapsed && "is-collapsed")}>
            <button
                type="button"
                className="app-workspace-account-trigger"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={`账号：${label}`}
                title={label}
                onClick={() => setOpen((v) => !v)}
            >
                <span className="app-workspace-account-avatar" aria-hidden="true">{initial}</span>
            </button>
            {open ? (
                <div className="app-workspace-account-menu" role="menu">
                    <div className="app-workspace-account-identity">
                        <span className="app-workspace-account-avatar" aria-hidden="true">{initial}</span>
                        <span className="app-workspace-account-text">
                            {user.name && user.name !== user.email ? <span className="app-workspace-account-name">{user.name}</span> : null}
                            <span className="app-workspace-account-email">{label}</span>
                        </span>
                    </div>
                    <button type="button" role="menuitem" className="app-workspace-account-item" onClick={logout}>
                        <LogOut className="size-4" strokeWidth={1.8} />
                        <span>退出登录</span>
                    </button>
                </div>
            ) : null}
        </div>
    );
}
