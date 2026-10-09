/**
 * ToIV 工具结果卡(M2 移植)：纯渲染、零 hooks；画布壳 token/Tailwind，不用 Next styled-jsx。
 */
import type { ReactNode } from "react";
import {
    Clapperboard,
    Cpu,
    Database,
    Image as ImageIcon,
    LayoutGrid,
    ShieldCheck,
    Sparkles,
    Video,
    Volume2,
    Box,
} from "lucide-react";

export interface ToolCardCtx {
    onApplyInput?: (text: string) => void;
    onOpenApp?: (appId: string) => void;
    onOpenBoard?: (boardId: string) => void;
    /** 对话产物一键入画布（提案 API 已接线；图结构落节点可后置）。 */
    onApplyToCanvas?: (payload: Record<string, unknown>) => void | Promise<void>;
}

export interface ToolCardProps {
    payload: Record<string, unknown>;
    ctx: ToolCardCtx;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const objArr = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)) : [];

const shell = "flex max-w-full min-w-[240px] flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--card,#181818)] p-3 text-xs text-foreground";
const label = "text-[10px] uppercase tracking-wide text-[var(--muted-foreground,#a8a8a8)]";
const btn = "inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-[11px] font-medium hover:bg-[var(--surface-hover,rgba(255,255,255,0.06))]";
const btnPrimary = `${btn} border-transparent bg-foreground text-background hover:opacity-85`;
const badge = "rounded-full border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground,#a8a8a8)]";
const badgeWarn = `${badge} border-amber-500/40 text-amber-400`;
const badgeErr = `${badge} border-red-500/40 text-red-400`;

export function OptimizePromptCard({ payload, ctx }: ToolCardProps): ReactNode {
    const original = str(payload.original);
    const optimized = str(payload.optimized);
    const negative = str(payload.negative);
    if (!optimized) return null;
    return (
        <div className={`${shell} toiv-tc-optimize`} data-testid="toiv-tc-optimize">
            <div className={`grid gap-2 ${original ? "sm:grid-cols-2" : ""}`}>
                {original ? (
                    <div>
                        <div className={label}>原文</div>
                        <div className="mt-1 whitespace-pre-wrap break-words">{original}</div>
                    </div>
                ) : null}
                <div>
                    <div className={label}>优化后</div>
                    <div className="mt-1 whitespace-pre-wrap break-words text-foreground">{optimized}</div>
                </div>
            </div>
            {negative ? (
                <div>
                    <div className={label}>负向提示词</div>
                    <div className="mt-1 font-mono text-[11px] text-[var(--muted-foreground,#a8a8a8)]">{negative}</div>
                </div>
            ) : null}
            {ctx.onApplyInput ? (
                <div className="flex gap-2">
                    <button type="button" className={btnPrimary} onClick={() => ctx.onApplyInput?.(optimized)}>
                        <Sparkles className="size-3" />
                        应用到输入框
                    </button>
                </div>
            ) : null}
        </div>
    );
}

export function KnowledgeCard({ payload }: ToolCardProps): ReactNode {
    const items = objArr(payload.items)
        .map((it) => ({ title: str(it.title), snippet: str(it.snippet) }))
        .filter((it) => it.title || it.snippet);
    if (!items.length) return null;
    return (
        <div className={`${shell} toiv-tc-knowledge`} data-testid="toiv-tc-knowledge">
            {items.map((it, i) => (
                <div key={i} className="rounded-lg border border-[var(--border)]/60 p-2">
                    <div className="flex items-center gap-1.5">
                        <Database className="size-3 shrink-0 text-[var(--muted-foreground,#a8a8a8)]" />
                        <span className="font-medium">{it.title || "知识条目"}</span>
                        <span className={badge}>知识库</span>
                    </div>
                    {it.snippet ? <p className="mt-1 text-[var(--muted-foreground,#a8a8a8)]">{it.snippet}</p> : null}
                </div>
            ))}
        </div>
    );
}

