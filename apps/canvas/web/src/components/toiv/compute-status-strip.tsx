import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";

import {
    fetchFleetBrief,
    fetchStudioDepsStatus,
    type ToivDepItem,
    type ToivFleetBrief,
} from "@/services/toiv/client";

export type ComputeStatusStripProps = {
    /** 紧凑：单行；完整：含依赖三态 */
    variant?: "compact" | "full";
    className?: string;
    onDeps?: (deps: ToivDepItem[]) => void;
};

/**
 * Wave P1.5：L1 忙闲 + L5 依赖三态只读条。不展示端口。
 */
export function ComputeStatusStrip({ variant = "compact", className = "", onDeps }: ComputeStatusStripProps) {
    const [brief, setBrief] = useState<ToivFleetBrief | null>(null);
    const [deps, setDeps] = useState<ToivDepItem[]>([]);
    const [error, setError] = useState(false);

    const load = useCallback(async () => {
        setError(false);
        try {
            const [b, d] = await Promise.all([
                fetchFleetBrief().catch(() => null),
                fetchStudioDepsStatus().catch(() => null),
            ]);
            if (b) setBrief(b);
            if (d?.deps) {
                setDeps(d.deps);
                onDeps?.(d.deps);
            }
        } catch {
            setError(true);
        }
    }, [onDeps]);

    useEffect(() => {
        void load();
        const t = window.setInterval(() => void load(), 30_000);
        return () => window.clearInterval(t);
    }, [load]);

    const summary = brief?.summary
        || (error ? "算力状态暂时读不到，可稍后刷新。" : "正在读取本地算力状态…");

    return (
        <div className={`toiv-compute-strip ${className}`.trim()} aria-label="算力与依赖状态" data-level={brief?.level || "unknown"}>
            <p className="toiv-compute-strip-summary" aria-live="polite">{summary}</p>
            {variant === "full" && deps.length > 0 ? (
                <ul className="toiv-compute-strip-deps" aria-label="依赖三态">
                    {deps.map((d) => (
                        <li key={d.id} data-state={d.state} title={d.summary}>
                            <span className="toiv-compute-strip-dep-label">{d.label}</span>
                            <span className="toiv-compute-strip-dep-state">
                                {d.state === "reachable" ? "可用" : d.state === "degraded" ? "降级" : "不可用"}
                            </span>
                        </li>
                    ))}
                </ul>
            ) : null}
            <Link to="/settings?section=channels" className="toiv-compute-strip-link">模型与算力</Link>
        </div>
    );
}

export function depBlocksCta(deps: ToivDepItem[], id: "tts" | "h3" | "api"): { blocked: boolean; hint: string } {
    const hit = deps.find((d) => d.id === id);
    if (!hit || hit.state !== "unreachable") return { blocked: false, hint: "" };
    return { blocked: true, hint: hit.blocked_hint || hit.summary };
}
