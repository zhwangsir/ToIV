"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Icon, type IconName } from "@/components/ui/Icon";
import {
  imageUrl,
  listAgentSessions,
  listJobs,
  type AgentSessionSummary,
} from "@/lib/api";
import type { JobItem } from "@/lib/types";
import "@/app/styles/cmdk.css";

/** 命令面板页面条目:全量视图(含非左栏项),admin 项按权限注入。 */
const CMDK_PAGES: { view: string; label: string; icon: IconName; admin?: boolean }[] = [
  { view: "home", label: "对话", icon: "chat" },
  { view: "image", label: "图片", icon: "image" },
  { view: "video", label: "视频", icon: "video" },
  { view: "audio", label: "音频", icon: "audio" },
  { view: "studio", label: "创作工作室", icon: "clapperboard" },
  { view: "avatartalk", label: "数字人", icon: "user" },
  { view: "dub", label: "译制", icon: "mic" },
  { view: "imageEdit", label: "图片编辑", icon: "palette" },
  { view: "videoEdit", label: "视频剪辑", icon: "film" },
  { view: "animatic", label: "动态分镜", icon: "film" },
  { view: "canvas", label: "画布", icon: "workflow" },
  { view: "library", label: "作品库", icon: "library" },
  { view: "entities", label: "主体库", icon: "users" },
  { view: "market", label: "市场", icon: "store" },
  { view: "resources", label: "资源中心", icon: "models" },
  { view: "settings", label: "设置", icon: "settings" },
  { view: "observability", label: "观测", icon: "monitor", admin: true },
  { view: "admin", label: "管理", icon: "shield-check", admin: true },
];

interface PaletteEntry {
  id: string;
  kind: "action" | "page" | "session" | "job";
  label: string;
  icon: IconName;
  /** 右侧小字提示(组名/时间) */
  hint?: string;
  /** 会话/作品的负载 id */
  refId?: string;
  /** 作品缩略图(仅 job) */
  thumb?: string;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onNavigate: (view: string) => void;
  isAdmin: boolean;
}

/** 跨组件指令:助手监听执行(AssistantView 挂在 home 视图时消费)。 */
export const EV_NEW_CHAT = "toiv:new-chat";
export const EV_OPEN_SESSION = "toiv:open-session";
/** 跨视图打开会话时的暂存键(目标组件尚未挂载时先写,挂载后消费) */
export const PENDING_SESSION_KEY = "__toivPendingSessionId";

/**
 * Studio Console v1(2026-08-31)⌘K 命令面板:
 * 全功能/会话/作品的统一检索入口——动作(新对话)、页面跳转、最近会话、最近作品。
 * 键盘:↑↓ 移动、Enter 执行、Esc 关闭;点击遮罩关闭。
 */
export function CommandPalette({ open, onClose, onNavigate, isAdmin }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [jobs, setJobs] = useState<JobItem[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // open 翻转时:聚焦 + 清空上次输入 + 拉取会话/作品(失败静默,不影响页面/动作条目)
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setQuery("");
      setActive(0);
      const t = window.setTimeout(() => inputRef.current?.focus(), 30);
      listAgentSessions().then(setSessions).catch(() => {});
      listJobs().then((rows) => setJobs(rows)).catch(() => {});
      wasOpen.current = true;
      return () => window.clearTimeout(t);
    }
    if (!open) wasOpen.current = false;
  }, [open]);

  const entries = useMemo<PaletteEntry[]>(() => {
    const q = query.trim().toLowerCase();
    const match = (s: string) => !q || s.toLowerCase().includes(q);
    const out: PaletteEntry[] = [];
    // 动作
    if (match("新对话") || match("new chat")) {
      out.push({ id: "act:new", kind: "action", label: "新对话", icon: "create", hint: "动作" });
    }
    // 页面
    for (const p of CMDK_PAGES) {
      if (p.admin && !isAdmin) continue;
      if (!match(p.label)) continue;
      out.push({ id: `page:${p.view}`, kind: "page", label: p.label, icon: p.icon, hint: "页面", refId: p.view });
    }
    // 会话(最近 5)
    for (const s of sessions.slice(0, 5)) {
      if (!match(s.title || "")) continue;
      out.push({
        id: `session:${s.id}`, kind: "session", label: s.title || "新对话",
        icon: "history", hint: `${s.message_count} 条消息`, refId: s.id,
      });
    }
    // 作品(最近 4 个完成且有产物的)
    for (const j of jobs) {
      if (out.filter((e) => e.kind === "job").length >= 4) break;
      if (j.status !== "done" || !j.results?.length) continue;
      const label = (j.prompt || "未命名作品").slice(0, 40);
      if (!match(label)) continue;
      out.push({
        id: `job:${j.id}`, kind: "job", label,
        icon: "image", hint: "作品库", refId: j.id,
        thumb: imageUrl(j.results[0]),
      });
    }
    return out;
  }, [query, sessions, jobs, isAdmin]);

  // 输入变化时重置高亮;高亮越界收敛
  useEffect(() => {
    setActive(0);
  }, [query]);
  useEffect(() => {
    if (active >= entries.length) setActive(Math.max(0, entries.length - 1));
  }, [entries.length, active]);

  // 高亮项滚入可视区
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const run = useCallback(
    (e: PaletteEntry) => {
      onClose();
      if (e.kind === "page" && e.refId) {
        onNavigate(e.refId);
      } else if (e.kind === "action" && e.id === "act:new") {
        onNavigate("home");
        window.dispatchEvent(new CustomEvent(EV_NEW_CHAT));
      } else if (e.kind === "session" && e.refId) {
        onNavigate("home");
        (window as unknown as Record<string, unknown>)[PENDING_SESSION_KEY] = e.refId;
        window.dispatchEvent(new CustomEvent(EV_OPEN_SESSION, { detail: e.refId }));
      } else if (e.kind === "job") {
        onNavigate("library");
      }
    },
    [onClose, onNavigate],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((v) => (entries.length ? (v + 1) % entries.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((v) => (entries.length ? (v - 1 + entries.length) % entries.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const entry = entries[active];
      if (entry) run(entry);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  if (!open) return null;

  return (
    <div className="cmdk-overlay" onClick={onClose}>
      <div
        className="cmdk-panel"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cmdk-input-row">
          <Icon name="search" size={15} strokeWidth={1.8} />
          <input
            ref={inputRef}
            className="cmdk-input"
            placeholder="搜索页面、会话、作品,或输入命令…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label="命令面板搜索"
          />
          <kbd className="cmdk-kbd">Esc</kbd>
        </div>
        <div className="cmdk-list" ref={listRef} role="listbox">
          {entries.length === 0 ? (
            <div className="cmdk-empty">无匹配结果</div>
          ) : (
            entries.map((e, i) => (
              <button
                key={e.id}
                type="button"
                data-idx={i}
                role="option"
                aria-selected={i === active}
                className={`cmdk-item${i === active ? " is-active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => run(e)}
              >
                {e.thumb ? (
                  <img src={e.thumb} alt="" className="cmdk-thumb" loading="lazy" />
                ) : (
                  <span className="cmdk-item-icon">
                    <Icon name={e.icon} size={14} strokeWidth={1.8} />
                  </span>
                )}
                <span className="cmdk-item-label">{e.label}</span>
                {e.hint ? <span className="cmdk-item-hint">{e.hint}</span> : null}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