export function AppListCard({ payload, ctx }: ToolCardProps): ReactNode {
    const items = objArr(payload.items)
        .map((it) => ({
            id: str(it.id),
            name: str(it.name),
            description: str(it.description),
            cover: str(it.cover_url),
            useCase: str(it.use_case),
            nsfw: it.is_nsfw === true,
        }))
        .filter((it) => it.id && it.name);
    if (!items.length) return null;
    const total = num(payload.total);
    return (
        <div className={`${shell} toiv-tc-apps`} data-testid="toiv-tc-apps">
            {items.map((it) => (
                <div key={it.id} className="flex items-center gap-2 rounded-lg border border-[var(--border)]/60 p-2">
                    <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-[var(--surface-hover,rgba(255,255,255,0.04))]">
                        <LayoutGrid className="size-3.5 text-[var(--muted-foreground,#a8a8a8)]" />
                        {it.cover ? <img src={it.cover} alt="" className="size-9 object-cover" loading="lazy" onError={(e) => { e.currentTarget.style.display = "none"; }} /> : null}
                    </span>
                    <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1 font-medium">
                            {it.name}
                            {it.nsfw ? <span className={badgeWarn}>18+</span> : null}
                        </span>
                        <span className="block truncate text-[var(--muted-foreground,#a8a8a8)]">
                            {[it.useCase, it.description].filter(Boolean).join(" · ") || "—"}
                        </span>
                    </span>
                    {ctx.onOpenApp ? (
                        <button type="button" className={btn} onClick={() => ctx.onOpenApp?.(it.id)}>打开应用</button>
                    ) : null}
                </div>
            ))}
            {total !== null && total > items.length ? <div className="text-[var(--muted-foreground,#a8a8a8)]">共 {total} 个应用</div> : null}
        </div>
    );
}

export function ModelsCard({ payload }: ToolCardProps): ReactNode {
    const models = (Array.isArray(payload.models) ? payload.models : []).map((m) => str(m)).filter(Boolean);
    if (!models.length) return null;
    return (
        <div className={`${shell} toiv-tc-models`} data-testid="toiv-tc-models">
            <div className="flex flex-wrap gap-1.5">
                {models.map((m) => (
                    <span key={m} className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-2 py-0.5">
                        <Cpu className="size-3" />
                        {m}
                    </span>
                ))}
            </div>
        </div>
    );
}

export function StoryboardCard({ payload, ctx }: ToolCardProps): ReactNode {
    const boardId = str(payload.board_id);
    const name = str(payload.name);
    if (!name) return null;
    const itemCount = num(payload.item_count);
    const castCount = num(payload.cast_count);
    const stats = [itemCount !== null ? `${itemCount} 分镜行` : "", castCount !== null ? `${castCount} 角色` : ""].filter(Boolean).join(" / ");
    return (
        <div className={`${shell} toiv-tc-storyboard`} data-testid="toiv-tc-storyboard">
            <div className="flex items-center gap-1.5">
                <Clapperboard className="size-3.5" />
                <span className="font-medium">{name}</span>
                {stats ? <span className={badge}>{stats}</span> : null}
            </div>
            {boardId && ctx.onOpenBoard ? (
                <div>
                    <button type="button" className={btn} onClick={() => ctx.onOpenBoard?.(boardId)}>打开画板</button>
                </div>
            ) : null}
        </div>
    );
}

export function SelfhealCard({ payload, ctx }: ToolCardProps): ReactNode {
    const failureItems = objArr(payload.items)
        .map((it) => ({
            id: str(it.id),
            name: str(it.name),
            cls: str(it.cls),
            advice: str(it.advice),
            error: str(it.error),
        }))
        .filter((it) => it.name || it.cls || it.advice || it.error);
    if (failureItems.length) {
        return (
            <div className={`${shell} toiv-tc-selfheal`} data-testid="toiv-tc-selfheal">
                {failureItems.map((it, i) => (
                    <div key={it.id || i} className="rounded-lg border border-[var(--border)]/60 p-2">
                        <div className="flex items-center gap-1.5">
                            <span className="font-medium">{it.name || "未命名应用"}</span>
                            {it.cls ? <span className={badgeErr}>{it.cls}</span> : null}
                        </div>
                        {it.advice ? <p className="mt-1 text-[var(--muted-foreground,#a8a8a8)]">建议:{it.advice}</p> : null}
                        {it.error ? <p className="mt-1 text-red-400">{it.error}</p> : null}
                    </div>
                ))}
            </div>
        );
    }
    const appId = str(payload.app_id);
    const name = str(payload.name);
    const status = str(payload.smoke_status);
    const cls = str(payload.smoke_cls);
    const error = str(payload.smoke_error);
    const advice = str(payload.advice);
    if (!appId && !name && !status && !cls && !advice && !error) return null;
    return (
        <div className={`${shell} toiv-tc-selfheal`} data-testid="toiv-tc-selfheal">
            <div className="flex items-center gap-1.5">
                <ShieldCheck className="size-3.5" />
                <span className="font-medium">{name || appId || "应用诊断"}</span>
                {cls ? <span className={badgeErr}>{cls}</span> : null}
                {status ? <span className={badge}>{status}</span> : null}
            </div>
            {advice ? <p className="text-[var(--muted-foreground,#a8a8a8)]">建议:{advice}</p> : null}
            {error ? <p className="text-red-400">{error}</p> : null}
            {appId && ctx.onOpenApp ? (
                <button type="button" className={btn} onClick={() => ctx.onOpenApp?.(appId)}>查看应用</button>
            ) : null}
        </div>
    );
}

