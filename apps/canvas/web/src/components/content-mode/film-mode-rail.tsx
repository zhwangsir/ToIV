import { Film, Lock, ShieldCheck } from "lucide-react";

import { ContentModeConfirm } from "@/components/content-mode/content-mode-confirm";
import { useContentModeControl } from "@/components/content-mode/use-content-mode-control";
import { COPY_MODE_ADULT, COPY_MODE_NORMAL } from "@/redline";
import { cn } from "@/lib/utils";

/** B — 胶片双轨：齿孔条 + 普通哑光灰青 / 成人暗紫锁标镂空感。 */
export function FilmModeRail({ collapsed }: { collapsed?: boolean }) {
    const { adultOn, confirming, select, confirmAdult, cancelConfirm, label } = useContentModeControl();

    return (
        <div
            className={cn("cm-film-rail", collapsed && "is-collapsed")}
            data-testid="content-mode-film-rail"
            aria-label={`内容模式胶片轨：当前${label}`}
        >
            <div className="cm-film-strip" role="group" aria-label="胶片双轨内容模式">
                <button
                    type="button"
                    className={cn("cm-film-frame", !adultOn && "is-active")}
                    data-track="ordinary"
                    aria-pressed={!adultOn}
                    title={`${COPY_MODE_NORMAL}模式`}
                    data-testid="content-mode-b-ordinary"
                    onClick={() => select(false)}
                >
                    <ShieldCheck aria-hidden />
                    <span>{COPY_MODE_NORMAL}</span>
                </button>
                <button
                    type="button"
                    className={cn("cm-film-frame", adultOn && "is-active")}
                    data-track="adult"
                    aria-pressed={adultOn}
                    title={`${COPY_MODE_ADULT}模式`}
                    data-testid="content-mode-b-adult"
                    onClick={() => select(true)}
                >
                    <Lock aria-hidden />
                    <Film aria-hidden className="opacity-70" />
                    <span>{COPY_MODE_ADULT}</span>
                </button>
            </div>
            {confirming ? <ContentModeConfirm onConfirm={confirmAdult} onCancel={cancelConfirm} /> : null}
        </div>
    );
}
