import type { ReactNode } from "react";
import { ShieldAlert } from "lucide-react";
import { useLocation, useNavigate } from "react-router";

import {
    COPY_GUARD_REASON,
    COPY_SLOT_ADULT,
    COPY_STAY_NORMAL,
    COPY_SWITCH_TO_ADULT,
    R18_SETTINGS_GATE_PATH,
    SAFE_HOME_PATH,
    r18GuardRedirect,
} from "@/redline";

/**
 * 路由守卫：普通模式下拦成人专属 location，出卡（非后端 403）。
 * 主 CTA → 设置两步闸；次 CTA → 留在普通内容。
 * 判定真源：`@/redline`。
 */
export function RequireR18({ children }: { children?: ReactNode }) {
    const location = useLocation();
    const navigate = useNavigate();
    const redirect = r18GuardRedirect({ pathname: location.pathname, search: location.search });
    if (redirect) {
        return (
            <AdultRouteGuardCard
                onSwitchToAdult={() => navigate(R18_SETTINGS_GATE_PATH)}
                onStayNormal={() => navigate(SAFE_HOME_PATH, { replace: true })}
            />
        );
    }
    return children ?? null;
}

/** 布局级守卫：包住 Outlet，按当前 URL 判定。 */
export function RedlineRouteGuard({ children }: { children: ReactNode }) {
    return <RequireR18>{children}</RequireR18>;
}

/** Wire：守卫拦截卡（slot=route_guard_adult）。 */
export function AdultRouteGuardCard({
    onSwitchToAdult,
    onStayNormal,
}: {
    onSwitchToAdult: () => void;
    onStayNormal: () => void;
}) {
    return (
        <div
            className="generation-failure-notice"
            data-failure-slot="route_guard_adult"
            data-testid="adult-route-guard-card"
            role="status"
        >
            <span className="generation-failure-slot" data-testid="generation-failure-slot">
                {COPY_SLOT_ADULT}
            </span>
            <p className="generation-failure-reason">{COPY_GUARD_REASON}</p>
            <p className="generation-failure-action">切换后由守卫放行；未切模式不得自动重进原路由。</p>
            <div className="generation-failure-actions">
                <button
                    type="button"
                    className="generation-failure-button is-primary"
                    data-testid="adult-route-guard-switch"
                    onClick={onSwitchToAdult}
                >
                    <ShieldAlert className="size-3.5" />
                    {COPY_SWITCH_TO_ADULT}
                </button>
                <button type="button" className="generation-failure-button" data-testid="adult-route-guard-stay" onClick={onStayNormal}>
                    {COPY_STAY_NORMAL}
                </button>
            </div>
        </div>
    );
}
