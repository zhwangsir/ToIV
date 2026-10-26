import { Lock, ShieldCheck } from "lucide-react";

import { ContentModeConfirm } from "@/components/content-mode/content-mode-confirm";
import { useContentModeControl } from "@/components/content-mode/use-content-mode-control";
import { COPY_MODE_ADULT, COPY_MODE_NORMAL } from "@/redline";
import { cn } from "@/lib/utils";

/**
 * R2 TL · 顶栏右 quiet segmented pill「普通｜成人」+ 滑动 thumb。
 * Token: --toiv-switch-*；轨高 28 / minW 108；普通无 glow；成人 #4f8cff glow。
 * 禁 iOS 大开关 / 整页 View Transition / 设置页主入口。
 */
export function LightCurtainPaddle({ compact }: { compact?: boolean }) {
    const { adultOn, confirming, select, confirmAdult, cancelConfirm } = useContentModeControl();

    return (
        <div
            className={cn("cm-light-curtain", compact && "is-compact")}
            data-testid="content-mode-light-curtain"
        >
            <div
                className={cn("cm-light-curtain-rail", adultOn && "is-adult")}
                role="group"
                aria-label="内容模式光幕拨片"
            >
                <span className="cm-light-curtain-veil" aria-hidden />
                <button
                    type="button"
                    className={cn("cm-light-curtain-opt", !adultOn && "is-active")}
                    aria-pressed={!adultOn}
                    data-testid="content-mode-a-ordinary"
                    title={COPY_MODE_NORMAL}
                    onClick={() => select(false)}
                >
                    <ShieldCheck aria-hidden />
                    {!compact ? <span>{COPY_MODE_NORMAL}</span> : null}
                </button>
                <button
                    type="button"
                    className={cn("cm-light-curtain-opt", adultOn && "is-active")}
                    aria-pressed={adultOn}
                    data-testid="content-mode-a-adult"
                    title={COPY_MODE_ADULT}
                    onClick={() => select(true)}
                >
                    <Lock aria-hidden />
                    {!compact ? <span>{COPY_MODE_ADULT}</span> : null}
                </button>
            </div>
            {confirming ? <ContentModeConfirm onConfirm={confirmAdult} onCancel={cancelConfirm} /> : null}
        </div>
    );
}
