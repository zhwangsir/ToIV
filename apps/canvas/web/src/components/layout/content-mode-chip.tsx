import { ShieldAlert } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Link } from "react-router";

import { cn } from "@/lib/utils";
import {
    COPY_MODE_ADULT,
    COPY_MODE_NORMAL,
    R18_SETTINGS_GATE_PATH,
    getR18ModeSnapshot,
    getServerR18ModeSnapshot,
    subscribeR18Mode,
} from "@/redline";

/**
 * 主壳模式态：一眼可读「普通|成人」，点击进设置两步闸。
 * 挂在侧栏账户区旁；点击进设置两步闸（普通|成人）。
 */
export function ContentModeChip({ collapsed }: { collapsed?: boolean }) {
    const adultOn = useSyncExternalStore(subscribeR18Mode, getR18ModeSnapshot, getServerR18ModeSnapshot);
    const label = adultOn ? COPY_MODE_ADULT : COPY_MODE_NORMAL;
    return (
        <Link
            to={R18_SETTINGS_GATE_PATH}
            className={cn("app-workspace-content-mode-chip", collapsed && "is-collapsed", adultOn && "is-adult")}
            aria-label={`内容模式：${label}，点击前往设置切换`}
            title={`内容模式：${label}`}
            data-testid="content-mode-chip"
            data-mode={adultOn ? "adult" : "normal"}
        >
            <ShieldAlert className="size-3.5 shrink-0" strokeWidth={1.8} aria-hidden />
            {!collapsed ? <span className="app-workspace-content-mode-chip-label">{label}</span> : null}
        </Link>
    );
}
