import { Lock, ShieldCheck } from "lucide-react";

import { ContentModeConfirm } from "@/components/content-mode/content-mode-confirm";
import { useContentModeControl } from "@/components/content-mode/use-content-mode-control";
import { COPY_MODE_ADULT, COPY_MODE_NORMAL } from "@/redline";
import { cn } from "@/lib/utils";

/** C — 右下相位环：刻度纹理 + 中心字模，点击切换（成人需确认）。 */
export function PhaseRing() {
    const { adultOn, confirming, select, confirmAdult, cancelConfirm, label } = useContentModeControl();

    return (
        <div className="cm-phase-ring-wrap" data-testid="content-mode-phase-ring">
            {confirming ? <ContentModeConfirm onConfirm={confirmAdult} onCancel={cancelConfirm} /> : null}
            <button
                type="button"
                className={cn("cm-phase-ring", adultOn && "is-adult")}
                aria-label={`内容模式相位环：当前${label}，点击切换`}
                aria-pressed={adultOn}
                title={`当前：${label}（点击切换）`}
                data-testid="content-mode-c-toggle"
                onClick={() => select(!adultOn)}
            >
                <svg className="cm-phase-ring-svg" viewBox="0 0 88 88" aria-hidden>
                    <circle cx="44" cy="44" r="40" fill="none" stroke={adultOn ? "rgba(139,124,255,0.45)" : "rgba(0,189,207,0.35)"} strokeWidth="2.5" strokeDasharray={adultOn ? "4 6" : "2 5"} />
                    {Array.from({ length: 12 }, (_, i) => {
                        const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
                        const r0 = 34;
                        const r1 = i % 3 === 0 ? 40 : 37;
                        const x0 = 44 + Math.cos(a) * r0;
                        const y0 = 44 + Math.sin(a) * r0;
                        const x1 = 44 + Math.cos(a) * r1;
                        const y1 = 44 + Math.sin(a) * r1;
                        return (
                            <line
                                key={i}
                                x1={x0}
                                y1={y0}
                                x2={x1}
                                y2={y1}
                                stroke={adultOn ? "rgba(217,210,255,0.55)" : "rgba(0,189,207,0.55)"}
                                strokeWidth={i % 3 === 0 ? 2 : 1}
                            />
                        );
                    })}
                </svg>
                <span className="cm-phase-ring-core">
                    <span>
                        {adultOn ? <Lock className="size-3.5" aria-hidden /> : <ShieldCheck className="size-3.5" aria-hidden />}
                        {adultOn ? COPY_MODE_ADULT : COPY_MODE_NORMAL}
                        <small>PHASE</small>
                    </span>
                </span>
            </button>
        </div>
    );
}
