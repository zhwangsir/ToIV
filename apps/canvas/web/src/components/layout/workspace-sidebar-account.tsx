import { LogOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import "./workspace-sidebar-account.css";

type GateUser = { id: string; name?: string; email?: string };

// ToIV staging: account entry for the ToIV login gate (GET /auth/me, POST /auth/logout).
// Renders nothing when the app is not behind the gate (desktop / local builds return 404/401).
export function WorkspaceSidebarAccount({ collapsed }: { collapsed?: boolean }) {
    const [user, setUser] = useState<GateUser | null>(null);
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let alive = true;
        fetch("/auth/me", { credentials: "same-origin" })
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => { if (alive && d?.user?.id) setUser(d.user); })
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
        fetch("/auth/logout", { method: "POST", credentials: "same-origin" })
            .finally(() => { window.location.href = "/login"; });
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
