import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";

import { r18GuardRedirect } from "@/redline";

/**
 * 路由守卫：未开 R18 时把 NSFW 专属 location 重定向到设置两步闸。
 * 判定真源：`@/redline`（后端不再 403 拦截）。
 */
export function RequireR18({ children }: { children?: ReactNode }) {
    const location = useLocation();
    const redirect = r18GuardRedirect({ pathname: location.pathname, search: location.search });
    if (redirect) {
        return <Navigate to={redirect} replace state={{ from: `${location.pathname}${location.search}`, redline: true }} />;
    }
    return children ?? null;
}

/** 布局级守卫：包住 Outlet，按当前 URL 判定。 */
export function RedlineRouteGuard({ children }: { children: ReactNode }) {
    return <RequireR18>{children}</RequireR18>;
}
