/**
 * 创作台导出下拉（P2-9）：剪映草稿 / EDL / FCPXML / 多轨包。
 * 由 F4 单按钮「导出剪映草稿」扩展而来；剪映动作保留，新增时间轴三导出。
 * 成功回执显示文件名 + 缺素材/时长问题计数（有问题不伪装成成功）。
 */
import { Download } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Dropdown } from "antd";
import type { MenuProps } from "antd";

import { ToolButton } from "@/components/ui/base/buttons";
import { exportStudioJianyingDraft } from "@/services/toiv/client";
import {
    JIANYING_EXPORT_HINT,
    canExportJianyingDraft,
    triggerBlobDownload,
    type JianyingExportShotLike,
} from "@/services/toiv/jianying-draft";
import {
    STUDIO_EXPORT_HINT,
    STUDIO_EXPORT_NO_CLIPS_HINT,
    exportStudioMultitrackBundle,
    exportStudioTimelineEdl,
    exportStudioTimelineFcpxml,
    studioExportMenuModel,
    type StudioExportAction,
    type StudioTimelineExportResult,
} from "@/services/toiv/multitrack-export";

type Props = {
    projectId: string;
    shots: readonly JianyingExportShotLike[];
    disabled?: boolean;
};

export function StudioExportMenu({ projectId, shots, disabled }: Props) {
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<string | null>(null);
    const [msgWarn, setMsgWarn] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const ready = canExportJianyingDraft(shots);

    const items = useMemo<MenuProps["items"]>(
        () =>
            studioExportMenuModel({ ready, busy }).map((item) => ({
                key: item.key,
                label: item.label,
                disabled: item.disabled,
                title: item.hint,
            })),
        [ready, busy],
    );

    const runTimelineExport = useCallback(
        async (action: Exclude<StudioExportAction, "jianying">): Promise<void> => {
            const result: StudioTimelineExportResult =
                action === "edl"
                    ? await exportStudioTimelineEdl(projectId)
                    : action === "fcpxml"
                      ? await exportStudioTimelineFcpxml(projectId)
                      : await exportStudioMultitrackBundle(projectId);
            triggerBlobDownload(result.blob, result.fileName);
            const issues = result.missingAssets + result.durationIssues;
            setMsgWarn(issues > 0);
            setMsg(
                issues > 0
                    ? `已下载 ${result.fileName}（${result.format}），但有 ${result.missingAssets} 处缺素材、${result.durationIssues} 处时长问题，请查包内清单。`
                    : `已下载 ${result.fileName}（${result.format}），无缺素材/时长问题。`,
            );
        },
        [projectId],
    );

    const onAction = useCallback(
        async (action: StudioExportAction) => {
            if (!ready) {
                setErr(STUDIO_EXPORT_NO_CLIPS_HINT);
                return;
            }
            setBusy(true);
            setErr(null);
            setMsg(null);
            try {
                if (action === "jianying") {
                    const { blob, fileName, format } = await exportStudioJianyingDraft(projectId, {
                        include_media: true,
                    });
                    triggerBlobDownload(blob, fileName);
                    setMsgWarn(false);
                    setMsg(`已下载 ${fileName}（${format}）。${JIANYING_EXPORT_HINT}`);
                } else {
                    await runTimelineExport(action);
                }
            } catch (e) {
                setErr(e instanceof Error ? e.message : "导出失败");
            } finally {
                setBusy(false);
            }
        },
        [projectId, ready, runTimelineExport],
    );

    return (
        <div className="flex w-full flex-col gap-1.5" data-testid="studio-export-menu">
            <Dropdown
                trigger={["click"]}
                disabled={disabled || busy || !ready}
                menu={{
                    items,
                    onClick: ({ key }) => void onAction(key as StudioExportAction),
                }}
            >
                <div className="w-fit">
                    <ToolButton
                        variant="ghost"
                        icon={<Download />}
                        label={busy ? "导出中…" : "导出"}
                        loading={busy}
                        disabled={disabled || busy || !ready}
                        onClick={() => void 0}
                    />
                </div>
            </Dropdown>
            <p className="text-[11px] leading-relaxed text-[var(--muted-foreground)]">
                {ready ? STUDIO_EXPORT_HINT : STUDIO_EXPORT_NO_CLIPS_HINT}
            </p>
            {err && <p className="text-xs text-[var(--danger)]">{err}</p>}
            {msg && (
                <p className={`text-xs ${msgWarn ? "text-[var(--warning)]" : "text-foreground"}`}>{msg}</p>
            )}
        </div>
    );
}
