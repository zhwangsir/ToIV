import { ArrowLeft, Loader2, Play, Plus, RefreshCw, Search, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import { ToolButton } from "@/components/ui/base/buttons";
import { StatusBadge } from "@/components/ui/base/badges";
import { AppDrawer } from "@/components/ui/product/app-drawer";
import { EmptyState } from "@/components/ui/product/empty-state";
import {
    buildDefaultRunValues,
    buildToivRunValues,
    fetchToivApp,
    fetchToivApps,
    requiredToivParamLabel,
    runToivApp,
    type ToivApp,
    type ToivAppParam,
} from "@/services/toiv/client";
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

function smokeBadge(app: ToivApp) {
    if (app.smoke_status === "pass") return <StatusBadge variant="filled" tone="success" label="烟测通过" size="sm" />;
    if (app.smoke_status === "fail") return <StatusBadge variant="filled" tone="error" label="烟测失败" size="sm" />;
    if (app.smoke_status) return <StatusBadge variant="filled" tone="neutral" label={app.smoke_status} size="sm" />;
    return null;
}

function ParamField({
    param,
    value,
    onChange,
}: {
    param: ToivAppParam;
    value: unknown;
    onChange: (key: string, next: unknown) => void;
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
        const count = Array.isArray(value) ? value.length : 0;
        return (
            <div className="rounded-md border border-dashed border-[var(--border)] px-3 py-2 text-xs text-[var(--muted-foreground,#a8a8a8)]">
                <p className="font-medium text-foreground">{param.label}</p>
                <p className="mt-1">
                    本页暂不支持上传媒体（已填 {count} 项）。若该参数必填，请先在旧运行台补齐，或等待后续切片。
                </p>
            </div>
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

    const filtered = useMemo(
        () =>
            apps.filter((a) => {
                if (category !== "all" && (a.category || "other") !== category) return false;
                if (!q.trim()) return true;
                const needle = q.trim().toLowerCase();
                return (
                    (a.name ?? "").toLowerCase().includes(needle) ||
                    (a.description ?? "").toLowerCase().includes(needle) ||
                    (a.guide_purpose ?? "").toLowerCase().includes(needle)
                );
            }),
        [apps, category, q],
    );

    const schema = detail?.params_schema ?? [];
    const missing = detail ? requiredToivParamLabel(schema, values) : null;
    const registered = useMemo(
        () => (detail ? isMarketCanvasProvider(detail.id) : false),
        [detail, providerTick],
    );

    const onParamChange = (key: string, next: unknown) => {
        setValues((prev) => ({ ...prev, [key]: next }));
    };

    const onRun = async () => {
        if (!detail?.id || missing) return;
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
                <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
                    {filtered.map((app) => (
                        <button
                            key={app.id}
                            type="button"
                            onClick={() => void openDetail(app)}
                            className="group flex flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card,#181818)] text-left transition-colors hover:border-[var(--workspace-accent,#555)]"
                        >
                            <div className="flex h-28 items-center justify-center bg-[var(--muted,rgba(255,255,255,0.05))]">
                                {app.cover_url ? (
                                    <img src={app.cover_url} alt="" className="h-full w-full object-cover" loading="lazy" />
                                ) : (
                                    <span className="text-2xl opacity-40">{CATEGORY_META[app.category || "other"] ?? "应"}</span>
                                )}
                            </div>
                            <div className="flex flex-1 flex-col gap-1.5 p-3">
                                <p className="truncate text-sm font-medium">{app.name}</p>
                                <p className="line-clamp-2 min-h-8 text-xs text-[var(--muted-foreground,#a8a8a8)]">
                                    {app.guide_purpose || app.description}
                                </p>
                                <div className="mt-auto flex items-center justify-between pt-1">
                                    {smokeBadge(app)}
                                    <span className="text-[11px] text-[var(--muted-foreground,#a8a8a8)]">
                                        {app.usage_count ?? 0} 次使用
                                    </span>
                                </div>
                            </div>
                        </button>
                    ))}
                </div>
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
                                </div>
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
                                            <ParamField key={p.key} param={p} value={values[p.key]} onChange={onParamChange} />
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
                                            label="运行此应用"
                                            loading={running}
                                            disabled={!!missing || detailLoading}
                                            onClick={() => void onRun()}
                                        />
                                    </div>
                                </div>
                                <p className="text-[11px] leading-relaxed text-[var(--muted-foreground,#a8a8a8)]">
                                    运行将创建 ToIV 作业并跳转任务中心；「注册到画布」写入本地 provider 清单（节点接线后续切片）。
                                </p>
                            </>
                        )}
                    </div>
                )}
            </AppDrawer>
        </main>
    );
}
