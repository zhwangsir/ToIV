import { ArrowLeft, FolderOpen, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";

import LibraryWorks from "./library-works";
import LibraryTranscriptSearch from "./library-transcript-search";
import { ToolButton } from "@/components/ui/base/buttons";
import { ToivEmptyState } from "@/components/toiv/toiv-empty-state";
import { ToivSkeletonGrid } from "@/components/toiv/toiv-skeleton";
import "@/styles/toiv-freezone-desk.css";
import { WorkspacePage } from "@/components/layout/workspace-page";
import { MediaLibrarySourceRail } from "@/components/library/media-library-source-rail";
import { mediaLibraryWorksDetailPath, type MediaLibrarySource } from "@/lib/media-library-routes";
import { formatDateTime } from "@/lib/time-format";
import { fetchBoards, fetchToivWorkCounts, type ToivBoard } from "@/services/toiv/client";
import { fetchToivAccountRole, isTranscriptSearchAvailable } from "@/services/toiv/transcript-search";

type LibraryTab = "works" | "boards" | "transcript";

export type LibraryPageProps = {
    /** W4: when true, omit WorkspacePage + source rail (owned by MediaLibraryPage). */
    embedded?: boolean;
    onRailActiveChange?: (active: MediaLibrarySource | undefined) => void;
    onWorksCountChange?: (count: number | undefined) => void;
};

export default function LibraryPage({
    embedded = false,
    onRailActiveChange,
    onWorksCountChange,
}: LibraryPageProps = {}) {
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
            .then((c) => {
                const total = Object.values(c).reduce((a, b) => a + (Number(b) || 0), 0);
                setWorksCount(total);
                onWorksCountChange?.(total);
            })
            .catch(() => {
                setWorksCount(undefined);
                onWorksCountChange?.(undefined);
            });
    }, [onWorksCountChange]);

    useEffect(() => {
        onRailActiveChange?.(activeTab === "works" ? "works" : undefined);
    }, [activeTab, onRailActiveChange]);

    const body = (
        <>
            <div className="fz-desk-page mx-auto flex w-full max-w-6xl flex-col gap-3">
            <header className="fz-desk-toolbar">
                <h1>作品</h1>
                <p>{activeTab === "works" ? "生成作品 · 普通态仅普通内容" : activeTab === "transcript" ? "台词检索（管理员）" : "成片与分镜画板"}</p>
                <div className="fz-desk-actions">
                    {activeTab === "boards" && (
                        <ToolButton variant="default" icon={<RefreshCw />} label="刷新" onClick={() => void load()} loading={loading} />
                    )}
                    <Link to="/"><ToolButton variant="default" icon={<ArrowLeft />} label="返回首页" /></Link>
                </div>
                <div className="fz-pill-row w-full" role="tablist" aria-label="作品库来源">
                    {(transcriptVisible
                        ? ([["works", "作品"], ["boards", "画板"], ["transcript", "台词检索"]] as const)
                        : ([["works", "作品"], ["boards", "画板"]] as const)
                    ).map(([k, label]) => (
                        <button key={k} type="button" role="tab" aria-selected={activeTab === k}
                            onClick={() => setTab(k)}
                            className={"fz-pill" + (activeTab === k ? " is-active" : "")}
                            data-testid={`library-tab-${k}`}>{label}</button>
                    ))}
                </div>
            </header>

            {activeTab === "works" ? (
                <LibraryWorks />
            ) : activeTab === "transcript" ? (
                <LibraryTranscriptSearch />
            ) : loading ? (
                <ToivSkeletonGrid count={8} />
            ) : error ? (
                <ToivEmptyState
                    className="fz-panel fz-auth-gap"
                    icon={RefreshCw}
                    title="画板列表暂不可用"
                    description="可能是会话失效或接口未就绪（含 401）。请刷新重试。"
                    action={<button type="button" className="toiv-empty-cta" onClick={() => void load()}>重试加载</button>}
                />
            ) : boards.length === 0 ? (
                <ToivEmptyState
                    className="fz-panel"
                    icon={FolderOpen}
                    title="画板还是空的"
                    description="完成第一个短剧项目后会出现在这里。"
                    action={<Link to="/toiv/drama" className="toiv-empty-cta">去短剧项目</Link>}
                />
            ) : (
                <div className="fz-dense-grid">
                    {boards.map((board) => (
                        <Link key={board.id} to={mediaLibraryWorksDetailPath(board.id)} className="fz-card is-compact group">
                            <div className="fz-card-poster flex items-center justify-center" aria-hidden>
                                {board.cover_url
                                    ? <img src={board.cover_url} alt="" className="h-full w-full rounded-[7px] object-cover" />
                                    : <FolderOpen className="h-5 w-5 text-[var(--fz-muted)]" />}
                            </div>
                            <p className="fz-card-title" title={board.name}>{board.name}</p>
                            <p className="fz-card-meta">{board.item_count} 件 · {formatDateTime(board.created_at)}</p>
                        </Link>
                    ))}
                </div>
            )}
            </div>
            {!embedded ? (
                <MediaLibrarySourceRail active={activeTab === "works" ? "works" : undefined} worksCount={worksCount ?? boards.length} />
            ) : null}
        </>
    );

    if (embedded) return body;

    return (
        <WorkspacePage fluid className="toiv-library-page library-page assets-library-page fz-desk">
            {body}
        </WorkspacePage>
    );
}
