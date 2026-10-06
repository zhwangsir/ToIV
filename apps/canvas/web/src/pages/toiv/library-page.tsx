import { App as AntApp, Button, Spin, Typography } from "antd";
import { ArrowLeft, FolderOpen, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";

import { fetchBoards, type ToivBoard } from "@/services/toiv/client";
import { EmptyState } from "@/components/ui/product/empty-state";

function formatTime(value: string): string {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export default function LibraryPage() {
    const { message } = AntApp.useApp();
    const [boards, setBoards] = useState<ToivBoard[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);

    const load = useCallback(async () => {
        setLoading(true); setError(false);
        try {
            setBoards(await fetchBoards());
        } catch {
            setError(true);
            message.error("作品库读取失败");
        } finally {
            setLoading(false);
        }
    }, [message]);

    useEffect(() => { void load(); }, [load]);

    return (
        <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-6">
            <header className="flex items-center justify-between">
                <div className="flex flex-col gap-1">
                    <Typography.Title level={3} className="!mb-0">作品库</Typography.Title>
                    <Typography.Text type="secondary">ToIV 作品集与成片归档（实时域：/api/boards）</Typography.Text>
                </div>
                <div className="flex items-center gap-2">
                    <Button icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => void load()} loading={loading}>刷新</Button>
                    <Link to="/"><Button icon={<ArrowLeft className="h-3.5 w-3.5" />}>返回首页</Button></Link>
                </div>
            </header>

            {loading ? (
                <div className="flex min-h-64 items-center justify-center"><Spin /></div>
            ) : error ? (
                <EmptyState description="读取失败，请刷新重试" />
            ) : boards.length === 0 ? (
                <EmptyState description="作品库还是空的；完成第一个短剧项目后会出现在这里" />
            ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
                    {boards.map((board) => (
                        <Link
                            key={board.id}
                            to={`/toiv/library/${board.id}`}
                            className="group flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--card,#181818)] p-4 transition-colors hover:border-[var(--workspace-accent,#f5f5f5)]"
                        >
                            <div className="flex h-28 items-center justify-center rounded-xl bg-[var(--muted,rgba(255,255,255,0.06))]">
                                {board.cover_url
                                    ? <img src={board.cover_url} alt="" className="h-full w-full rounded-xl object-cover" />
                                    : <FolderOpen className="h-8 w-8 text-[var(--muted-foreground,#a8a8a8)]" />}
                            </div>
                            <div className="flex flex-col gap-1">
                                <p className="truncate text-sm font-medium" title={board.name}>{board.name}</p>
                                <p className="text-xs text-[var(--muted-foreground,#a8a8a8)]">
                                    {board.item_count} 件作品 · {formatTime(board.created_at)}
                                </p>
                            </div>
                        </Link>
                    ))}
                </div>
            )}
        </main>
    );
}
