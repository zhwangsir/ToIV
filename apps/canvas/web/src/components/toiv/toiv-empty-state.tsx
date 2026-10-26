import type { HTMLAttributes, ReactNode } from "react";
import { Inbox, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

import "@/components/toiv/toiv-empty-loading.css";

export type ToivEmptyStateProps = HTMLAttributes<HTMLDivElement> & {
    icon?: LucideIcon;
    title?: ReactNode;
    description?: ReactNode;
    action?: ReactNode;
    compact?: boolean;
};

/** Freezone empty — neutral copy, accent icon ring; not a full-screen spinner. */
export function ToivEmptyState({
    icon: Icon = Inbox,
    title,
    description,
    action,
    compact = false,
    className,
    ...props
}: ToivEmptyStateProps) {
    return (
        <div
            data-slot="toiv-empty"
            className={cn("toiv-empty", compact && "is-compact", className)}
            {...props}
        >
            <div className="toiv-empty-icon" aria-hidden>
                <Icon strokeWidth={1.75} />
            </div>
            {title != null ? <p className="toiv-empty-title">{title}</p> : null}
            {description != null ? <div className="toiv-empty-desc">{description}</div> : null}
            {action != null ? <div className="toiv-empty-action">{action}</div> : null}
        </div>
    );
}
