import {
    Bot,
    Clapperboard,
    Command,
    Film,
    Home,
    Image,
    Library,
    ListChecks,
    MessageSquarePlus,
    Mic,
    Music,
    PanelsTopLeft,
    Plug,
    Plus,
    Search,
    Settings,
    Settings2,
    Store,
    WandSparkles,
    X,
    type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { Kbd } from "@/components/ui/base/kbd";
import { cn } from "@/lib/utils";
import { EV_AGENT_NEW_SESSION } from "@/services/toiv/agent-draft";

export type WorkspaceCommandEntry = {
    id: string;
    title: string;
    icon: LucideIcon;
    /** 右侧小字分组提示(动作/页面/工具/设置),对齐经典 web ⌘K 的信息密度。 */
    hint: string;
    to?: string;
    run?: () => void;
};

/**
 * F9(2026-10-15 UI 统一波):⌘K 命令面全量路由表。
 * 与 workspace-sidebar-nav 的导航树同源对齐(标题一致),并补齐侧栏未平铺的
 * 工具页(音频/图片/视频/译制)与设置段直达;经典 web CommandPalette 的
 * 「页面 + 动作 + 设置段」结构移植至此,R18 逻辑不迁(canvas 纯 SFW)。
 */
export const WORKSPACE_COMMAND_ROUTES: ReadonlyArray<Omit<WorkspaceCommandEntry, "run">> = [
    // 动作
    { id: "act:new-project", title: "新建项目", icon: Plus, hint: "动作", to: "/canvas?mode=new" },
    { id: "act:new-chat", title: "新对话", icon: MessageSquarePlus, hint: "动作", to: "/toiv/agent" },
    // 页面(与侧栏导航树同序)
    { id: "home", title: "首页", icon: Home, hint: "页面", to: "/" },
    { id: "create", title: "创作", icon: WandSparkles, hint: "页面", to: "/create" },
    { id: "toiv:drama", title: "短剧工作台", icon: Clapperboard, hint: "页面", to: "/toiv/drama" },
    { id: "toiv:agent", title: "智能体对话", icon: Bot, hint: "页面", to: "/toiv/agent" },
    { id: "projects", title: "项目", icon: PanelsTopLeft, hint: "页面", to: "/project" },
    { id: "canvas", title: "画布", icon: PanelsTopLeft, hint: "页面", to: "/canvas" },
    { id: "library", title: "媒体库", icon: Library, hint: "页面", to: "/library?source=materials" },
    { id: "toiv:market", title: "工具箱", icon: Store, hint: "页面", to: "/toiv/market" },
    { id: "toiv:tasks", title: "任务中心", icon: ListChecks, hint: "页面", to: "/toiv/tasks" },
    // 工具页(F3–F7 自经典 web 收编,侧栏未平铺)
    { id: "toiv:audio", title: "音频工具", icon: Music, hint: "工具", to: "/toiv/audio" },
    { id: "toiv:image-tools", title: "图片工具", icon: Image, hint: "工具", to: "/toiv/image-tools" },
    { id: "toiv:video-tools", title: "视频工具", icon: Film, hint: "工具", to: "/toiv/video-tools" },
    { id: "toiv:dub-tools", title: "译制工具", icon: Mic, hint: "工具", to: "/toiv/dub-tools" },
    // 高级 / 云端可选
    { id: "agents", title: "外部 Agent", icon: Plug, hint: "页面", to: "/agents" },
    // 设置段
    { id: "settings", title: "设置", icon: Settings, hint: "设置", to: "/settings" },
    { id: "settings:channels", title: "模型配置", icon: Settings2, hint: "设置", to: "/settings?section=channels" },
];

/** 纯过滤(可单测):大小写不敏感子串匹配标题,空查询返回全量。 */
export function filterCommandEntries<T extends { title: string }>(entries: readonly T[], query: string): T[] {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return [...entries];
    return entries.filter((entry) => entry.title.toLowerCase().includes(keyword));
}

/** 顶栏搜索 / ⌘K 命令面板:覆盖 canvas 全量路由 + 动作 + 设置段(F9 起为全站唯一命令面)。 */
export function WorkspaceCommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
    const navigate = useNavigate();
    const [query, setQuery] = useState("");
    const [highlight, setHighlight] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);

    const entries = useMemo<WorkspaceCommandEntry[]>(() => {
        return WORKSPACE_COMMAND_ROUTES.map((entry) => {
            if (entry.id === "act:new-chat") {
                return {
                    ...entry,
                    run: () => {
                        // 已在对话页时由页面监听重置;未挂载时挂载初态即新会话。
                        window.dispatchEvent(new CustomEvent(EV_AGENT_NEW_SESSION));
                        navigate(entry.to ?? "/toiv/agent");
                    },
                };
            }
            return { ...entry };
        });
    }, [navigate]);

    const filtered = useMemo(() => filterCommandEntries(entries, query), [entries, query]);

    const activateEntry = useCallback(
        (entry: WorkspaceCommandEntry) => {
            onClose();
            if (entry.run) {
                entry.run();
                return;
            }
            if (entry.to) navigate(entry.to);
        },
        [navigate, onClose],
    );

    useEffect(() => {
        if (open) {
            setQuery("");
            window.setTimeout(() => inputRef.current?.focus(), 20);
        }
    }, [open]);

    useEffect(() => {
        setHighlight(0);
    }, [filtered.length, open, query]);

    useEffect(() => {
        if (!open) return;
        const handler = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                onClose();
                return;
            }
            if (event.key === "ArrowDown") {
                event.preventDefault();
                setHighlight((index) => Math.min(index + 1, Math.max(filtered.length - 1, 0)));
                return;
            }
            if (event.key === "ArrowUp") {
                event.preventDefault();
                setHighlight((index) => Math.max(index - 1, 0));
                return;
            }
            if (event.key === "Enter" && filtered[highlight]) {
                event.preventDefault();
                activateEntry(filtered[highlight]);
            }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [activateEntry, filtered, highlight, onClose, open]);

    if (!open) return null;

    return (
        <div className="absolute inset-0 z-50 flex items-start justify-center bg-background/40 px-4 pt-28 backdrop-blur-sm lg:pt-32" role="dialog" aria-modal="true" aria-label="命令面板">
            <div className="absolute inset-0" onClick={onClose} />
            <div className="relative w-full max-w-xl overflow-hidden rounded-xl border border-[var(--workspace-border)] bg-[var(--workspace-surface-strong)] shadow-2xl animate-in fade-in zoom-in-95 duration-200">
                <div className="p-3 pb-2">
                    <div className="flex h-10 items-center gap-2 rounded-[var(--r-md)] border border-[var(--workspace-border)] bg-foreground/5 px-3 transition-colors hover:border-[var(--workspace-border-strong)] focus-within:border-[var(--workspace-border-strong)] focus-within:bg-foreground/[.06]">
                        <Search className="size-4 shrink-0 text-foreground/45" strokeWidth={1.6} />
                        <input
                            ref={inputRef}
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            className="min-w-0 flex-1 bg-transparent text-[var(--fs-body)] outline-none placeholder:text-foreground/45"
                            placeholder="搜索页面、工具或命令…"
                            aria-label="命令面板搜索"
                        />
                        <Kbd onClick={onClose} className="hidden shrink-0 cursor-pointer transition-colors hover:bg-surface-hover hover:text-foreground sm:inline-flex">
                            ⌘K
                        </Kbd>
                        <button
                            type="button"
                            onClick={onClose}
                            className="ml-0.5 shrink-0 rounded-md p-1 text-foreground/50 transition-colors hover:bg-surface-hover hover:text-foreground"
                            aria-label="关闭搜索"
                        >
                            <X className="size-4" strokeWidth={1.6} />
                        </button>
                    </div>
                </div>

                <div className="max-h-80 overflow-y-auto p-2">
                    {filtered.length ? (
                        <ul className="flex flex-col gap-0.5" role="listbox" aria-label="命令列表">
                            {filtered.map((entry, index) => {
                                const Icon = entry.icon;
                                return (
                                    <li key={entry.id}>
                                        <button
                                            type="button"
                                            role="option"
                                            aria-selected={index === highlight}
                                            onMouseEnter={() => setHighlight(index)}
                                            onClick={() => activateEntry(entry)}
                                            className={cn(
                                                "flex w-full items-center gap-2.5 rounded-[var(--r-sm)] px-3 py-2.5 text-left text-[var(--fs-body)] transition-colors",
                                                index === highlight ? "bg-surface-hover text-foreground" : "text-foreground/65",
                                            )}
                                        >
                                            <Icon className={cn("size-4 shrink-0", index === highlight ? "text-foreground" : "text-foreground/55")} strokeWidth={1.6} />
                                            <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                                            <span className="shrink-0 text-[var(--fs-caption)] text-foreground/40">{entry.hint}</span>
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    ) : (
                        <div className="flex flex-col items-center justify-center py-8">
                            <Command className="mb-2 size-6 text-foreground/30" strokeWidth={1.5} />
                            <p className="text-[var(--fs-caption)] font-medium text-foreground/55">未找到「{query}」相关页面</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
