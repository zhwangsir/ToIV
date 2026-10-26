import { Lock, ShieldCheck } from "lucide-react";

import { ContentModeConfirm } from "@/components/content-mode/content-mode-confirm";
import { useContentModeControl } from "@/components/content-mode/use-content-mode-control";
import { COPY_MODE_ADULT, COPY_MODE_NORMAL } from "@/redline";
import { cn } from "@/lib/utils";

/**
 * A 生产光幕芯片（TL 锁规格）：
 * 侧栏深浅色旁；高 28–32px、宽 ≈88–120px、字 12px；
 * 静止近透明细边、激活弱 fill；禁正中浮岛/大紫光晕；不挡标题。
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
