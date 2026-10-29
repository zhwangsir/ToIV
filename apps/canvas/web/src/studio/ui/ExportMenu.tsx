import { useState } from "react";
import {
    exportStudioMultitrackBundle, exportStudioTimelineEdl, exportStudioTimelineFcpxml, studioExportMenuModel,
    type StudioExportAction,
} from "@/services/toiv/multitrack-export";
import { exportStudioJianyingDraft } from "@/services/toiv/client";
import { triggerBlobDownload } from "@/services/toiv/jianying-draft";

export function ExportMenu({ projectId, ready, onResult }: { projectId: string; ready: boolean; onResult: (text: string, warn?: boolean) => void }) {
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const items = studioExportMenuModel({ ready, busy });
    const run = async (key: StudioExportAction, label: string) => {
        setBusy(true);
        try {
            if (key === "jianying") {
                const draft = await exportStudioJianyingDraft(projectId);
                triggerBlobDownload(draft.blob, draft.fileName);
                onResult(`剪映草稿已导出 · ${draft.fileName}`);
            } else if (key === "edl") {
                const result = await exportStudioTimelineEdl(projectId);
                onResult(`EDL 已导出 · ${(result as { fileName?: string }).fileName ?? "timeline.edl"}`);
            } else if (key === "fcpxml") {
                const result = await exportStudioTimelineFcpxml(projectId);
                onResult(`FCPXML 已导出 · ${(result as { fileName?: string }).fileName ?? "timeline.fcpxml"}`);
            } else {
                const result = await exportStudioMultitrackBundle(projectId);
                onResult(`多轨包已导出 · ${(result as { fileName?: string }).fileName ?? "multitrack.zip"}`);
            }
        } catch (error) {
            onResult(`${label} 失败：${error instanceof Error ? error.message : "未知错误"}`, true);
        } finally {
            setBusy(false);
            setOpen(false);
        }
    };
    return (
        <div className="exportmenu">
            <button type="button" className="btn ghost" aria-expanded={open} onClick={() => setOpen((value) => !value)}>导出</button>
            <div className="exportmenu-pop" hidden={!open} role="menu" aria-label="导出格式">
                {items.map((item) => (
                    <button key={item.key} type="button" role="menuitem" disabled={item.disabled}
                        title={item.hint} onClick={() => { void run(item.key, item.label); }}>
                        {item.label}{item.hint && item.disabled ? <small>{item.hint}</small> : null}
                    </button>
                ))}
            </div>
        </div>
    );
}
