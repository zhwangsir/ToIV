/**
 * Phase strip — BigBanana-AI-Director@ead7a5c Phase 01–04 IA (Community NC: rewrite only).
 * Labels localized; no NC source copied.
 */
import { cn } from "@/lib/utils";

export type CreationPhaseId = "script" | "asset" | "keyframe" | "generate";

const PHASES: Array<{ id: CreationPhaseId; index: string; label: string; hint: string }> = [
    { id: "script", index: "01", label: "剧本", hint: "先定故事与分场" },
    { id: "asset", index: "02", label: "资产", hint: "锁角色/场景再进镜头" },
    { id: "keyframe", index: "03", label: "关键帧", hint: "镜头网格与首尾帧" },
    { id: "generate", index: "04", label: "生成", hint: "选模 → 参数 → 出片" },
];

export function CreationPhaseStrip({
    active = "generate",
    className,
    onSelect,
}: {
    active?: CreationPhaseId;
    className?: string;
    onSelect?: (id: CreationPhaseId) => void;
}) {
    return (
        <nav className={cn("toiv-creation-phase-strip", className)} aria-label="创作阶段">
            {PHASES.map((phase, i) => {
                const pressed = phase.id === active;
                return (
                    <button
                        key={phase.id}
                        type="button"
                        className={cn("toiv-creation-phase-chip", pressed && "is-active")}
                        aria-current={pressed ? "step" : undefined}
                        title={phase.hint}
                        onClick={() => onSelect?.(phase.id)}
                    >
                        <span className="toiv-creation-phase-index">{phase.index}</span>
                        <span className="toiv-creation-phase-label">{phase.label}</span>
                        {i < PHASES.length - 1 ? <span className="toiv-creation-phase-sep" aria-hidden /> : null}
                    </button>
                );
            })}
        </nav>
    );
}
