import type { ReactNode } from "react";
import { Link } from "react-router";

import { TOIV_TASKS_PATH } from "@/services/toiv/client-timeout";

/** 超时感知统一入口：去任务中心（与侧栏 /toiv/tasks 同源）。 */
export function TasksCenterLink({ className, children }: { className?: string; children?: ReactNode }) {
    return (
        <Link to={TOIV_TASKS_PATH} className={className ?? "underline underline-offset-2 text-foreground"}>
            {children ?? "去任务中心"}
        </Link>
    );
}
