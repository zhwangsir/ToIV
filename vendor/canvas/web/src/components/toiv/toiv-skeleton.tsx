import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

import "@/components/toiv/toiv-empty-loading.css";

export function ToivSkeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return <div className={cn("toiv-skeleton", className)} aria-hidden {...props} />;
}

/** Local media-pool / card grid placeholder — never a full-page spinner. */
export function ToivSkeletonGrid({ count = 8, className }: { count?: number; className?: string }) {
    return (
        <div className={cn("toiv-skeleton-grid", className)} role="status" aria-label="加载中" data-testid="toiv-skeleton-grid">
            {Array.from({ length: count }, (_, i) => (
                <ToivSkeleton key={i} className="toiv-skeleton-card" />
            ))}
        </div>
    );
}

/** Queue / list row placeholders. */
export function ToivSkeletonList({ rows = 4, className }: { rows?: number; className?: string }) {
    return (
        <div className={cn("toiv-skeleton-list", className)} role="status" aria-label="加载中" data-testid="toiv-skeleton-list">
            {Array.from({ length: rows }, (_, i) => (
                <ToivSkeleton key={i} className="toiv-skeleton-list-row" />
            ))}
        </div>
    );
}

/** Create center-stage Suspense fallback — skeleton pane, not full-screen spinner. */
export function ToivSkeletonPane({ className }: { className?: string }) {
    return (
        <div className={cn("toiv-skeleton-pane", className)} role="status" aria-label="正在打开创作台" data-testid="toiv-skeleton-pane">
            <ToivSkeleton className="toiv-skeleton-pane-bar" />
            <div className="toiv-skeleton-stack">
                <ToivSkeleton className="toiv-skeleton-line is-mid" />
                <ToivSkeleton className="toiv-skeleton-line" />
                <ToivSkeleton className="toiv-skeleton-line is-short" />
            </div>
            <ToivSkeletonGrid count={6} />
        </div>
    );
}
