/**
 * F3：短剧时间线/合成段的声床控制（挂 URL 或上传 · 音量 · 对白闪避）。
 */
import { Music2, Trash2, Upload } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { ToolButton } from "@/components/ui/base/buttons";
import {
    bgmActive,
    bgmBedLabel,
    isAllowedBgmUrl,
    normalizeBgmDuck,
    normalizeBgmUrl,
    normalizeBgmVolume,
    type BgmBedConfig,
} from "@/services/toiv/bgm-bed";
import { patchStudioProject, uploadStudioProjectBgm } from "@/services/toiv/client";

type Props = {
    projectId: string;
    value: BgmBedConfig;
    onChange: (next: BgmBedConfig) => void;
    disabled?: boolean;
};

export function BgmBedPanel({ projectId, value, onChange, disabled }: Props) {
    const fileRef = useRef<HTMLInputElement>(null);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<string | null>(null);
    const [err, setErr] = useState<string | null>(null);
    const [draftUrl, setDraftUrl] = useState(value.bgm_url);

    const persist = useCallback(
        async (next: BgmBedConfig) => {
            setBusy(true);
            setErr(null);
            setMsg(null);
            try {
                if (next.bgm_url && !isAllowedBgmUrl(next.bgm_url)) {
                    throw new Error("声床须为站内路径（如 /api/studio/files/…）");
                }
                await patchStudioProject(projectId, {
                    bgm_url: next.bgm_url,
                    bgm_volume: next.bgm_volume,
                    bgm_duck: next.bgm_duck,
                });
                onChange(next);
                setDraftUrl(next.bgm_url);
                setMsg(bgmActive(next.bgm_url) ? `已保存：${bgmBedLabel(next)}` : "已清除声床");
            } catch (e) {
                setErr(e instanceof Error ? e.message : "声床保存失败");
            } finally {
                setBusy(false);
            }
        },
        [onChange, projectId],
    );

    const onUpload = useCallback(
        async (file: File | null) => {
            if (!file) return;
            setBusy(true);
            setErr(null);
            setMsg(null);
            try {
                const { bgm_url } = await uploadStudioProjectBgm(projectId, file);
                const next = {
                    bgm_url,
                    bgm_volume: normalizeBgmVolume(value.bgm_volume),
                    bgm_duck: normalizeBgmDuck(value.bgm_duck),
                };
                // upload 端点已写 bgm_url；再补音量/闪避
                await patchStudioProject(projectId, {
                    bgm_volume: next.bgm_volume,
                    bgm_duck: next.bgm_duck,
                });
                onChange(next);
                setDraftUrl(bgm_url);
                setMsg(`已上传：${bgmBedLabel(next)}`);
            } catch (e) {
                setErr(e instanceof Error ? e.message : "声床上传失败");
            } finally {
                setBusy(false);
                if (fileRef.current) fileRef.current.value = "";
            }
        },
        [onChange, projectId, value.bgm_duck, value.bgm_volume],
    );

    return (
        <div className="flex flex-col gap-2 rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
            <div className="flex flex-wrap items-center gap-2">
                <Music2 className="size-4 text-[var(--muted-foreground)]" />
                <span className="text-sm font-medium text-foreground">声床 BGM</span>
                <span className="text-xs text-[var(--muted-foreground)]">
                    {bgmActive(value.bgm_url) ? bgmBedLabel(value) : "合成时垫在对白下（非完整调音台）"}
                </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <input
                    className="min-w-[16rem] flex-1 rounded-md border border-[var(--border)] bg-background px-2 py-1.5 text-xs"
                    placeholder="/api/studio/files/你的垫乐.mp3"
                    value={draftUrl}
                    disabled={disabled || busy}
                    onChange={(e) => setDraftUrl(e.target.value)}
                />
                <ToolButton
                    size="xs"
                    variant="ghost"
                    label={busy ? "保存中…" : "挂接"}
                    disabled={disabled || busy}
                    onClick={() =>
                        void persist({
                            bgm_url: normalizeBgmUrl(draftUrl),
                            bgm_volume: normalizeBgmVolume(value.bgm_volume),
                            bgm_duck: normalizeBgmDuck(value.bgm_duck),
                        })
                    }
                />
                <ToolButton
                    size="xs"
                    variant="ghost"
                    icon={<Upload className="size-3.5" />}
                    label="上传"
                    disabled={disabled || busy}
                    onClick={() => fileRef.current?.click()}
                />
                <input
                    ref={fileRef}
                    type="file"
                    accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac"
                    className="hidden"
                    onChange={(e) => void onUpload(e.target.files?.[0] ?? null)}
                />
                {bgmActive(value.bgm_url) && (
                    <ToolButton
                        size="xs"
                        variant="ghost"
                        icon={<Trash2 className="size-3.5" />}
                        label="清除"
                        disabled={disabled || busy}
                        onClick={() =>
                            void persist({
                                bgm_url: "",
                                bgm_volume: value.bgm_volume,
                                bgm_duck: value.bgm_duck,
                            })
                        }
                    />
                )}
            </div>
            <div className="flex flex-wrap items-center gap-4 text-xs">
                <label className="flex items-center gap-2 text-[var(--muted-foreground)]">
                    音量
                    <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={normalizeBgmVolume(value.bgm_volume)}
                        disabled={disabled || busy}
                        onChange={(e) =>
                            onChange({
                                ...value,
                                bgm_volume: normalizeBgmVolume(Number(e.target.value)),
                            })
                        }
                        onMouseUp={() =>
                            void persist({
                                ...value,
                                bgm_volume: normalizeBgmVolume(value.bgm_volume),
                            })
                        }
                        onTouchEnd={() =>
                            void persist({
                                ...value,
                                bgm_volume: normalizeBgmVolume(value.bgm_volume),
                            })
                        }
                    />
                    <span className="tabular-nums text-foreground">
                        {Math.round(normalizeBgmVolume(value.bgm_volume) * 100)}%
                    </span>
                </label>
                <label className="flex items-center gap-2 text-[var(--muted-foreground)]">
                    <input
                        type="checkbox"
                        checked={normalizeBgmDuck(value.bgm_duck)}
                        disabled={disabled || busy}
                        onChange={(e) => {
                            const next = { ...value, bgm_duck: e.target.checked };
                            onChange(next);
                            void persist(next);
                        }}
                    />
                    对白闪避
                </label>
            </div>
            {msg && <p className="text-xs text-foreground">{msg}</p>}
            {err && <p className="text-xs text-[var(--danger)]">{err}</p>}
        </div>
    );
}
