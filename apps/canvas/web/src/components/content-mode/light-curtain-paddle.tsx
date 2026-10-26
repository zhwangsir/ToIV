import { Lock, ShieldAlert, ShieldCheck } from "lucide-react";

import { ContentModeConfirm } from "@/components/content-mode/content-mode-confirm";
import { useContentModeControl } from "@/components/content-mode/use-content-mode-control";
import { COPY_MODE_ADULT, COPY_MODE_NORMAL } from "@/redline";
import { cn } from "@/lib/utils";

/** A — 顶栏光幕拨片：哑光青幕 / 暗紫锁幕，文案+图标双通道。 */
export function LightCurtainPaddle() {
    const { adultOn, confirming, select, confirmAdult, cancelConfirm } = useContentModeControl();

    return (
        <div className="cm-light-curtain" data-testid="content-mode-light-curtain">
            <div className={cn("cm-light-curtain-rail", adultOn && "is-adult")} role="group" aria-label="内容模式光幕拨片">
                <span className="cm-light-curtain-veil" aria-hidden />
                <button
                    type="button"
                    className={cn("cm-light-curtain-opt", !adultOn && "is-active")}
                    aria-pressed={!adultOn}
                    data-testid="content-mode-a-ordinary"
                    onClick={() => select(false)}
                >
                    <ShieldCheck aria-hidden />
                    <span>{COPY_MODE_NORMAL}</span>
                </button>
                <button
                    type="button"
                    className={cn("cm-light-curtain-opt", adultOn && "is-active")}
                    aria-pressed={adultOn}
                    data-testid="content-mode-a-adult"
                    onClick={() => select(true)}
                >
                    <ShieldAlert aria-hidden />
                    <Lock aria-hidden className="opacity-80" />
                    <span>{COPY_MODE_ADULT}</span>
                </button>
            </div>
            <span className="cm-light-curtain-hint" aria-hidden>
                light curtain · 光幕
            </span>
            {confirming ? <ContentModeConfirm onConfirm={confirmAdult} onCancel={cancelConfirm} /> : null}
        </div>
    );
}
