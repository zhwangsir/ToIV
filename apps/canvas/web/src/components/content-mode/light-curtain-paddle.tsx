import { Lock, ShieldCheck } from "lucide-react";

import { ContentModeConfirm } from "@/components/content-mode/content-mode-confirm";
import { useContentModeControl } from "@/components/content-mode/use-content-mode-control";
import { COPY_MODE_ADULT, COPY_MODE_NORMAL } from "@/redline";
import { cn } from "@/lib/utils";

/**
 * A 生产光幕拨片（R2 · 顶栏右一等公民）：
 * 挂载：产品顶栏右侧工具带 / 画布顶栏右簇；侧栏脚不再挂主切换。
 * 尺：高 28–32px（token 30 / compact 28）、宽 ≈88–120、字 12；
 * 动效：~200ms 弹性微光；成人态 nsfw-lock + 可选 glow-director 弱提示；禁正中浮岛。
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