export function GenerationJobCard({ payload }: ToolCardProps): ReactNode {
    const jobId = str(payload.job_id);
    const kind = str(payload.kind) || "image";
    const status = str(payload.status) || "queued";
    const labelText = str(payload.label);
    const holdReason = str(payload.hold_reason);
    const error = str(payload.error);
    const results = (Array.isArray(payload.results) ? payload.results : []).map((u) => str(u)).filter(Boolean);
    if (!jobId && !labelText && !results.length) return null;
    const statusLabel =
        status === "queued" ? "排队中"
            : status === "held" ? "资源等待"
                : status === "running" ? "运行中"
                    : status === "done" ? "完成"
                        : status === "error" ? "失败"
                            : status === "canceled" ? "已中止"
                                : status || "排队中";
    const kindText =
        kind.includes("video") || kind === "video" ? "视频"
            : kind.includes("audio") || kind === "audio" ? "音频"
                : kind.includes("3d") ? "3D"
                    : "图像";
    const KindIcon = kindText === "视频" ? Video : kindText === "音频" ? Volume2 : kindText === "3D" ? Box : ImageIcon;
    return (
        <div className={`${shell} toiv-tc-job`} data-testid="toiv-tc-job" data-status={status}>
            <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1 font-medium">
                    <KindIcon className="size-3.5" />
                    {kindText}
                </span>
                <span className={status === "error" ? badgeErr : status === "done" ? badge : badgeWarn}>{statusLabel}</span>
            </div>
            {labelText ? <div>{labelText}</div> : null}
            {status === "held" && holdReason ? <div className="text-[var(--muted-foreground,#a8a8a8)]">{holdReason}</div> : null}
            {status === "error" && (error || holdReason) ? <div className="text-red-400">{error || holdReason}</div> : null}
            {status === "done" && results.length ? (
                <div className="flex gap-1.5">
                    {results.slice(0, 4).map((url) => (
                        <span key={url} className="relative flex size-12 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface-hover,rgba(255,255,255,0.04))]">
                            <ImageIcon className="absolute inset-0 m-auto size-3.5 text-[var(--muted-foreground,#a8a8a8)]" />
                            <img src={url} alt="" className="relative size-12 object-cover" loading="lazy" onError={(e) => { e.currentTarget.style.display = "none"; }} />
                        </span>
                    ))}
                </div>
            ) : null}
            {jobId ? <div className="text-[10px] text-[var(--muted-foreground,#a8a8a8)]">作业 {jobId}</div> : null}
        </div>
    );
}

/** 画布提案卡：一键入画布加强点入口。 */
export function ProposalCard({ payload, ctx }: ToolCardProps): ReactNode {
    const title = str(payload.title) || str(payload.proposal_id) || "画布提案";
    const body = str(payload.body) || str(payload.summary) || str(payload.detail);
    const estimate = str(payload.estimate);
    const kind = str(payload.kind) || "canvas_graph";
    if (!title && !body) return null;
    return (
        <div className={`${shell} toiv-tc-proposal`} data-testid="toiv-tc-proposal">
            <div className="flex items-center gap-1.5">
                <LayoutGrid className="size-3.5" />
                <span className="font-medium">{title}</span>
                {estimate ? <span className={badge}>{estimate}</span> : null}
                <span className={badge}>{kind === "canvas_graph" ? "画布图" : kind}</span>
            </div>
            {body ? <p className="whitespace-pre-wrap break-words text-[var(--muted-foreground,#a8a8a8)]">{body}</p> : null}
            {ctx.onApplyToCanvas ? (
                <button type="button" className={btnPrimary} onClick={() => void ctx.onApplyToCanvas?.(payload)}>
                    一键入画布
                </button>
            ) : null}
        </div>
    );
}
