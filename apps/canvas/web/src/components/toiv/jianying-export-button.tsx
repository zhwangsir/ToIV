/**
 * F4：合成段「导出剪映草稿」——触发 ZIP 下载。
 */
import { Download } from "lucide-react";
import { useCallback, useState } from "react";

import { ToolButton } from "@/components/ui/base/buttons";
import { exportStudioJianyingDraft } from "@/services/toiv/client";
import {
    JIANYING_EXPORT_HINT,
    JIANYING_EXPORT_LABEL,
    canExportJianyingDraft,
    triggerBlobDownload,
    type JianyingExportShotLike,
} from "@/services/toiv/jianying-draft";

type Props = {
    projectId: string;
    shots: readonly JianyingExportShotLike[];
    disabled?: boolean;
};

export function JianyingExportButton({ projectId, shots, disabled }: Props) {
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<string | null>(null);
    const [err, setErr] = useState<string | null>(null);
    const ready = canExportJianyingDraft(shots);

    const onExport = useCallback(async () => {
        if (!ready) {
            setErr("暂无成片片段，请先完成镜头并合成或至少就绪 final_clip");
            return;
        }
        setBusy(true);
        setErr(null);
        setMsg(null);
        try {
            const { blob, fileName, format } = await exportStudioJianyingDraft(projectId, {
                include_media: true,
            });
            triggerBlobDownload(blob, fileName);
            setMsg(`已下载 ${fileName}（${format}）。${JIANYING_EXPORT_HINT}`);
        } catch (e) {
            setErr(e instanceof Error ? e.message : "剪映草稿导出失败");
        } finally {
            setBusy(false);
        }
    }, [projectId, ready]);

    return (
        <div className="flex w-full flex-col gap-1.5">
            <ToolButton
                variant="ghost"
                icon={<Download />}
                label={busy ? "导出中…" : JIANYING_EXPORT_LABEL}
                loading={busy}
                disabled={disabled || busy || !ready}
                onClick={() => void onExport()}
            />
            <p className="text-[11px] leading-relaxed text-[var(--muted-foreground)]">{JIANYING_EXPORT_HINT}</p>
            {err && <p className="text-xs text-[var(--danger)]">{err}</p>}
            {msg && <p className="text-xs text-foreground">{msg}</p>}
        </div>
    );
}
