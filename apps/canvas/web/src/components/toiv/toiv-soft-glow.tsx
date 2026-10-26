import { useCallback, useState, type CSSProperties, type HTMLAttributes, type PointerEvent } from "react";

import { cn } from "@/lib/utils";

import "@/components/toiv/toiv-empty-loading.css";

type Props = HTMLAttributes<HTMLDivElement> & {
    /** Disable pointer tracking (still allows CSS hover fade). */
    trackPointer?: boolean;
};

/**
 * Restrained Freezone pointer glow.
 * Color from --toiv-glow-color (accent mix) — never adult #4f8cff.
 */
export function ToivSoftGlow({ trackPointer = true, className, style, onPointerMove, onPointerLeave, children, ...props }: Props) {
    const [active, setActive] = useState(false);
    const [vars, setVars] = useState<CSSProperties>({});

    const handleMove = useCallback(
        (event: PointerEvent<HTMLDivElement>) => {
            onPointerMove?.(event);
            if (!trackPointer) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * 100;
            const y = ((event.clientY - rect.top) / Math.max(1, rect.height)) * 100;
            setVars({ ["--toiv-glow-x" as string]: `${x}%`, ["--toiv-glow-y" as string]: `${y}%` });
            setActive(true);
        },
        [onPointerMove, trackPointer],
    );

    const handleLeave = useCallback(
        (event: PointerEvent<HTMLDivElement>) => {
            onPointerLeave?.(event);
            setActive(false);
        },
        [onPointerLeave],
    );

    return (
        <div
            className={cn("toiv-soft-glow", active && "is-active", className)}
            style={{ ...vars, ...style }}
            onPointerMove={handleMove}
            onPointerLeave={handleLeave}
            {...props}
        >
            {children}
        </div>
    );
}
