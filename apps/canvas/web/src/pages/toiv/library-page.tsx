import { ArrowLeft, FolderOpen, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";

import { MediaLibrarySourceRail } from "@/components/library/media-library-source-rail";
import LibraryWorks from "./library-works";
import LibraryTranscriptSearch from "./library-transcript-search";
import { ToolButton } from "@/components/ui/base/buttons";
import { EmptyState } from "@/components/ui/product/empty-state";
import { WorkspacePage } from "@/components/layout/workspace-page";
import { mediaLibraryWorksDetailPath } from "@/lib/media-library-routes";
import { formatDateTime } from "@/lib/time-format";
import { fetchBoards, fetchToivWorkCounts, type ToivBoard } from "@/services/toiv/client";
import { fetchToivAccountRole, isTranscriptSearchAvailable } from "@/services/toiv/transcript-search";

type LibraryTab = "works" | "boards" | "transcript";

export default function LibraryPage() {
    const [tab, setTab] = useState<LibraryTab>("works");
    const [boards, setBoards] = useState<ToivBoard[]>([]);
    const [worksCount, setWorksCount] = useState<number | undefined>(undefined);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    // F11:「台词检索」是管理端点(/admin/media/transcripts/search),仅 admin 角色露出 tab;
    // 角色来自既有账号会话面 GET /api/auth/me(fetchToivAccountRole),失败=null=隐藏(失败关闭)。
    const [role, setRole] = useState<string | null>(null);
    const transcriptVisible = isTranscriptSearchAvailable(role);
    const activeTab: LibraryTab = tab === "transcript" && !transcriptVisible ? "works" : tab;

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

    useEffect(() => { if (activeTab === "boards") void load(); }, [load, activeTab]);
    useEffect(() => {
        void fetchToivAccountRole().then(setRole);
    }, []);
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
                    <p className="text-xs leading-5 text-muted-foreground">{activeTab === "works" ? "我生成的作品（SFW；R18 作品请到经典端查看）" : activeTab === "transcript" ? "已转录媒体的台词全文检索（仅管理员）" : "成片与分镜作品集"}</p>
                <div className="mt-2 flex items-center gap-1" role="tablist" aria-label="作品库来源">
                    {(transcriptVisible
                        ? ([["works", "作品"], ["boards", "画板"], ["transcript", "台词检索"]] as const)
                        : ([["works", "作品"], ["boards", "画板"]] as const)
                    ).map(([k, label]) => (
                        <button key={k} type="button" role="tab" aria-selected={activeTab === k}
                            onClick={() => setTab(k)}
                            className={`rounded-full border px-3 py-1 text-xs transition-colors ${activeTab === k
                                ? "border-transparent bg-[var(--workspace-accent)] text-[var(--workspace-accent-foreground)]"
                                : "border-[var(--border-semantic,var(--border))] text-muted-foreground hover:text-foreground"}`}
                            data-testid={`library-tab-${k}`}>{label}</button>
                    ))}
                </div>
                </div>
                <div className="flex items-center gap-2">
                    {/* 刷新只重载画板列表;作品/台词检索面各自带刷新,这里再放一个会变成点了没反应 */}
                    {activeTab === "boards" && (
                        <ToolButton variant="default" icon={<RefreshCw />} label="刷新" onClick={() => void load()} loading={loading} />
                    )}
                    <Link to="/"><ToolButton variant="default" icon={<ArrowLeft />} label="返回首页" /></Link>
                </div>
            </header>

            {activeTab === "works" ? (
                <LibraryWorks />
            ) : activeTab === "transcript" ? (
                <LibraryTranscriptSearch />
            ) : loading ? (
                <div className="flex min-h-64 items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="加载中" /></div>
            ) : error ? (
                <EmptyState description="读取失败，请刷新重试" />
            ) : boards.length === 0 ? (
                <EmptyState description="画板还是空的；完成第一个短剧项目后会出现在这里" />
            ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
                    {boards.map((board) => (
                        <Link
                            key={board.id}
                            to={mediaLibraryWorksDetailPath(board.id)}
                            className="group flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 transition-colors hover:border-[var(--workspace-accent)]"
                        >
                            <div className="flex h-28 items-center justify-center rounded-xl bg-[var(--muted)]">
                                {board.cover_url
                                    ? <img src={board.cover_url} alt="" className="h-full w-full rounded-xl object-cover" />
                                    : <FolderOpen className="h-8 w-8 text-muted-foreground" />}
                            </div>
                            <div className="flex flex-col gap-1">
                                <p className="truncate text-sm font-medium" title={board.name}>{board.name}</p>
                                <p className="text-xs text-muted-foreground">
                                    {board.item_count} 件作品 · {formatDateTime(board.created_at)}
                                </p>
                            </div>
                        </Link>
                    ))}
                </div>
            )}
            </div>
            {/* rail 高亮跟随当前页签：画板/台词检索不是来源项，不硬指「作品」误导 */}
            <MediaLibrarySourceRail active={activeTab === "works" ? "works" : undefined} worksCount={worksCount ?? boards.length} />
        </WorkspacePage>
    );
}
