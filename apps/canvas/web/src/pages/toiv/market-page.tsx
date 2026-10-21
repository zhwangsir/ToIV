import { ArrowLeft, Loader2, Play, Plus, RefreshCw, Search, Sparkles, Upload, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import { TasksCenterLink } from "@/components/toiv/tasks-center-link";
import { formatClientTimeoutMessage, isClientTimeoutError, isStillRunningMessage } from "@/services/toiv/client-timeout";
import { formatSmokeBadgeLabel, smokeBadgeTone } from "@/services/toiv/smoke-badge";

import { ToolButton } from "@/components/ui/base/buttons";
import { AudioLines, Clapperboard, ImagePlus, Languages } from "lucide-react";
import { StatusBadge } from "@/components/ui/base/badges";
import { AppDrawer } from "@/components/ui/product/app-drawer";
import { Callout } from "@/components/ui/product/callout";
import { EmptyState } from "@/components/ui/product/empty-state";
import { LOCAL_AUDIO_HAS_SENSEVOICE, LOCAL_AUDIO_UNAVAILABLE_LABEL } from "@/lib/local-model-defaults";
import {
    appShowsR18Badge,
    appUploadKind,
    applyMarketConvenienceChange,
    asMarketMediaList,
    buildDefaultRunValues,
    buildToivRunValues,
    canShowContentModeToggle,
    enrichMarketSchemaWithDeepParams,
    fetchToivApp,
    fetchToivAppVariants,
    fetchToivAppsPage,
    firstPinWorker,
    isMarketConvenienceKey,
    mergeMarketModeChips,
    requiredToivParamLabel,
    resolveSubmitContentMode,
    runToivApp,
    splitMarketRunParamsWithConvenience,
    toivCoverImageUrl,
    uploadToivMedia,
    type ContentMode,
    type MarketMediaHandle,
    type ToivApp,
    type ToivAppModeItem,
    type ToivAppParam,
} from "@/services/toiv/client";
import { isR18Mode } from "@/services/toiv/r18-mode";
import {
    LOCAL_MARKET_FEATURED,
    isMarketAudioUnavailableApp,
    localCapabilityHoverTitle,
    localCapabilityProductLabel,
    localMarketFeaturedAppIds,
    resolveLocalCapabilityBadge,
    sortAppsWithFeaturedIds,
    sortMarketAppsDefault,
} from "@/services/toiv/local-capability-surface";
import type { LocalCapabilityBadge } from "@/services/toiv/local-capability-surface";
import {
    isMarketCanvasProvider,
    registerMarketCanvasProvider,
    unregisterMarketCanvasProvider,
} from "@/services/toiv/market-providers";
import { WorkspacePage } from "@/components/layout/workspace-page";

const CATEGORY_META: Record<string, string> = {
    video: "视频",
    image: "图像",
    audio: "音频",
    edit: "编辑",
    drama: "短剧",
    tool: "工具",
    "3d": "3D",
    other: "其他",
};


/** Wave P1/N10 + P3.6：产品面业务名；悬停不露裸端口。 */
function LocalBadges({ badge }: { badge: LocalCapabilityBadge }) {
    return (
        <span className="flex flex-wrap items-center gap-1" title={localCapabilityHoverTitle(badge)}>
            <StatusBadge variant="filled" tone="success" label="本地" size="sm" />
            <StatusBadge variant="filled" tone="neutral" label={localCapabilityProductLabel(badge)} size="sm" />
        </span>
    );
}

function smokeBadge(app: ToivApp) {
    const label = formatSmokeBadgeLabel(app.smoke_status, {
        id: app.id,
        name: app.name,
        description: app.description,
        category: app.category,
    });
    if (!label) return null;
    return <StatusBadge variant="filled" tone={smokeBadgeTone(app.smoke_status)} label={label} size="sm" />;
}

/** 市场卡封面：走 toivCoverImageUrl(?token=)；失败 → BeefTV 空态（类别字），禁止 raw cover_url / 死灰大方块 */
function CoverThumb({ coverUrl, category }: { coverUrl?: string; category?: string }) {
    const [failed, setFailed] = useState(false);
    const src = toivCoverImageUrl(coverUrl);
    useEffect(() => {
        setFailed(false);
    }, [coverUrl]);
    const showImg = Boolean(src) && !failed;
    return (
        <div className="relative aspect-[4/3] w-full overflow-hidden bg-[var(--muted)]">
            {showImg ? (
                <img
                    src={src}
                    alt=""
                    className="h-full w-full object-cover"
                    loading="lazy"
                    onError={() => setFailed(true)}
                />
            ) : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-[var(--muted-foreground)]">
                    <span className="text-2xl opacity-50" aria-hidden>
                        {CATEGORY_META[category || "other"] ?? "应用"}
                    </span>
                    <span className="text-[10px] opacity-60">暂无封面</span>
                </div>
            )}
        </div>
    );
}

const MARKET_PAGE_SIZE = 200;
const IMAGE_EXT = ["jpg", "jpeg", "png", "webp"];
const AUDIO_EXT = ["wav", "mp3", "m4a", "ogg", "flac"];
const VIDEO_EXT = ["mp4", "mov", "webm", "mkv"];
const IMAGE_MAX = 20 * 1024 * 1024;
const AUDIO_MAX = 20 * 1024 * 1024;
const VIDEO_MAX = 200 * 1024 * 1024;

