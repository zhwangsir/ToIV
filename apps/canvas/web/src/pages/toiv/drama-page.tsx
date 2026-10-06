import { App as AntApp, Button, Empty, Progress, Spin, Tag, Typography } from "antd";
import { ArrowLeft, Clapperboard, Film, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";

import { fetchDramaProjects, type ToivDramaProject } from "@/services/toiv/client";

const STATUS_META: Record<string, { color: string; text: string }> = {
    draft: { color: "default", text: "草稿" },
    rendering: { color: "processing", text: "渲染中" },
    voiced: { color: "processing", text: "已配音" },
    lipsynced: { color: "processing", text: "已对口型" },
    done: { color: "success", text: "已完成" },
    error: { color: "error", text: "失败" },
};

function fmt(v?: string): string {
    if (!v) return "—";
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("zh-CN");
}

function ShotProgress({ p }: { p: NonNullable<ToivDramaProject["pipeline"]> }) {
    const total = p.total_shots || 0;
    const done = (p.by_status?.done ?? 0) + (p.by_status?.lipsynced ?? 0);
    return (
        <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-[11px] text-[var(--muted-foreground,#a8a8a8)]">
                <span>{total} 个分镜 · {done}/{total} 完成</span>
                <span>{Object.entries(p.by_status ?? {}).map(([k, n]) => `${STATUS_META[k]?.text ?? k}${n}`).join(" ")}</span>
            </div>
            <Progress percent={total ? Math.round((done / total) * 100) : 0} size="small" showInfo={false} />
            {p.next_step && <span className="text-[11px] text-[var(--muted-foreground,#a8a8a8)]">下一步:{p.next_step.label}(待办 {p.next_step.todo})</span>}
        </div>
    );
}

export default function DramaPage() {
    const { message } = AntApp.useApp();
    const [projects, setProjects] = useState<ToivDramaProject[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);

    const load = useCallback(async () => {
        setLoading(true); setError(false);
        try { setProjects(await fetchDramaProjects()); }
        catch { setError(true); message.error("短剧项目读取失败"); }
        finally { setLoading(false); }
    }, [message]);

    useEffect(() => { void load(); }, [load]);

    return (
        <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-6">
            <header className="flex items-center justify-between">
                <div className="flex flex-col gap-1">
                    <Typography.Title level={3} className="!mb-0">短剧工作台</Typography.Title>
                    <Typography.Text type="secondary">ToIV 短剧项目与分镜管线（实时域：/api/studio/projects；详情在原工作台打开）</Typography.Text>
                </div>
                <div className="flex items-center gap-2">
                    <Button icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => void load()} loading={loading}>刷新</Button>
                    <Link to="/"><Button icon={<ArrowLeft className="h-3.5 w-3.5" />}>返回首页</Button></Link>
                </div>
            </header>

            {loading ? <div className="flex min-h-64 items-center justify-center"><Spin /></div>
                : error ? <Empty description="读取失败，请刷新重试" />
                : projects.length === 0 ? <Empty description="还没有短剧项目；对智能体说「帮我把这个剧本做成短剧」即可开工" />
                : (
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-4">
                        {projects.map((p) => {
                            const meta = STATUS_META[p.status] ?? { color: "default", text: p.status };
                            return (
                                <a key={p.id} href={`/toiv/drama/${p.id}`}
                                    className="group flex flex-col gap-2.5 rounded-2xl border border-[var(--border)] bg-[var(--card,#181818)] p-4 transition-colors hover:border-[var(--workspace-accent,#555)]">
                                    <div className="flex items-center justify-between gap-2">
                                        <Tag color={meta.color} bordered={false}>{meta.text}</Tag>
                                        <span className="text-[11px] text-[var(--muted-foreground,#a8a8a8)]">{fmt(p.updated_at)}</span>
                                    </div>
                                    <p className="line-clamp-1 text-sm font-medium" title={p.title || p.premise}>
                                        {p.title || p.premise?.slice(0, 24) || "未命名项目"}
                                    </p>
                                    <p className="line-clamp-2 min-h-8 text-xs leading-relaxed text-[var(--muted-foreground,#a8a8a8)]">{p.premise}</p>
                                    {p.pipeline && <ShotProgress p={p.pipeline} />}
                                    <div className="mt-auto flex items-center justify-between pt-1">
                                        <span className="flex items-center gap-1 text-[11px] text-[var(--muted-foreground,#a8a8a8)]"><Film className="h-3 w-3" />{p.width}×{p.height} · {p.render_mode_default ?? "video"}</span>
                                        {p.final_url
                                            ? <Tag color="success" bordered={false}>有成片</Tag>
                                            : <span className="flex items-center gap-1 text-[11px] text-[var(--muted-foreground,#a8a8a8)]"><Clapperboard className="h-3 w-3" />打开工作台 →</span>}
                                    </div>
                                </a>
                            );
                        })}
                    </div>
                )}
        </main>
    );
}
