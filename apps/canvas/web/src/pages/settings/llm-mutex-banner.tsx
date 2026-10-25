import { AlertTriangle } from "lucide-react";

import { LLM_MUTEX_BANNER, textModelLooksLikeLegacyDsv4, textModelLooksLikeMia } from "@/lib/model-mix-presets";
import type { AiConfig } from "@/stores/use-config-store";

export function LlmMutexBanner({ config }: { config: AiConfig }) {
    const mia = textModelLooksLikeMia(config);
    const dsv4 = textModelLooksLikeLegacyDsv4(config);
    const tone = dsv4 ? "warn-dsv4" : "info";
    return (
        <aside
            className="settings-mutex-note"
            role="note"
            data-testid="llm-mutex-banner"
            data-tone={tone}
        >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 opacity-70" aria-hidden />
            <div className="min-w-0">
                <p>
                    <span className="font-medium text-foreground/75">同卡互斥 · </span>
                    {LLM_MUTEX_BANNER}
                </p>
                <p className="mt-1 text-[11px] text-foreground/45">
                    当前对话槽：{mia ? "Mia 主路" : dsv4 ? "旧版 dsv4 别名" : "未识别 / 自定义"}
                </p>
            </div>
        </aside>
    );
}