function fileExt(name: string): string {
    const i = name.lastIndexOf(".");
    return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

function MarketMediaField({
    param,
    value,
    onChange,
    uploadKind,
    pinWorker,
    disabled,
}: {
    param: ToivAppParam;
    value: unknown;
    onChange: (key: string, next: unknown) => void;
    uploadKind: string;
    pinWorker?: string | null;
    disabled?: boolean;
}) {
    const inputRef = useRef<HTMLInputElement | null>(null);
    const [uploading, setUploading] = useState(false);
    const [progress, setProgress] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const list = asMarketMediaList(value);
    const multi = param.type === "images" && (param.max ?? 4) > 1;
    const max = param.type === "images" ? (param.max ?? 4) : 1;
    const accept =
        param.type === "audio"
            ? "audio/*,.wav,.mp3,.m4a,.ogg,.flac"
            : param.type === "video"
              ? "video/*,.mp4,.mov,.webm,.mkv"
              : "image/*,.jpg,.jpeg,.png,.webp";
    const kindLabel = param.type === "audio" ? "音频" : param.type === "video" ? "视频" : "图片";

    const setList = (next: MarketMediaHandle[]) => {
        onChange(param.key, multi || param.type === "images" ? next : next);
    };

    const onFile = async (file: File | undefined) => {
        if (!file || disabled) return;
        setError(null);
        if (list.length >= max) {
            setError(`${kindLabel}最多 ${max} 项`);
            return;
        }
        const ext = fileExt(file.name);
        if (param.type === "images" && !IMAGE_EXT.includes(ext)) {
            setError("仅支持 jpg / png / webp 图片");
            return;
        }
        if (param.type === "audio" && !AUDIO_EXT.includes(ext)) {
            setError("仅支持 wav / mp3 / m4a / ogg / flac 音频");
            return;
        }
        if (param.type === "video" && !VIDEO_EXT.includes(ext)) {
            setError("仅支持 mp4 / mov / webm / mkv 视频");
            return;
        }
        const limit = param.type === "video" ? VIDEO_MAX : param.type === "audio" ? AUDIO_MAX : IMAGE_MAX;
        if (file.size > limit) {
            setError(`${kindLabel}超过 ${Math.round(limit / (1024 * 1024))}MB 上限`);
            return;
        }
        setUploading(true);
        setProgress(0);
        try {
            const r = await uploadToivMedia(file, uploadKind, pinWorker || undefined, {
                onProgress: (pct) => setProgress(pct),
            });
            const handle: MarketMediaHandle = {
                filename: r.filename,
                worker: r.worker,
                name: file.name,
                previewUrl: URL.createObjectURL(file),
            };
            setList([...list, handle]);
        } catch (e) {
            setError(e instanceof Error ? e.message : "上传失败");
        } finally {
            setUploading(false);
            setProgress(null);
            if (inputRef.current) inputRef.current.value = "";
        }
    };

    const removeAt = (idx: number) => {
        const next = list.filter((_, i) => i !== idx);
        setList(next);
    };

    return (
        <div className="flex flex-col gap-1.5 text-xs">
            <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-foreground">{param.label}</span>
                <span className="text-[11px] text-[var(--muted-foreground)]">
                    {list.length}/{max}
                </span>
            </div>
            {list.length > 0 && (
                <ul className="flex flex-col gap-1.5">
                    {list.map((item, idx) => (
                        <li
                            key={`${item.filename}-${idx}`}
                            className="flex items-center gap-2 rounded-md border border-[var(--border)] px-2 py-1.5"
                        >
                            {item.previewUrl && param.type === "images" ? (
                                <img src={item.previewUrl} alt="" className="h-8 w-8 rounded object-cover" />
                            ) : (
                                <span className="grid h-8 w-8 place-items-center rounded bg-[var(--muted)] text-[10px]">
                                    {kindLabel[0]}
                                </span>
                            )}
                            <span className="min-w-0 flex-1 truncate" title={item.name || item.filename}>
                                {item.name || item.filename}
                            </span>
                            <button
                                type="button"
                                className="rounded p-1 text-[var(--muted-foreground)] hover:text-foreground"
                                aria-label="移除"
                                disabled={disabled || uploading}
                                onClick={() => removeAt(idx)}
                            >
                                <X className="h-3.5 w-3.5" />
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            {list.length < max && (
                <button
                    type="button"
                    disabled={disabled || uploading}
                    onClick={() => inputRef.current?.click()}
                    className="flex items-center justify-center gap-1.5 rounded-md border border-dashed border-[var(--border)] px-3 py-2 text-[var(--muted-foreground)] transition-colors hover:border-[var(--workspace-accent)] hover:text-foreground disabled:opacity-50"
                >
                    {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                    {uploading ? `上传中${progress != null ? ` ${progress}%` : ""}` : `上传${kindLabel}`}
                </button>
            )}
            <input
                ref={inputRef}
                type="file"
                accept={accept}
                className="hidden"
                disabled={disabled || uploading}
                onChange={(e) => void onFile(e.target.files?.[0])}
            />
            {param.hint && !error && (
                <p className="text-[11px] text-[var(--muted-foreground)]">{param.hint}</p>
            )}
            {error && <p className="text-[11px] text-[var(--destructive)]">{error}</p>}
        </div>
    );
}


type LoraPick = { name: string; strength: number };

function LorasField({
    param,
    value,
    onChange,
    disabled,
}: {
    param: ToivAppParam;
    value: unknown;
    onChange: (key: string, next: unknown) => void;
    disabled?: boolean;
}) {
    const LORA_CAP = 3;
    const modeAuto = value == null;
    const modeOff = Array.isArray(value) && value.length === 0;
    const selected: LoraPick[] =
        Array.isArray(value) && !modeOff ? (value as LoraPick[]) : [];
    const strengthOf = (name: string) => selected.find((l) => l.name === name)?.strength ?? 0.6;
    const set = (next: unknown) => onChange(param.key, next);
    const toggle = (name: string, on: boolean) => {
        if (on) {
            if (selected.length >= LORA_CAP) return;
            set([...selected, { name, strength: 0.6 }]);
        } else {
            const next = selected.filter((l) => l.name !== name);
            set(next.length > 0 ? next : null);
        }
    };
    const setStrength = (name: string, strength: number) => {
        set(selected.map((l) => (l.name === name ? { ...l, strength } : l)));
    };
    const min = param.min ?? 0.5;
    const max = param.max ?? 1.0;
    const step = param.step ?? 0.05;
    const atCap = selected.length >= LORA_CAP;
    const options = param.options ?? [];
    return (
        <div className="flex flex-col gap-1.5 text-xs" data-testid="market-loras-field">
            <span className="text-[var(--muted-foreground)]">{param.label}</span>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="LoRA 模式">
                <button
                    type="button"
                    disabled={disabled}
                    className={`rounded-full border px-2.5 py-1 text-[11px] ${modeAuto ? "border-[var(--workspace-accent)] bg-[var(--surface-active)]" : "border-[var(--border)] text-[var(--muted-foreground)]"}`}
                    onClick={() => set(null)}
                >
                    AI 选配
                </button>
                <button
                    type="button"
                    disabled={disabled}
                    className={`rounded-full border px-2.5 py-1 text-[11px] ${modeOff ? "border-[var(--workspace-accent)] bg-[var(--surface-active)]" : "border-[var(--border)] text-[var(--muted-foreground)]"}`}
                    onClick={() => set([])}
                >
                    关闭
                </button>
            </div>
            {options.length === 0 ? (
                <p className="text-[11px] text-[var(--muted-foreground)]">
                    {modeOff ? "不叠加 LoRA" : "当前无 LoRA 列表（仍可 AI 选配或关闭）"}
                </p>
            ) : (
                <div className="flex flex-col gap-1.5 max-h-40 overflow-y-auto rounded-md border border-[var(--border)] p-2">
                    {options.map((o) => {
                        const on = selected.some((l) => l.name === o.value);
                        return (
                            <div key={o.value} className="flex flex-col gap-1">
                                <label className="flex items-center gap-2">
                                    <input
                                        type="checkbox"
                                        checked={on}
                                        disabled={disabled || (!on && atCap)}
                                        onChange={(e) => toggle(o.value, e.target.checked)}
                                    />
                                    <span className="truncate" title={o.value}>
                                        {o.label || o.value}
                                    </span>
                                    {o.nsfw ? (
                                        <span className="rounded bg-[var(--destructive)]/15 px-1 text-[10px] text-[var(--destructive)]">
                                            R18
                                        </span>
                                    ) : null}
                                </label>
                                {on && (
                                    <label className="flex items-center gap-2 pl-6 text-[11px] text-[var(--muted-foreground)]">
                                        强度
                                        <input
                                            type="range"
                                            min={min}
                                            max={max}
                                            step={step}
                                            value={strengthOf(o.value)}
                                            disabled={disabled}
                                            onChange={(e) => setStrength(o.value, Number(e.target.value))}
                                            className="flex-1"
                                            aria-label={`${o.label} 强度`}
                                        />
                                        <span className="w-8 tabular-nums">{strengthOf(o.value).toFixed(2)}</span>
                                    </label>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
            {param.hint ? <p className="text-[11px] text-[var(--muted-foreground)]">{param.hint}</p> : null}
        </div>
    );
}

function ParamField({
    param,
    value,
    onChange,
    uploadKind,
    pinWorker,
    disabled,
}: {
    param: ToivAppParam;
    value: unknown;
    onChange: (key: string, next: unknown) => void;
    uploadKind: string;
    pinWorker?: string | null;
    disabled?: boolean;
}) {
    const id = `mkt-param-${param.key}`;
    const common =
        "w-full rounded-md border border-[var(--border)] bg-transparent px-3 py-1.5 text-xs outline-none focus:border-[var(--workspace-accent)]";

    if (param.type === "loras") {
        return (
            <LorasField param={param} value={value} onChange={onChange} disabled={disabled} />
        );
    }

    if (param.type === "switch") {
        return (
            <label className="flex items-center justify-between gap-3 text-xs">
                <span className="text-[var(--muted-foreground)]">{param.label}</span>
                <input
                    id={id}
                    type="checkbox"
                    checked={Boolean(value)}
                    onChange={(e) => onChange(param.key, e.target.checked)}
                    className="h-4 w-4 accent-[var(--workspace-accent)]"
                />
            </label>
        );
    }

    if (param.type === "select") {
        return (
            <label className="flex flex-col gap-1 text-xs">
                <span className="text-[var(--muted-foreground)]">{param.label}</span>
                <select
                    id={id}
                    value={String(value ?? "")}
                    onChange={(e) => onChange(param.key, e.target.value)}
                    className={common}
                >
                    {(param.options ?? []).map((o) => (
                        <option key={o.value} value={o.value}>
                            {o.label || o.value}
                        </option>
                    ))}
                </select>
            </label>
        );
    }

    if (param.type === "textarea") {
        return (
            <label className="flex flex-col gap-1 text-xs">
                <span className="text-[var(--muted-foreground)]">{param.label}</span>
                <textarea
                    id={id}
                    rows={3}
                    value={String(value ?? "")}
                    onChange={(e) => onChange(param.key, e.target.value)}
                    placeholder={param.hint || ""}
                    className={`${common} resize-y`}
                />
            </label>
        );
    }

    if (param.type === "images" || param.type === "audio" || param.type === "video") {
        return (
            <MarketMediaField
                param={param}
                value={value}
                onChange={onChange}
                uploadKind={uploadKind}
                pinWorker={pinWorker}
                disabled={disabled}
            />
        );
    }

    return (
        <label className="flex flex-col gap-1 text-xs">
            <span className="text-[var(--muted-foreground)]">{param.label}</span>
            <input
                id={id}
                type={param.type === "number" ? "number" : "text"}
                value={value == null ? "" : String(value)}
                min={param.min}
                max={param.max}
                step={param.step}
                onChange={(e) =>
                    onChange(param.key, param.type === "number" ? e.target.value : e.target.value)
                }
                placeholder={param.hint || ""}
                className={common}
            />
        </label>
    );
}

export default function MarketPage() {
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const deepAppId = (searchParams.get("app") || "").trim();

    const deepOpenedRef = useRef<string | null>(null);

    const [apps, setApps] = useState<ToivApp[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    // W0.2b(2026-10-11 S1)分页:此前 /api/apps 忽略 limit 一次全量 6731 张全渲染
    // (scrollHeight 61 万 px);现 200/页服务端切片 + 加载更多,筛选作用于已加载集。
    const [total, setTotal] = useState(0);
    const [hasMore, setHasMore] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const offsetRef = useRef(0);
    const [category, setCategory] = useState<string>("all");
    const [q, setQ] = useState("");
    const [detail, setDetail] = useState<ToivApp | null>(null);
    const [detailLoading, setDetailLoading] = useState(false);
    const [detailError, setDetailError] = useState<string | null>(null);
    const [values, setValues] = useState<Record<string, unknown>>({});
    const [running, setRunning] = useState(false);
    const [runMsg, setRunMsg] = useState<string | null>(null);
    const [runFailed, setRunFailed] = useState(false);
    const [providerTick, setProviderTick] = useState(0);
    const [modes, setModes] = useState<ToivAppModeItem[]>([]);
    const [modesLoading, setModesLoading] = useState(false);
    const [advOpen, setAdvOpen] = useState(false);
    const [deepOpen, setDeepOpen] = useState(false);
    /** 双模卡 SFW|R18；R18 关时 resolve 强制 sfw */
    const [contentMode, setContentMode] = useState<ContentMode>("sfw");
    const [r18On, setR18On] = useState(() => isR18Mode());

    const load = useCallback(async () => {
        setLoading(true);
        setError(false);
        try {
            const page = await fetchToivAppsPage({ limit: MARKET_PAGE_SIZE, offset: 0 });
            offsetRef.current = page.items.length;
            setApps(page.items);
            setTotal(page.total);
            setHasMore(page.items.length < page.total);
        } catch {
            setError(true);
        } finally {
            setLoading(false);
        }
    }, []);

    const loadMore = useCallback(async () => {
        if (loadingMore || loading) return;
        setLoadingMore(true);
        try {
            const page = await fetchToivAppsPage({ limit: MARKET_PAGE_SIZE, offset: offsetRef.current });
            offsetRef.current += page.items.length;
            setApps((prev) => [...prev, ...page.items]);
            setTotal(page.total);
            setHasMore(offsetRef.current < page.total);
        } catch {
            // 单页追加失败不整体报错,用户可再点一次
        } finally {
            setLoadingMore(false);
        }
    }, [loading, loadingMore]);

    useEffect(() => {
        void load();
    }, [load]);

    useEffect(() => {
        const sync = () => setR18On(isR18Mode());
        sync();
        window.addEventListener("focus", sync);
        window.addEventListener("storage", sync);
        return () => {
            window.removeEventListener("focus", sync);
            window.removeEventListener("storage", sync);
        };
    }, []);

    useEffect(() => {
        if (!r18On && category === "r18") setCategory("all");
    }, [r18On, category]);

    const openDetail = useCallback(
        async (appOrId: ToivApp | string) => {
            const id = typeof appOrId === "string" ? appOrId : appOrId.id;
            const slim = typeof appOrId === "string" ? apps.find((a) => a.id === id) : appOrId;
            setDetail(slim ?? { id, name: "加载中…" });
            setDetailLoading(true);
            setDetailError(null);
            setRunMsg(null);
            setValues({});
            setModes([]);
            setAdvOpen(false);
            setDeepOpen(false);
            setContentMode("sfw");
            try {
                const full = await fetchToivApp(id);
                setDetail(full);
                const schema0 = enrichMarketSchemaWithDeepParams(full.id, full.params_schema ?? []);
                const base = buildDefaultRunValues(schema0);
                const { convenience } = splitMarketRunParamsWithConvenience(schema0);
                // 只回填 UI 键显示值，不覆盖 schema 默认 width/height/length/frames
                for (const c of convenience) {
                    if (c.key === "_ui_resolution") {
                        const w = base.width;
                        const h = base.height;
                        base[c.key] =
                            w != null && h != null && String(w) !== "" && String(h) !== ""
                                ? `${w}x${h}`
                                : (c.default ?? "");
                    } else if (c.key === "_ui_duration") {
                        base[c.key] = c.default ?? "";
                    } else if (base[c.key] === undefined || base[c.key] === "") {
                        base[c.key] = c.default ?? "";
                    }
                }
                setValues(base);
                // 纯 R18 卡默认 nsfw；双模默认 sfw(用户再切)
                const modes = full.content_modes ?? [];
                if (full.is_nsfw && !modes.includes("sfw")) setContentMode("nsfw");
                else setContentMode("sfw");
                setSearchParams(
                    (prev) => {
                        const next = new URLSearchParams(prev);
                        next.set("app", id);
                        return next;
                    },
                    { replace: true },
                );
                setModesLoading(true);
                try {
                    const v = await fetchToivAppVariants(id);
                    setModes(v.modes);
                } catch {
                    setModes([]);
                } finally {
                    setModesLoading(false);
                }
            } catch {
                setDetailError("加载应用详情失败");
            } finally {
                setDetailLoading(false);
            }
        },
        [apps, setSearchParams],
    );

    const closeDetail = useCallback(() => {
        deepOpenedRef.current = null;
        setDetail(null);
        setDetailError(null);
        setRunMsg(null);
        setModes([]);
        setSearchParams(
            (prev) => {
                const next = new URLSearchParams(prev);
                next.delete("app");
                return next;
            },
            { replace: true },
        );
    }, [setSearchParams]);

    useEffect(() => {
        if (!deepAppId || loading) return;
        if (deepOpenedRef.current === deepAppId) return;
        deepOpenedRef.current = deepAppId;
        void openDetail(deepAppId);
    }, [deepAppId, loading, openDetail]);

    const categories = useMemo(() => {
        const set = new Map<string, number>();
        apps.forEach((a) => set.set(a.category || "other", (set.get(a.category || "other") ?? 0) + 1));
        const rows: Array<[string, number]> = [["all", apps.length], ...Array.from(set.entries())];
        if (r18On) {
            const n = apps.filter((a) => appShowsR18Badge(a)).length;
            rows.splice(1, 0, ["r18", n]);
        }
        return rows;
    }, [apps, r18On]);

    const filtered = useMemo(() => {
        const base = apps.filter((a) => {
            if (category === "r18") {
                if (!r18On || !appShowsR18Badge(a)) return false;
            } else if (category !== "all" && (a.category || "other") !== category) {
                return false;
            }
            if (!q.trim()) return true;
            const needle = q.trim().toLowerCase();
            return (
                (a.name ?? "").toLowerCase().includes(needle) ||
                (a.description ?? "").toLowerCase().includes(needle) ||
                (a.guide_purpose ?? "").toLowerCase().includes(needle) ||
                a.id.toLowerCase().includes(needle)
            );
        });
        if ((category === "all" || category === "r18") && !q.trim()) {
            return sortMarketAppsDefault(base);
        }
        return base;
    }, [apps, category, q, r18On]);

    const featuredLocal = useMemo(() => {
        const byId = new Map(apps.map((a) => [a.id, a]));
        return LOCAL_MARKET_FEATURED.map((entry) => ({
            entry,
            app: entry.appId ? byId.get(entry.appId) : undefined,
        }));
    }, [apps]);

    const schema = useMemo(
        () => enrichMarketSchemaWithDeepParams(detail?.id, detail?.params_schema ?? []),
        [detail?.id, detail?.params_schema],
    );
    const paramSplit = useMemo(() => splitMarketRunParamsWithConvenience(schema), [schema]);
    const modeChips = useMemo(
        () => mergeMarketModeChips(detail?.id, modes),
        [detail?.id, modes],
    );
    const missing = detail ? requiredToivParamLabel(schema, values) : null;
    const registered = useMemo(
        () => (detail ? isMarketCanvasProvider(detail.id) : false),
        [detail, providerTick],
    );
    const audioBlocked = Boolean(detail && isMarketAudioUnavailableApp(detail) && !LOCAL_AUDIO_HAS_SENSEVOICE);

    const onParamChange = (key: string, next: unknown) => {
        setValues((prev) => {
            if (isMarketConvenienceKey(key)) {
                return applyMarketConvenienceChange(schema, key, next, prev);
            }
            return { ...prev, [key]: next };
        });
    };

    const onRun = async () => {
        if (!detail?.id || missing || audioBlocked) return;
        setRunning(true);
        setRunMsg(null);
        setRunFailed(false);
        try {
            const mode = resolveSubmitContentMode({
                app: detail,
                r18On: isR18Mode(),
                selected: contentMode,
            });
            const receipt = await runToivApp(detail.id, buildToivRunValues(schema, values), {
                content_mode: mode,
            });
            if (!receipt.job_id) {
                setRunMsg("运行已提交，但未返回作业号");
                return;
            }
            setRunMsg(`已创建作业 ${receipt.job_id.slice(0, 8)}…，正在前往任务中心`);
            navigate(`/toiv/tasks?from=market&job=${encodeURIComponent(receipt.job_id)}`);
        } catch (err) {
            if (isClientTimeoutError(err)) {
                // 客户端等待超时 ≠ 作业失败：作业可能已入队，引导任务中心
                setRunMsg(formatClientTimeoutMessage());
                setRunFailed(false);
            } else {
                const msg = err instanceof Error ? err.message : "运行失败";
                setRunMsg(msg);
                // 失败提示与成功提示同灰字会误导,失败单独着色
                setRunFailed(true);
            }
        } finally {
            setRunning(false);
        }
    };

    const onToggleProvider = () => {
        if (!detail?.id) return;
        if (registered) {
            unregisterMarketCanvasProvider(detail.id);
        } else {
            registerMarketCanvasProvider({
                id: detail.id,
                name: detail.name,
                category: detail.category,
                output_kind: detail.output_kind,
            });
        }
        setProviderTick((n) => n + 1);
    };

    return (
        <WorkspacePage fluid className="toiv-market-page">
            <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-6">
            <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div className="flex flex-col gap-1">
                    <h1 className="text-xl font-semibold leading-7 text-foreground">工具箱</h1>
                    <p className="text-sm text-muted-foreground">应用市场 · 生成能力即取即用</p>
                    <p className="text-xs leading-5 text-[var(--muted-foreground)]">
                        浏览应用、配置参数后运行；作业自动进入任务中心
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <Link to="/toiv/audio"><ToolButton variant="default" icon={<AudioLines className="size-4" />} label="音频工具" /></Link>
                    <Link to="/toiv/image-tools"><ToolButton variant="default" icon={<ImagePlus className="size-4" />} label="图片工具" /></Link>
                    <Link to="/toiv/video-tools"><ToolButton variant="default" icon={<Clapperboard className="size-4" />} label="视频剪辑" /></Link>
                    <Link to="/toiv/dub-tools"><ToolButton variant="default" icon={<Languages className="size-4" />} label="视频译制" /></Link>
                    <ToolButton variant="default" icon={<RefreshCw />} label="刷新" onClick={() => void load()} loading={loading} />
                    <Link to="/">
                        <ToolButton variant="default" icon={<ArrowLeft />} label="返回首页" />
                    </Link>
                </div>
            </header>

            <div className="toiv-market-filters flex flex-wrap items-center gap-2">
                {categories.map(([key, n]) => (
                    <button
                        key={key}
                        type="button"
                        onClick={() => setCategory(key)}
                        className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                            category === key
                                ? "border-[var(--workspace-accent)] bg-[var(--surface-active)]"
                                : "border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--workspace-accent)]"
                        }`}
                    >
                        {key === "all"
                            ? `全部 ${n}`
                            : key === "r18"
                              ? `R18 ${n}`
                              : `${CATEGORY_META[key] ?? key} ${n}`}
                    </button>
                ))}
                <label className="toiv-market-search ml-auto flex w-full max-w-md items-center gap-2 rounded-md border border-[var(--border)] bg-transparent px-3 py-1.5 text-xs sm:w-56">
                    <Search className="h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" aria-hidden />
                    <input
                        type="search"
                        placeholder="搜索应用"
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-[var(--muted-foreground)]"
                    />
                </label>
            </div>

            {loading ? (
                <div className="flex min-h-64 items-center justify-center">
                    <Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="加载中" />
                </div>
            ) : error ? (
                <EmptyState description="读取失败，请刷新重试" />
            ) : filtered.length === 0 ? (
                <EmptyState description="没有匹配的应用" />
            ) : (
                <>
                    {category === "audio" && !LOCAL_AUDIO_HAS_SENSEVOICE && (
                        <Callout tone="warning" title={LOCAL_AUDIO_UNAVAILABLE_LABEL}>
                            本地音频反推 / SenseVoice 未接线；市场内相关入口已标明不可用，不会伪装成可运行。
                        </Callout>
                    )}
                    {category === "all" && !q.trim() && (
                        <section className="flex flex-col gap-2" aria-label="本地精选">
                            <div className="flex items-baseline justify-between">
                                <h2 className="text-sm font-medium text-foreground">本地精选</h2>
                                <span className="text-[11px] text-[var(--muted-foreground)]">
                                    图像 · 短剧视频 · 长视频 · 视频编辑 · 动作 · 续写 · 数字人 · 视频生成
                                </span>
                            </div>
                            <div className="flex gap-3 overflow-x-auto pb-1">
                                {featuredLocal.map(({ entry, app }) => {
                                    const badge = {
                                        kind: entry.kind,
                                        label: "本地",
                                        worker: entry.worker,
                                        engine: entry.engine,
                                        protocol: entry.protocol,
                                    };
                                    return (
                                        <button
                                            key={entry.id}
                                            type="button"
                                            onClick={() => {
                                                if (app) void openDetail(app);
                                                else if (entry.appId) void openDetail(entry.appId);
                                                else if (entry.canvasTo) navigate(entry.canvasTo);
                                            }}
                                            className="flex w-44 shrink-0 flex-col gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--card)] p-3 text-left transition-colors hover:border-[var(--workspace-accent)]"
                                        >
                                            <p className="truncate text-sm font-medium">{app?.name || entry.label}</p>
                                            <LocalBadges badge={badge} />
                                            <p className="line-clamp-2 text-[11px] text-[var(--muted-foreground)]">
                                                {app?.guide_purpose || app?.description || `本地 · ${localCapabilityProductLabel({ kind: entry.kind, label: entry.label, worker: entry.worker, engine: entry.engine, protocol: entry.protocol })}`}
                                            </p>
                                        </button>
                                    );
                                })}
                            </div>
                        </section>
                    )}
                    <div className="toiv-market-grid grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
                        {filtered.map((app) => {
                            const local = resolveLocalCapabilityBadge(app);
                            return (
                                <button
                                    key={app.id}
                                    type="button"
                                    onClick={() => void openDetail(app)}
                                    className="group flex flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card)] text-left transition-colors hover:border-[var(--workspace-accent)]"
                                >
                                    <CoverThumb coverUrl={app.cover_url} category={app.category} />
                                    <div className="flex flex-1 flex-col gap-1.5 p-3">
                                        <p className="truncate text-sm font-medium">{app.name}</p>
                                        <p className="line-clamp-2 min-h-8 text-xs text-[var(--muted-foreground)]">
                                            {app.guide_purpose || app.description}
                                        </p>
                                        {local && <LocalBadges badge={local} />}
                                        {r18On && appShowsR18Badge(app) && (
                                            <StatusBadge variant="filled" tone="warning" label="R18" size="sm" />
                                        )}
                                        {isMarketAudioUnavailableApp(app) && !LOCAL_AUDIO_HAS_SENSEVOICE && (
                                            <StatusBadge variant="filled" tone="warning" label="音频未接" size="sm" />
                                        )}
                                        <div className="mt-auto flex items-center justify-between pt-1">
                                            {smokeBadge(app)}
                                            <span className="text-[11px] text-[var(--muted-foreground)]">
                                                {app.usage_count ?? 0} 次使用
                                            </span>
                                        </div>
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                    {hasMore && (
                        <div className="flex flex-col items-center gap-2 py-4">
                            <p className="text-xs text-[var(--muted-foreground)]">
                                已加载 {apps.length} / 共 {total} 个应用 · 筛选作用于已加载部分
                            </p>
                            <ToolButton
                                variant="default"
                                icon={<RefreshCw />}
                                label={loadingMore ? "加载中…" : "加载更多"}
                                onClick={() => void loadMore()}
                                loading={loadingMore}
                            />
                        </div>
                    )}
                </>
            )}

            <AppDrawer open={!!detail} onClose={closeDetail} width={440} title={detail?.name} rootClassName="toiv-app-drawer">
                {detail && (
                    <div className="flex flex-col gap-3">
                        {detailLoading ? (
                            <div className="flex min-h-40 items-center justify-center">
                                <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="加载详情" />
                            </div>
                        ) : detailError ? (
                            <EmptyState description={detailError} />
                        ) : (
                            <>
                                <div className="flex flex-wrap gap-2">
                                    {smokeBadge(detail)}
                                    {detail.featured && <StatusBadge variant="filled" tone="warning" label="精选" size="sm" />}
                                    {detail.is_builtin && <StatusBadge variant="filled" tone="neutral" label="官方" size="sm" />}
                                    <StatusBadge
                                        variant="filled"
                                        tone="neutral"
                                        label={CATEGORY_META[detail.category || "other"] ?? detail.category ?? "其他"}
                                        size="sm"
                                    />
                                    {detail.use_case && (
                                        <StatusBadge variant="filled" tone="neutral" label={detail.use_case} size="sm" />
                                    )}
                                    {registered && (
                                        <StatusBadge variant="filled" tone="success" label="已注册画布" size="sm" />
                                    )}
                                    {(() => {
                                        const local = resolveLocalCapabilityBadge(detail);
                                        return local ? <LocalBadges badge={local} /> : null;
                                    })()}
                                    {isMarketAudioUnavailableApp(detail) && !LOCAL_AUDIO_HAS_SENSEVOICE && (
                                        <StatusBadge variant="filled" tone="warning" label={LOCAL_AUDIO_UNAVAILABLE_LABEL} size="sm" />
                                    )}
                                    {r18On && appShowsR18Badge(detail) && (
                                        <StatusBadge variant="filled" tone="warning" label="R18" size="sm" />
                                    )}
                                </div>
                                {canShowContentModeToggle(detail, r18On) && (
                                    <div className="flex flex-col gap-2" role="group" aria-label="内容模式">
                                        <p className="text-xs font-medium">内容模式</p>
                                        <div className="flex flex-wrap gap-1.5">
                                            {(
                                                [
                                                    { id: "sfw" as const, label: "SFW" },
                                                    { id: "nsfw" as const, label: "R18" },
                                                ] as const
                                            ).map((m) => {
                                                const active = contentMode === m.id;
                                                return (
                                                    <button
                                                        key={m.id}
                                                        type="button"
                                                        onClick={() => setContentMode(m.id)}
                                                        className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                                                            active
                                                                ? "border-[var(--workspace-accent)] bg-[var(--surface-active)]"
                                                                : "border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--workspace-accent)]"
                                                        }`}
                                                    >
                                                        {m.label}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                        <p className="text-[11px] text-[var(--muted-foreground)]">
                                            R18 使用软隐藏孪生工作流；关闭设置里的 R18 模式后不会提交成人向。
                                        </p>
                                    </div>
                                )}
                                {r18On && detail.is_nsfw && !canShowContentModeToggle(detail, r18On) && (
                                    <Callout tone="warning" title="R18 专用应用">
                                        本卡仅成人向工作流；须保持 R18 模式开启才能运行。
                                    </Callout>
                                )}
                                {audioBlocked && (
                                    <Callout tone="warning" title="本地音频能力未接">
                                        SenseVoice 未接线，本应用不可在此页运行（勿当已配置）。音乐生成等非 SenseVoice 应用不受影响。
                                    </Callout>
                                )}
                                {(modesLoading || modeChips.length > 0) && (
                                    <div className="flex flex-col gap-2">
                                        <p className="text-xs font-medium">模式 / 扩展</p>
                                        {modesLoading ? (
                                            <p className="text-[11px] text-[var(--muted-foreground)]">加载模式…</p>
                                        ) : (
                                            <div className="flex flex-wrap gap-1.5">
                                                {modeChips.map((m) => {
                                                    const active = m.app_id === detail.id;
                                                    return (
                                                        <button
                                                            key={m.app_id}
                                                            type="button"
                                                            title={m.desc || m.label}
                                                            onClick={() => {
                                                                if (!active) void openDetail(m.app_id);
                                                            }}
                                                            className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                                                                active
                                                                    ? "border-[var(--workspace-accent)] bg-[var(--surface-active)]"
                                                                    : "border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--workspace-accent)]"
                                                            }`}
                                                        >
                                                            {m.label}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                )}
                                <p className="text-sm leading-relaxed">{detail.description}</p>
                                {detail.guide_purpose && (
                                    <div className="rounded-xl bg-[var(--muted)] p-3 text-xs leading-relaxed text-[var(--muted-foreground)]">
                                        {detail.guide_purpose}
                                    </div>
                                )}

                                {(paramSplit.core.length > 0 ||
                                    paramSplit.convenience.length > 0 ||
                                    paramSplit.advanced.length > 0 ||
                                    paramSplit.deep.length > 0) && (
                                    <div className="flex flex-col gap-2 border-t border-[var(--border)] pt-3">
                                        <p className="text-xs font-medium">运行参数</p>
                                        {[...paramSplit.core, ...paramSplit.convenience].map((p) => (
                                            <ParamField
                                                key={p.key}
                                                param={p}
                                                value={values[p.key]}
                                                onChange={onParamChange}
                                                uploadKind={detail ? appUploadKind(detail.id) : "img2img"}
                                                pinWorker={firstPinWorker(values)}
                                                disabled={audioBlocked || running}
                                            />
                                        ))}
                                        {paramSplit.advanced.length > 0 && (
                                            <div className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--muted)]/30 p-2.5">
                                                <button
                                                    type="button"
                                                    className="flex w-full items-center justify-between gap-2 text-left text-xs font-medium text-foreground"
                                                    onClick={() => setAdvOpen((v) => !v)}
                                                    aria-expanded={advOpen}
                                                    data-testid="market-advanced-toggle"
                                                >
                                                    <span>
                                                        常用高级（{paramSplit.advanced.length}）
                                                        {r18On && appShowsR18Badge(detail) ? " · R18 可调" : ""}
                                                    </span>
                                                    <span className="text-[11px] text-[var(--muted-foreground)]">
                                                        {advOpen ? "收起 ▴" : "展开 ▾"}
                                                    </span>
                                                </button>
                                                {!advOpen && (
                                                    <p className="text-[11px] text-[var(--muted-foreground)]">
                                                        步数 / CFG / 种子 / 负向 / 重绘幅度等；默认收起，不吓新手。
                                                    </p>
                                                )}
                                                {advOpen && (
                                                    <div className="flex flex-col gap-2" data-testid="market-advanced-body">
                                                        {paramSplit.advanced.map((p) => (
                                                            <ParamField
                                                                key={p.key}
                                                                param={p}
                                                                value={values[p.key]}
                                                                onChange={onParamChange}
                                                                uploadKind={detail ? appUploadKind(detail.id) : "img2img"}
                                                                pinWorker={firstPinWorker(values)}
                                                                disabled={audioBlocked || running}
                                                            />
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                        {paramSplit.deep.length > 0 && (
                                            <div className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--muted)]/20 p-2.5">
                                                <button
                                                    type="button"
                                                    className="flex w-full items-center justify-between gap-2 text-left text-xs font-medium text-foreground"
                                                    onClick={() => setDeepOpen((v) => !v)}
                                                    aria-expanded={deepOpen}
                                                    data-testid="market-deep-toggle"
                                                >
                                                    <span>更深参数（{paramSplit.deep.length}）</span>
                                                    <span className="text-[11px] text-[var(--muted-foreground)]">
                                                        {deepOpen ? "收起 ▴" : "展开 ▾"}
                                                    </span>
                                                </button>
                                                {!deepOpen && (
                                                    <p className="text-[11px] text-[var(--muted-foreground)]">
                                                        LoRA 叠加 / 输出超分等；仅本卡后端可接时显示。
                                                    </p>
                                                )}
                                                {deepOpen && (
                                                    <div className="flex flex-col gap-2" data-testid="market-deep-body">
                                                        {paramSplit.deep.map((p) => (
                                                            <ParamField
                                                                key={p.key}
                                                                param={p}
                                                                value={values[p.key]}
                                                                onChange={onParamChange}
                                                                uploadKind={detail ? appUploadKind(detail.id) : "img2img"}
                                                                pinWorker={firstPinWorker(values)}
                                                                disabled={audioBlocked || running}
                                                            />
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                )}

                                {runMsg && (
                                    <p className={`text-xs ${runFailed ? "text-[var(--destructive)]" : "text-[var(--muted-foreground)]"}`} role="status">
                                        {runMsg}
                                        {isStillRunningMessage(runMsg) && (
                                            <>
                                                {" · "}
                                                <TasksCenterLink className="underline underline-offset-2" />
                                            </>
                                        )}
                                    </p>
                                )}
                                {missing && (
                                    <p className="text-xs text-[var(--destructive)]">还差必填项：{missing}</p>
                                )}

                                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] pt-3">
                                    <span className="text-xs text-[var(--muted-foreground)]">
                                        作者 {detail.author || "—"} · {detail.usage_count ?? 0} 次使用
                                    </span>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <ToolButton
                                            variant="default"
                                            size="sm"
                                            icon={registered ? <Sparkles /> : <Plus />}
                                            label={registered ? "取消画布注册" : "注册到画布"}
                                            onClick={onToggleProvider}
                                        />
                                        <ToolButton
                                            variant="default"
                                            size="sm"
                                            icon={<Play />}
                                            label={audioBlocked ? "音频未接" : "运行此应用"}
                                            loading={running}
                                            disabled={!!missing || detailLoading || audioBlocked}
                                            onClick={() => void onRun()}
                                        />
                                    </div>
                                </div>
                                <p className="text-[11px] leading-relaxed text-[var(--muted-foreground)]">
                                    上传的媒体素材随运行一起提交；作业进任务中心。「注册到画布」把应用加入画布的可用工具清单。
                                </p>
                            </>
                        )}
                    </div>
                )}
            </AppDrawer>
        </div>
        </WorkspacePage>
    );
}
