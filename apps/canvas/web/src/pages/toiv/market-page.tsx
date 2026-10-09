import { ArrowLeft, Loader2, Play, Plus, RefreshCw, Search, Sparkles, Upload, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import { ToolButton } from "@/components/ui/base/buttons";
import { StatusBadge } from "@/components/ui/base/badges";
import { AppDrawer } from "@/components/ui/product/app-drawer";
import { Callout } from "@/components/ui/product/callout";
import { EmptyState } from "@/components/ui/product/empty-state";
import { LOCAL_AUDIO_HAS_SENSEVOICE, LOCAL_AUDIO_UNAVAILABLE_LABEL } from "@/lib/local-model-defaults";
import {
    appUploadKind,
    asMarketMediaList,
    buildDefaultRunValues,
    buildToivRunValues,
    fetchToivApp,
    fetchToivAppVariants,
    fetchToivApps,
    firstPinWorker,
    requiredToivParamLabel,
    runToivApp,
    toivCoverImageUrl,
    uploadToivMedia,
    type MarketMediaHandle,
    type ToivApp,
    type ToivAppModeItem,
    type ToivAppParam,
} from "@/services/toiv/client";
import {
    LOCAL_MARKET_FEATURED,
    isMarketAudioUnavailableApp,
    localMarketFeaturedAppIds,
    resolveLocalCapabilityBadge,
    sortAppsWithFeaturedIds,
    type LocalCapabilityBadge,
} from "@/services/toiv/local-capability-surface";
import {
    isMarketCanvasProvider,
    registerMarketCanvasProvider,
    unregisterMarketCanvasProvider,
} from "@/services/toiv/market-providers";

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


function LocalBadges({ badge }: { badge: LocalCapabilityBadge }) {
    return (
        <span className="flex flex-wrap items-center gap-1">
            <StatusBadge variant="filled" tone="success" label={badge.label} size="sm" />
            <StatusBadge variant="filled" tone="neutral" label={badge.worker} size="sm" />
            <StatusBadge variant="filled" tone="neutral" label={badge.engine} size="sm" />
        </span>
    );
}

function smokeBadge(app: ToivApp) {
    if (app.smoke_status === "pass") return <StatusBadge variant="filled" tone="success" label="烟测通过" size="sm" />;
    if (app.smoke_status === "fail") return <StatusBadge variant="filled" tone="error" label="烟测失败" size="sm" />;
    if (app.smoke_status) return <StatusBadge variant="filled" tone="neutral" label={app.smoke_status} size="sm" />;
    return null;
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
        <div className="relative aspect-[4/3] w-full overflow-hidden bg-[var(--muted,rgba(255,255,255,0.05))]">
            {showImg ? (
                <img
                    src={src}
                    alt=""
                    className="h-full w-full object-cover"
                    loading="lazy"
                    onError={() => setFailed(true)}
                />
            ) : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-[var(--muted-foreground,#a8a8a8)]">
                    <span className="text-2xl opacity-50" aria-hidden>
                        {CATEGORY_META[category || "other"] ?? "应"}
                    </span>
                    <span className="text-[10px] opacity-60">暂无封面</span>
                </div>
            )}
        </div>
    );
}

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
                <span className="text-[11px] text-[var(--muted-foreground,#a8a8a8)]">
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
                                <span className="grid h-8 w-8 place-items-center rounded bg-[var(--muted,rgba(255,255,255,0.06))] text-[10px]">
                                    {kindLabel[0]}
                                </span>
                            )}
                            <span className="min-w-0 flex-1 truncate" title={item.name || item.filename}>
                                {item.name || item.filename}
                            </span>
                            <button
                                type="button"
                                className="rounded p-1 text-[var(--muted-foreground,#a8a8a8)] hover:text-foreground"
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
                    className="flex items-center justify-center gap-1.5 rounded-md border border-dashed border-[var(--border)] px-3 py-2 text-[var(--muted-foreground,#a8a8a8)] transition-colors hover:border-[var(--workspace-accent,#666)] hover:text-foreground disabled:opacity-50"
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
                <p className="text-[11px] text-[var(--muted-foreground,#a8a8a8)]">{param.hint}</p>
            )}
            {error && <p className="text-[11px] text-[var(--destructive,#f87171)]">{error}</p>}
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
        "w-full rounded-md border border-[var(--border)] bg-transparent px-3 py-1.5 text-xs outline-none focus:border-[var(--workspace-accent,#888)]";

    if (param.type === "switch") {
        return (
            <label className="flex items-center justify-between gap-3 text-xs">
                <span className="text-[var(--muted-foreground,#a8a8a8)]">{param.label}</span>
                <input
                    id={id}
                    type="checkbox"
                    checked={Boolean(value)}
                    onChange={(e) => onChange(param.key, e.target.checked)}
                    className="h-4 w-4 accent-[var(--workspace-accent,#f5f5f5)]"
                />
            </label>
        );
    }

    if (param.type === "select") {
        return (
            <label className="flex flex-col gap-1 text-xs">
                <span className="text-[var(--muted-foreground,#a8a8a8)]">{param.label}</span>
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
                <span className="text-[var(--muted-foreground,#a8a8a8)]">{param.label}</span>
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
            <span className="text-[var(--muted-foreground,#a8a8a8)]">{param.label}</span>
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
    const [category, setCategory] = useState<string>("all");
    const [q, setQ] = useState("");
    const [detail, setDetail] = useState<ToivApp | null>(null);
    const [detailLoading, setDetailLoading] = useState(false);
    const [detailError, setDetailError] = useState<string | null>(null);
    const [values, setValues] = useState<Record<string, unknown>>({});
    const [running, setRunning] = useState(false);
    const [runMsg, setRunMsg] = useState<string | null>(null);
    const [providerTick, setProviderTick] = useState(0);
    const [modes, setModes] = useState<ToivAppModeItem[]>([]);
    const [modesLoading, setModesLoading] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        setError(false);
        try {
            setApps(await fetchToivApps({ limit: 500 }));
        } catch {
            setError(true);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

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
            try {
                const full = await fetchToivApp(id);
                setDetail(full);
                setValues(buildDefaultRunValues(full.params_schema ?? []));
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
        return [["all", apps.length], ...Array.from(set.entries())] as Array<[string, number]>;
    }, [apps]);

    const filtered = useMemo(() => {
        const base = apps.filter((a) => {
            if (category !== "all" && (a.category || "other") !== category) return false;
            if (!q.trim()) return true;
            const needle = q.trim().toLowerCase();
            return (
                (a.name ?? "").toLowerCase().includes(needle) ||
                (a.description ?? "").toLowerCase().includes(needle) ||
                (a.guide_purpose ?? "").toLowerCase().includes(needle) ||
                a.id.toLowerCase().includes(needle)
            );
        });
        if (category === "all" && !q.trim()) {
            return sortAppsWithFeaturedIds(base, localMarketFeaturedAppIds());
        }
        return base;
    }, [apps, category, q]);

    const featuredLocal = useMemo(() => {
        const byId = new Map(apps.map((a) => [a.id, a]));
        return LOCAL_MARKET_FEATURED.map((entry) => ({
            entry,
            app: entry.appId ? byId.get(entry.appId) : undefined,
        }));
    }, [apps]);

    const schema = detail?.params_schema ?? [];
    const missing = detail ? requiredToivParamLabel(schema, values) : null;
    const registered = useMemo(
        () => (detail ? isMarketCanvasProvider(detail.id) : false),
        [detail, providerTick],
    );
    const audioBlocked = Boolean(detail && isMarketAudioUnavailableApp(detail) && !LOCAL_AUDIO_HAS_SENSEVOICE);

    const onParamChange = (key: string, next: unknown) => {
        setValues((prev) => ({ ...prev, [key]: next }));
    };

    const onRun = async () => {
        if (!detail?.id || missing || audioBlocked) return;
        setRunning(true);
        setRunMsg(null);
        try {
            const receipt = await runToivApp(detail.id, buildToivRunValues(schema, values));
            if (!receipt.job_id) {
                setRunMsg("运行已提交，但未返回作业号");
                return;
            }
            setRunMsg(`已创建作业 ${receipt.job_id.slice(0, 8)}…，正在前往任务中心`);
            navigate(`/toiv/tasks?from=market&job=${encodeURIComponent(receipt.job_id)}`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : "运行失败";
            setRunMsg(msg);
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
        <main className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-6">
            <header className="flex items-center justify-between gap-4">
                <div className="flex flex-col gap-1">
                    <h1 className="text-xl font-semibold leading-7 text-foreground">应用市场</h1>
                    <p className="text-xs leading-5 text-[var(--muted-foreground,#a8a8a8)]">
                        ToIV 创作应用（原生页：列表 / 筛选 / 详情 / 运行 → 任务中心）
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <ToolButton variant="default" icon={<RefreshCw />} label="刷新" onClick={() => void load()} loading={loading} />
                    <Link to="/">
                        <ToolButton variant="default" icon={<ArrowLeft />} label="返回首页" />
                    </Link>
                </div>
            </header>

            <div className="flex flex-wrap items-center gap-2">
                {categories.map(([key, n]) => (
                    <button
                        key={key}
                        type="button"
                        onClick={() => setCategory(key)}
                        className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                            category === key
                                ? "border-[var(--workspace-accent,#f5f5f5)] bg-[var(--surface-active,rgba(255,255,255,0.1))]"
                                : "border-[var(--border)] text-[var(--muted-foreground,#a8a8a8)] hover:border-[var(--workspace-accent,#666)]"
                        }`}
                    >
                        {key === "all" ? `全部 ${n}` : `${CATEGORY_META[key] ?? key} ${n}`}
                    </button>
                ))}
                <label className="ml-auto flex w-56 items-center gap-2 rounded-md border border-[var(--border)] bg-transparent px-3 py-1.5 text-xs">
                    <Search className="h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground,#a8a8a8)]" aria-hidden />
                    <input
                        type="search"
                        placeholder="搜索应用"
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-[var(--muted-foreground,#a8a8a8)]"
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
                                <span className="text-[11px] text-[var(--muted-foreground,#a8a8a8)]">
                                    生图 · H3 · LongCat · VACE · Animate2 · Continue · Avatar · Wan
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
                                            className="flex w-44 shrink-0 flex-col gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--card,#181818)] p-3 text-left transition-colors hover:border-[var(--workspace-accent,#555)]"
                                        >
                                            <p className="truncate text-sm font-medium">{app?.name || entry.label}</p>
                                            <LocalBadges badge={badge} />
                                            <p className="line-clamp-2 text-[11px] text-[var(--muted-foreground,#a8a8a8)]">
                                                {app?.guide_purpose || app?.description || `本地 worker ${entry.worker}`}
                                            </p>
                                        </button>
                                    );
                                })}
                            </div>
                        </section>
                    )}
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
                        {filtered.map((app) => {
                            const local = resolveLocalCapabilityBadge(app);
                            return (
                                <button
                                    key={app.id}
                                    type="button"
                                    onClick={() => void openDetail(app)}
                                    className="group flex flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card,#181818)] text-left transition-colors hover:border-[var(--workspace-accent,#555)]"
                                >
                                    <CoverThumb coverUrl={app.cover_url} category={app.category} />
                                    <div className="flex flex-1 flex-col gap-1.5 p-3">
                                        <p className="truncate text-sm font-medium">{app.name}</p>
                                        <p className="line-clamp-2 min-h-8 text-xs text-[var(--muted-foreground,#a8a8a8)]">
                                            {app.guide_purpose || app.description}
                                        </p>
                                        {local && <LocalBadges badge={local} />}
                                        {isMarketAudioUnavailableApp(app) && !LOCAL_AUDIO_HAS_SENSEVOICE && (
                                            <StatusBadge variant="filled" tone="warning" label="音频未接" size="sm" />
                                        )}
                                        <div className="mt-auto flex items-center justify-between pt-1">
                                            {smokeBadge(app)}
                                            <span className="text-[11px] text-[var(--muted-foreground,#a8a8a8)]">
                                                {app.usage_count ?? 0} 次使用
                                            </span>
                                        </div>
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                </>
            )}

            <AppDrawer open={!!detail} onClose={closeDetail} width={440} title={detail?.name}>
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
                                </div>
                                {audioBlocked && (
                                    <Callout tone="warning" title="本地音频能力未接">
                                        SenseVoice 未接线，本应用不可在此页运行（勿当已配置）。音乐生成等非 SenseVoice 应用不受影响。
                                    </Callout>
                                )}
                                {(modesLoading || modes.length > 0) && (
                                    <div className="flex flex-col gap-2">
                                        <p className="text-xs font-medium">模式</p>
                                        {modesLoading ? (
                                            <p className="text-[11px] text-[var(--muted-foreground,#a8a8a8)]">加载模式…</p>
                                        ) : (
                                            <div className="flex flex-wrap gap-1.5">
                                                {modes.map((m) => {
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
                                                                    ? "border-[var(--workspace-accent,#f5f5f5)] bg-[var(--surface-active,rgba(255,255,255,0.1))]"
                                                                    : "border-[var(--border)] text-[var(--muted-foreground,#a8a8a8)] hover:border-[var(--workspace-accent,#666)]"
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
                                    <div className="rounded-xl bg-[var(--muted,rgba(255,255,255,0.05))] p-3 text-xs leading-relaxed text-[var(--muted-foreground,#a8a8a8)]">
                                        {detail.guide_purpose}
                                    </div>
                                )}

                                {schema.length > 0 && (
                                    <div className="flex flex-col gap-2 border-t border-[var(--border)] pt-3">
                                        <p className="text-xs font-medium">运行参数</p>
                                        {schema.map((p) => (
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

                                {runMsg && (
                                    <p className="text-xs text-[var(--muted-foreground,#a8a8a8)]" role="status">
                                        {runMsg}
                                    </p>
                                )}
                                {missing && (
                                    <p className="text-xs text-[var(--destructive,#f87171)]">还差必填项：{missing}</p>
                                )}

                                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] pt-3">
                                    <span className="text-xs text-[var(--muted-foreground,#a8a8a8)]">
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
                                <p className="text-[11px] leading-relaxed text-[var(--muted-foreground,#a8a8a8)]">
                                    媒体参数经 /api/upload 上传后随运行提交；作业进任务中心。「注册到画布」写入本地 provider 清单（节点接线后续切片）。
                                </p>
                            </>
                        )}
                    </div>
                )}
            </AppDrawer>
        </main>
    );
}
