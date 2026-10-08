import { ArrowLeft, Loader2, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";

import { ToolButton } from "@/components/ui/base/buttons";
import { StatusBadge } from "@/components/ui/base/badges";
import { AppDrawer } from "@/components/ui/product/app-drawer";
import { EmptyState } from "@/components/ui/product/empty-state";
import { fetchToivApps, type ToivApp } from "@/services/toiv/client";

const CATEGORY_META: Record<string, string> = {
    video: "视频", image: "图像", audio: "音频", drama: "短剧", tool: "工具", "3d": "3D", other: "其他",
};

function smokeBadge(app: ToivApp) {
    if (app.smoke_status === "pass") return <StatusBadge variant="filled" tone="success" label="烟测通过" size="sm" />;
    if (app.smoke_status === "fail") return <StatusBadge variant="filled" tone="error" label="烟测失败" size="sm" />;
    if (app.smoke_status) return <StatusBadge variant="filled" tone="neutral" label={app.smoke_status} size="sm" />;
    return null;
}

export default function MarketPage() {
    const [apps, setApps] = useState<ToivApp[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [category, setCategory] = useState<string>("all");
    const [q, setQ] = useState("");
    const [detail, setDetail] = useState<ToivApp | null>(null);

    const load = useCallback(async () => {
        setLoading(true); setError(false);
        try { setApps(await fetchToivApps(200)); }
        catch { setError(true); }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { void load(); }, [load]);

    const categories = useMemo(() => {
        const set = new Map<string, number>();
        apps.forEach((a) => set.set(a.category || "other", (set.get(a.category || "other") ?? 0) + 1));
        return [["all", apps.length], ...set.entries()] as Array<[string, number]>;
    }, [apps]);

    const filtered = useMemo(() => apps.filter((a) => {
        if (category !== "all" && (a.category || "other") !== category) return false;
        if (!q.trim()) return true;
        const needle = q.trim().toLowerCase();
        return (a.name ?? "").toLowerCase().includes(needle) || (a.description ?? "").toLowerCase().includes(needle);
    }), [apps, category, q]);

    return (
        <main className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-6">
            <header className="flex items-center justify-between gap-4">
                <div className="flex flex-col gap-1">
                    <h1 className="text-xl font-semibold leading-7 text-foreground">应用市场</h1>
                    <p className="text-xs leading-5 text-[var(--muted-foreground,#a8a8a8)]">ToIV 全部创作应用（实时域：/api/apps；运行跳转旧运行台）</p>
                </div>
                <Link to="/"><ToolButton variant="default" icon={<ArrowLeft />} label="返回首页" /></Link>
            </header>

            <div className="flex flex-wrap items-center gap-2">
                {categories.map(([key, n]) => (
                    <button key={key} type="button"
                        onClick={() => setCategory(key)}
                        className={`rounded-full border px-3 py-1 text-xs transition-colors ${category === key ? "border-[var(--workspace-accent,#f5f5f5)] bg-[var(--surface-active,rgba(255,255,255,0.1))]" : "border-[var(--border)] text-[var(--muted-foreground,#a8a8a8)] hover:border-[var(--workspace-accent,#666)]"}`}>
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

            {loading ? <div className="flex min-h-64 items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="加载中" /></div>
                : error ? <EmptyState description="读取失败，请刷新重试" />
                : filtered.length === 0 ? <EmptyState description="没有匹配的应用" />
                : (
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
                        {filtered.map((app) => (
                            <button key={app.id} type="button" onClick={() => setDetail(app)}
                                className="group flex flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card,#181818)] text-left transition-colors hover:border-[var(--workspace-accent,#555)]">
                                <div className="flex h-28 items-center justify-center bg-[var(--muted,rgba(255,255,255,0.05))]">
                                    {app.cover_url
                                        ? <img src={app.cover_url} alt="" className="h-full w-full object-cover" loading="lazy" />
                                        : <span className="text-2xl opacity-40">{CATEGORY_META[app.category || "other"] ?? "应"}</span>}
                                </div>
                                <div className="flex flex-1 flex-col gap-1.5 p-3">
                                    <p className="truncate text-sm font-medium">{app.name}</p>
                                    <p className="line-clamp-2 min-h-8 text-xs text-[var(--muted-foreground,#a8a8a8)]">{app.description}</p>
                                    <div className="mt-auto flex items-center justify-between pt-1">
                                        {smokeBadge(app)}
                                        <span className="text-[11px] text-[var(--muted-foreground,#a8a8a8)]">{app.usage_count ?? 0} 次使用</span>
                                    </div>
                                </div>
                            </button>
                        ))}
                    </div>
                )}

            <AppDrawer open={!!detail} onClose={() => setDetail(null)} width={420} title={detail?.name}>
                {detail && (
                    <div className="flex flex-col gap-3">
                        <div className="flex flex-wrap gap-2">
                            {smokeBadge(detail)}
                            {detail.featured && <StatusBadge variant="filled" tone="warning" label="精选" size="sm" />}
                            {detail.is_builtin && <StatusBadge variant="filled" tone="neutral" label="官方" size="sm" />}
                            <StatusBadge variant="filled" tone="neutral" label={CATEGORY_META[detail.category || "other"] ?? detail.category} size="sm" />
                            {detail.use_case && <StatusBadge variant="filled" tone="neutral" label={detail.use_case} size="sm" />}
                        </div>
                        <p className="text-sm leading-relaxed">{detail.description}</p>
                        {detail.guide_purpose && (
                            <div className="rounded-xl bg-[var(--muted,rgba(255,255,255,0.05))] p-3 text-xs leading-relaxed text-[var(--muted-foreground,#a8a8a8)]">{detail.guide_purpose}</div>
                        )}
                        <div className="flex items-center justify-between pt-2">
                            <span className="text-xs text-[var(--muted-foreground,#a8a8a8)]">作者 {detail.author || "—"} · {detail.usage_count ?? 0} 次使用</span>
                            <a
                                href={`/?view=market&app=${detail.id}&classic=1`}
                                className="inline-flex h-8 select-none items-center justify-center rounded-md bg-foreground px-3 text-caption font-medium text-background transition-opacity hover:opacity-85"
                            >
                                运行此应用
                            </a>
                        </div>
                    </div>
                )}
            </AppDrawer>
        </main>
    );
}
