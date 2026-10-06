import { App as AntApp, Badge, Button, Drawer, Input, Spin, Tag, Typography } from "antd";
import { ArrowLeft, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";

import { fetchToivApps, type ToivApp } from "@/services/toiv/client";
import { EmptyState } from "@/components/ui/product/empty-state";

const CATEGORY_META: Record<string, string> = {
    video: "视频", image: "图像", audio: "音频", drama: "短剧", tool: "工具", "3d": "3D", other: "其他",
};

function smokeBadge(app: ToivApp) {
    if (app.smoke_status === "pass") return <Tag color="success" bordered={false}>烟测通过</Tag>;
    if (app.smoke_status === "fail") return <Tag color="error" bordered={false}>烟测失败</Tag>;
    if (app.smoke_status) return <Tag bordered={false}>{app.smoke_status}</Tag>;
    return null;
}

export default function MarketPage() {
    const { message } = AntApp.useApp();
    const [apps, setApps] = useState<ToivApp[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [category, setCategory] = useState<string>("all");
    const [q, setQ] = useState("");
    const [detail, setDetail] = useState<ToivApp | null>(null);

    const load = useCallback(async () => {
        setLoading(true); setError(false);
        try { setApps(await fetchToivApps(200)); }
        catch { setError(true); message.error("市场读取失败"); }
        finally { setLoading(false); }
    }, [message]);

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
                    <Typography.Title level={3} className="!mb-0">应用市场</Typography.Title>
                    <Typography.Text type="secondary">ToIV 全部创作应用（实时域：/api/apps；运行跳转旧运行台）</Typography.Text>
                </div>
                <Link to="/"><Button icon={<ArrowLeft className="h-3.5 w-3.5" />}>返回首页</Button></Link>
            </header>

            <div className="flex flex-wrap items-center gap-2">
                {categories.map(([key, n]) => (
                    <button key={key} type="button"
                        onClick={() => setCategory(key)}
                        className={`rounded-full border px-3 py-1 text-xs transition-colors ${category === key ? "border-[var(--workspace-accent,#f5f5f5)] bg-[var(--surface-active,rgba(255,255,255,0.1))]" : "border-[var(--border)] text-[var(--muted-foreground,#a8a8a8)] hover:border-[var(--workspace-accent,#666)]"}`}>
                        {key === "all" ? `全部 ${n}` : `${CATEGORY_META[key] ?? key} ${n}`}
                    </button>
                ))}
                <Input allowClear prefix={<Search className="h-3.5 w-3.5" />} placeholder="搜索应用" value={q} onChange={(e) => setQ(e.target.value)} className="!ml-auto !w-56" />
            </div>

            {loading ? <div className="flex min-h-64 items-center justify-center"><Spin /></div>
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

            <Drawer open={!!detail} onClose={() => setDetail(null)} width={420} title={detail?.name}>
                {detail && (
                    <div className="flex flex-col gap-3">
                        <div className="flex flex-wrap gap-2">
                            {smokeBadge(detail)}
                            {detail.featured && <Tag color="gold" bordered={false}>精选</Tag>}
                            {detail.is_builtin && <Tag bordered={false}>官方</Tag>}
                            <Tag bordered={false}>{CATEGORY_META[detail.category || "other"] ?? detail.category}</Tag>
                            {detail.use_case && <Tag bordered={false}>{detail.use_case}</Tag>}
                        </div>
                        <p className="text-sm leading-relaxed">{detail.description}</p>
                        {detail.guide_purpose && (
                            <div className="rounded-xl bg-[var(--muted,rgba(255,255,255,0.05))] p-3 text-xs leading-relaxed text-[var(--muted-foreground,#a8a8a8)]">{detail.guide_purpose}</div>
                        )}
                        <div className="flex items-center justify-between pt-2">
                            <span className="text-xs text-[var(--muted-foreground,#a8a8a8)]">作者 {detail.author || "—"} · {detail.usage_count ?? 0} 次使用</span>
                            <a href={`/?view=market&app=${detail.id}&classic=1`}><Button type="primary">运行此应用</Button></a>
                        </div>
                    </div>
                )}
            </Drawer>
        </main>
    );
}
