import { ArrowLeft, FolderOpen, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";

import { MediaLibrarySourceRail } from "@/components/library/media-library-source-rail";
import LibraryWorks from "./library-works";
import { ToolButton } from "@/components/ui/base/buttons";
import { EmptyState } from "@/components/ui/product/empty-state";
import { WorkspacePage } from "@/components/layout/workspace-page";
import { mediaLibraryWorksDetailPath } from "@/lib/media-library-routes";
import { fetchBoards, fetchToivWorkCounts, type ToivBoard } from "@/services/toiv/client";

function formatTime(value: string): string {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export default function LibraryPage() {
    const [tab, setTab] = useState<"works" | "boards">("works");
    const [boards, setBoards] = useState<ToivBoard[]>([]);
    const [worksCount, setWorksCount] = useState<number | undefined>(undefined);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);

    const load = useCallback(async () => {
        setLoading(true); setError(false);
        try {
            setBoards(await fetchBoards());
        } catch {
            setError(true);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { if (tab === "boards") void load(); }, [load, tab]);
    useEffect(() => {
        // 侧栏「作品」计数要反映 jobs 总数,不是画板数(否则恒 0 误导)
        fetchToivWorkCounts()
            .then((c) => setWorksCount(Object.values(c).reduce((a, b) => a + (Number(b) || 0), 0)))
            .catch(() => setWorksCount(undefined));
    }, []);

    return (
        <WorkspacePage fluid className="toiv-library-page library-page assets-library-page">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-6">
            <header className="flex items-center justify-between">
                <div className="flex flex-col gap-1">
                    <h1 className="text-xl font-semibold leading-7 text-foreground">作品</h1>
                    <p className="text-xs leading-5 text-muted-foreground">{tab === "works" ? "我的生成作品（/api/jobs · SFW；R18 作品仍在经典壳）" : "成片与分镜作品集（/api/boards）"}</p>
                <div className="mt-2 flex items-center gap-1" role="tablist" aria-label="作品库来源">
                    {([["works", "作品"], ["boards", "画板"]] as const).map(([k, label]) => (
                        <button key={k} type="button" role="tab" aria-selected={tab === k}
                            onClick={() => setTab(k)}
                            className={`rounded-full border px-3 py-1 text-xs transition-colors ${tab === k
                                ? "border-transparent bg-[var(--workspace-accent,#f5f5f5)] text-[var(--workspace-accent-foreground,#111)]"
                                : "border-[var(--border-semantic,var(--border,#333))] text-muted-foreground hover:text-foreground"}`}
                            data-testid={`library-tab-${k}`}>{label}</button>
                    ))}
                </div>
                </div>
                <div className="flex items-center gap-2">
                    <ToolButton variant="default" icon={<RefreshCw />} label="刷新" onClick={() => void load()} loading={loading} />
                    <Link to="/"><ToolButton variant="default" icon={<ArrowLeft />} label="返回首页" /></Link>
                </div>
            </header>

            {tab === "works" ? (
                <LibraryWorks />
            ) : loading ? (
                <div className="flex min-h-64 items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="加载中" /></div>
            ) : error ? (
                <EmptyState description="读取失败，请刷新重试" />
            ) : boards.length === 0 ? (
                <EmptyState description="作品库还是空的；完成第一个短剧项目后会出现在这里" />
            ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
                    {boards.map((board) => (
                        <Link
                            key={board.id}
                            to={mediaLibraryWorksDetailPath(board.id)}
                            className="group flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 transition-colors hover:border-[var(--workspace-accent,#f5f5f5)]"
                        >
                            <div className="flex h-28 items-center justify-center rounded-xl bg-[var(--muted,rgba(255,255,255,0.06))]">
                                {board.cover_url
                                    ? <img src={board.cover_url} alt="" className="h-full w-full rounded-xl object-cover" />
                                    : <FolderOpen className="h-8 w-8 text-muted-foreground" />}
                            </div>
                            <div className="flex flex-col gap-1">
                                <p className="truncate text-sm font-medium" title={board.name}>{board.name}</p>
                                <p className="text-xs text-muted-foreground">
                                    {board.item_count} 件作品 · {formatTime(board.created_at)}
                                </p>
                            </div>
                        </Link>
                    ))}
                </div>
            )}
            </div>
            <MediaLibrarySourceRail active="works" worksCount={worksCount ?? boards.length} />
        </WorkspacePage>
    );
}
