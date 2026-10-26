/**
 * Shot card chrome — adapted from alibaba/lumenx@f2a02e2 storyboard-r2v/ShotCard.tsx (MIT).
 * See lib/absorb/lumenx/NOTICE. Simplified shell for ToIV storyboard cells.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function StoryboardShotCardShell({
    index,
    title,
    active,
    locked,
    children,
    footer,
    className,
}: {
    index: number;
    title?: string;
    active?: boolean;
    locked?: boolean;
    children?: ReactNode;
    footer?: ReactNode;
    className?: string;
}) {
    return (
        <article
            className={cn(
                "rounded-xl border border-border/80 bg-background/80 shadow-sm overflow-hidden",
                active && "ring-1 ring-[var(--color-primary)]",
                locked && "opacity-70",
                className,
            )}
            data-shot-index={index}
            data-locked={locked || undefined}
        >
            <header className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-2">
                <div className="min-w-0">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-foreground/45">Shot {String(index + 1).padStart(2, "0")}</span>
                    {title ? <h3 className="truncate text-sm font-medium">{title}</h3> : null}
                </div>
                {locked ? <span className="text-[10px] text-foreground/45">锁定</span> : null}
            </header>
            <div className="min-h-24 p-2">{children}</div>
            {footer ? <footer className="border-t border-border/70 px-3 py-2">{footer}</footer> : null}
        </article>
    );
}
