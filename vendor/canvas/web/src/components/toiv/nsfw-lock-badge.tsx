/**
 * 普通态 NSFW 列表行：灰化 + 锁图标 + 「NSFW」文字（禁只靠颜色）。
 */
import { Lock } from "lucide-react";

import { cn } from "@/lib/utils";
import { COPY_ASSET_LOCKED_HINT, COPY_LOCKED_LABEL, COPY_NSFW_LOCK_LABEL } from "@/redline";

type Props = {
    className?: string;
    /** 紧凑：仅图标+标签 */
    compact?: boolean;
};

export function NsfwLockBadge({ className, compact }: Props) {
    return (
        <span
            className={cn("toiv-nsfw-lock-badge", compact && "is-compact", className)}
            data-testid="nsfw-lock-badge"
            title={COPY_ASSET_LOCKED_HINT || undefined}
            aria-label={[COPY_LOCKED_LABEL, COPY_NSFW_LOCK_LABEL].filter(Boolean).join(" · ")}
        >
            <Lock className="size-3 shrink-0" strokeWidth={2} aria-hidden />
            <span className="toiv-nsfw-lock-badge-label">{COPY_NSFW_LOCK_LABEL}</span>
        </span>
    );
}
