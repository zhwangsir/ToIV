import {
    controlLampStateLabel,
    controlLampTone,
    type ControlLamp,
} from "@/services/toiv/control-readiness";
import { StatusBadge } from "@/components/ui/base/badges";

export type ControlReadinessLampsProps = {
    lamps: readonly ControlLamp[];
    className?: string;
    /** compact=仅灯点+标签；full=带 detail */
    variant?: "compact" | "full";
};

/**
 * F1 控片台就绪灯条（wind-comic）：定妆→关键帧→视频→配音→口型→合成。
 */
export function ControlReadinessLamps({
    lamps,
    className = "",
    variant = "full",
}: ControlReadinessLampsProps) {
    return (
        <div
            className={`toiv-control-lamps flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 ${className}`.trim()}
            aria-label="控片就绪灯"
            data-testid="control-readiness-lamps"
        >
            <span className="text-[11px] font-medium text-[var(--muted-foreground)]">控片就绪</span>
            <ul className="flex flex-wrap items-center gap-1.5" role="list">
                {lamps.map((lamp) => (
                    <li key={lamp.id} title={lamp.detail} data-lamp={lamp.id} data-state={lamp.state}>
                        <StatusBadge
                            variant="filled"
                            tone={controlLampTone(lamp.state)}
                            label={
                                variant === "compact"
                                    ? `${lamp.label}·${controlLampStateLabel(lamp.state)}`
                                    : `${lamp.label} ${controlLampStateLabel(lamp.state)}`
                            }
                            size="sm"
                        />
                    </li>
                ))}
            </ul>
            {variant === "full" ? (
                <p className="basis-full text-[10px] leading-4 text-[var(--muted-foreground)]" aria-live="polite">
                    {lamps.map((l) => `${l.label}:${l.detail}`).join(" · ")}
                </p>
            ) : null}
        </div>
    );
}
