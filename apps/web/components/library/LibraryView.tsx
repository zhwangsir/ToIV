"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { deleteJob, imageUrl, invalidateJobs, listJobs } from "@/lib/api";
import { ENGINE_DRAFT_KEY } from "@/lib/engine";
import { useR18Mode } from "@/lib/r18";
import {
  applyLibraryQuery,
  countByFilter,
  deleteJobsBatch,
  FILTERS,
  formatTime,
  isVideoKind,
  kindLabel,
  kindToFilter,
  loadDensity,
  persistDensity,
  statusLabel,
  type ContentFilterKey,
  type FilterKey,
  type LibraryDensity,
  type SortKey,
} from "@/lib/libraryQuery";
import type { JobItem } from "@/lib/types";
import { Icon } from "@/components/ui/Icon";
import { LazyVideo } from "@/components/ui/LazyVideo";
import { Button } from "@/components/ui/Button";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { Modal } from "@/components/ui/Modal";
import { Popover } from "@/components/ui/Popover";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { StyleBar, type StyleCard } from "@/components/library/StyleBar";
import "@/app/styles/library.css";

/** localStorage 键:风格卡列表(WS4「存为风格」)。 */
const STYLE_CARDS_KEY = "toiv_style_cards";
/** localStorage 键:优化提示词管线读取的风格描述(与 ui/OptimizeButton 一致)。 */
const STYLE_HINT_KEY = "toiv_optimize_style_hint";

function loadStyleCards(): StyleCard[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STYLE_CARDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is StyleCard =>
        !!c && typeof c.id === "string" && typeof c.name === "string",
    );
  } catch {
    return [];
  }
}

function persistStyleCards(cards: StyleCard[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STYLE_CARDS_KEY, JSON.stringify(cards));
  } catch {
    /* localStorage 不可用时静默忽略 */
  }
}

/** 分页大小:每页 60 条,点击「加载更多」追加,避免全量渲染大图列表。 */
const PAGE_SIZE = 60;

function ThumbPlaceholder({ job }: { job: JobItem }) {
  const filterKey = kindToFilter(job.kind);
  return (
    <div
      className={`lib-thumb-placeholder ${job.status === "error" ? "has-error" : ""}`}
    >
      {/* 图标居中,状态文本分层为左上角状态 chip,互不重叠 */}
      <Icon
        name={
          job.status === "running"
            ? "loading"
            : job.status === "error"
              ? "error"
              : filterKey === "audio"
                ? "audio"
                : filterKey === "video"
                  ? "film"
                  : filterKey === "3d"
                    ? "box"
                    : "image"
        }
        size={24}
        strokeWidth={1.4}
      />
      {job.status === "running" && (
        <span className="lib-thumb-status is-running">
          <span className="lib-thumb-status-dot" aria-hidden="true" />
          生成中
        </span>
      )}
      {job.status === "error" && (
        <span className="lib-thumb-status is-error">
          <span className="lib-thumb-status-dot" aria-hidden="true" />
          失败
        </span>
      )}
    </div>
  );
}

function ImageThumb({ job, blurred = false }: { job: JobItem; blurred?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <ThumbPlaceholder job={job} />;
  return (
    <img
      src={imageUrl(job.results[0])}
      alt={job.prompt}
      /* 属性仅作加载前纵横比提示(16:9,与缩略图视口一致),
         CSS object-fit:cover 裁切填满,抑制 CLS */
      width={480}
      height={270}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      /* R18 模糊卡(M9):缩略图默认模糊,点击可解除/恢复(点击事件冒泡到外层按钮) */
      style={
        blurred
          ? { filter: "blur(18px)", pointerEvents: "auto", cursor: "pointer" }
          : undefined
      }
    />
  );
}

/** 作品库空态(库本身为空):细线框图标 + 引导文案 + 去创作 CTA。 */
export function LibraryEmptyState({ onCreate }: { onCreate?: () => void }) {
  return (
    <div className="lib-empty">
      <div className="lib-empty-icon" aria-hidden="true">
        <Icon name="image" size={26} strokeWidth={1.2} />
      </div>
      <h2 className="lib-empty-display">暂无作品</h2>
      <p className="lib-empty-desc">
        每一次生成都会自动收录到这里。先去工作台创作第一件作品,随时回来复用提示词、沉淀风格。
      </p>
      {onCreate && (
        <Button
          variant="primary"
          size="sm"
          icon={<Icon name="create" size={14} />}
          onClick={onCreate}
        >
          去创作
        </Button>
      )}
    </div>
  );
}

interface LibraryViewProps {
  /**
   * 视图跳转(复用 page.tsx 的 fusion 导航:写引擎草稿后跳生成工作台)。
   * 未提供时灯箱「复用提示词」退化为整页跳转。
   */
  onNavigate?: (target: string) => void;
}

export function LibraryView(props?: LibraryViewProps) {
  const onNavigate = props?.onNavigate;
  const toast = useToast();
  const [jobs, setJobs] = useState<JobItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>("all");
  // 内容维度过滤(M9):全部/SFW/R18,客户端按 job.nsfw 过滤
  const [contentFilter, setContentFilter] = useState<ContentFilterKey>("all");
  // R18 全局内容模式:仅 on 时渲染 R18 chip(SFW 模式后端本就不返回 R18 作品)
  const [r18Mode] = useR18Mode();
  // R18 缩略图模糊:已点击揭示(解除模糊)的作品 id 集合,单张点击解除/恢复
  const [revealedIds, setRevealedIds] = useState<ReadonlySet<string>>(new Set());
  // 「点击显示」提示层:hover 模糊卡时显示(记录当前悬停的 job id)
  const [hoveredBlurId, setHoveredBlurId] = useState<string | null>(null);
  // 分页:首屏只渲染 PAGE_SIZE 条,「加载更多」追加;查询条件变更时重置
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  // 工具条(2026-08-15 重设计):prompt 搜索 / 时间排序 / 网格密度(持久化)
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");
  const [density, setDensity] = useState<LibraryDensity>(() => loadDensity());
  // 批量管理:进入后点击卡片改为勾选;底部浮动操作条承载批量删除
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // 删除确认对话框(替代 window.confirm / window.alert)
  const [confirmDelete, setConfirmDelete] = useState<JobItem | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // 删除风格卡确认对话框(P0-2,与删除作品同一 Modal 基座)
  const [confirmDeleteStyle, setConfirmDeleteStyle] = useState<StyleCard | null>(null);
  // 沉浸查看器:当前查询结果列表内的索引;失败/音频作品也允许打开(显示对应占位)
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  // 风格卡(WS4):StyleBar 数据源 + 「存为风格」Popover 状态
  const [styleCards, setStyleCards] = useState<StyleCard[]>([]);
  const [styleTarget, setStyleTarget] = useState<JobItem | null>(null);
  const [styleName, setStyleName] = useState("");
  const styleAnchorRef = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    listJobs()
      .then(setJobs)
      .catch((err) => setError(err instanceof Error ? err.message : "加载作品失败"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 挂载后读取本地风格卡(SSR 安全:loadStyleCards 内部判 window)
  useEffect(() => {
    setStyleCards(loadStyleCards());
  }, []);

  // 查询管线(纯函数,见 lib/libraryQuery):内容分级 → 类型 → 搜索 → 排序
  const filtered = useMemo(
    () =>
      applyLibraryQuery(jobs ?? [], {
        filter,
        contentFilter,
        search,
        sort,
      }),
    [jobs, filter, contentFilter, search, sort],
  );

  // 类型计数(chip 徽标):基于内容分级后的集合,与列表口径一致
  const counts = useMemo(
    () => countByFilter(jobs ?? [], contentFilter),
    [jobs, contentFilter],
  );

  // 灯箱索引越界钳制:删除当前作品后 filtered 收缩,滑到下一件;列表清空则关闭
  useEffect(() => {
    if (lightboxIdx === null) return;
    if (filtered.length === 0) setLightboxIdx(null);
    else if (lightboxIdx >= filtered.length) setLightboxIdx(filtered.length - 1);
  }, [filtered.length, lightboxIdx]);

  // 列表收缩(删除/刷新)后 prune 选中集,避免选中已不存在的作品
  useEffect(() => {
    if (!jobs || selectedIds.size === 0) return;
    const alive = new Set(jobs.map((j) => j.id));
    setSelectedIds((prev) => {
      const next = new Set([...prev].filter((id) => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [jobs, selectedIds.size]);

  const visibleJobs = useMemo(
    () => filtered.slice(0, visibleCount),
    [filtered, visibleCount],
  );
  const hasMore = filtered.length > visibleCount;

  // 查询条件变更统一重置分页(首屏 60 条)
  const resetPage = useCallback(() => setVisibleCount(PAGE_SIZE), []);

  // R18 模式关闭时若正选中 R18 chip,回退「全部」(chip 已不渲染,避免选中态悬空)
  useEffect(() => {
    if (!r18Mode && contentFilter === "r18") setContentFilter("all");
  }, [r18Mode, contentFilter]);

  // R18 缩略图:点击单张解除/恢复模糊(本地 state 存已揭示的 job id 集合)
  const toggleReveal = (jobId: string) => {
    setRevealedIds((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  };

  // 密度切换:state + localStorage 记忆
  const changeDensity = (next: LibraryDensity) => {
    setDensity(next);
    persistDensity(next);
  };

  // ── 批量管理 ──

  const toggleSelect = (jobId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  };

  const exitBatchMode = () => {
    setBatchMode(false);
    setSelectedIds(new Set());
    setConfirmBatchDelete(false);
    setDeleteError(null);
  };

  // 确认批量删除:顺序执行,成功项移出列表;有失败则保留失败项选中并内联报错
  const handleConfirmBatchDelete = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setBatchDeleting(true);
    setDeleteError(null);
    const { done, failed } = await deleteJobsBatch(ids, deleteJob);
    setBatchDeleting(false);
    if (done.length > 0) {
      invalidateJobs();
      const doneSet = new Set(done);
      setJobs((prev) => (prev ?? []).filter((j) => !doneSet.has(j.id)));
    }
    if (failed.length === 0) {
      toast.success(`已删除 ${done.length} 件作品`);
      exitBatchMode();
    } else {
      setSelectedIds(new Set(failed));
      setDeleteError(`${failed.length} 件删除失败,已保留选中,可重试`);
    }
  };

  // 点击删除:仅打开确认对话框(不再使用 window.confirm)
  const handleDelete = (job: JobItem) => {
    setDeleteError(null);
    setConfirmDelete(job);
  };

  // 确认删除:执行实际删除,失败时把错误信息内联显示在对话框中
  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    const job = confirmDelete;
    setDeletingId(job.id);
    try {
      await deleteJob(job.id);
      invalidateJobs();
      setJobs((prev) => (prev ?? []).filter((j) => j.id !== job.id));
      setConfirmDelete(null);
      setDeleteError(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "删除失败");
    } finally {
      setDeletingId(null);
    }
  };

  // 打开沉浸查看器:定位到当前查询结果列表中的索引(失败/音频作品同样可打开)
  const openLightbox = (job: JobItem) => {
    const idx = filtered.findIndex((j) => j.id === job.id);
    if (idx >= 0) setLightboxIdx(idx);
  };

  // ── WS4 快捷操作 + 风格卡 ──

  // 复用提示词:写入剪贴板并 toast(项目已有 Toast 机制,不用 alert)
  const reusePrompt = async (job: JobItem) => {
    const text = job.prompt?.trim();
    if (!text) {
      toast.info("该作品没有提示词");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.success("提示词已复制到剪贴板");
    } catch {
      toast.error("复制失败,请检查浏览器剪贴板权限");
    }
  };

  // 灯箱「复用提示词」:写引擎草稿(toiv_engine_draft,GenerateView 挂载时消费)并跳生成工作台
  const reusePromptAsDraft = (job: JobItem) => {
    const text = job.prompt?.trim();
    if (!text) {
      toast.info("该作品没有提示词");
      return;
    }
    const target = isVideoKind(job.kind) ? "video" : "image";
    try {
      window.localStorage.setItem(
        ENGINE_DRAFT_KEY,
        JSON.stringify({ prompt: text, target }),
      );
    } catch {
      /* localStorage 不可用时仍跳转,草稿缺失不阻塞 */
    }
    setLightboxIdx(null);
    if (onNavigate) onNavigate(target);
    else window.location.assign(`/?view=${target}`);
  };

  // 空态「去创作」:跳图像工作台
  const goCreate = () => {
    if (onNavigate) onNavigate("image");
    else window.location.assign("/?view=image");
  };

  // 打开「存为风格」Popover:记录锚点按钮与目标作品
  const openStylePopover = (job: JobItem, anchor: HTMLButtonElement) => {
    styleAnchorRef.current = anchor;
    setStyleName("");
    setStyleTarget(job);
  };

  // 保存风格卡:同名覆盖,新卡置顶;prompt 截取 500 字作 hint
  const saveStyleCard = () => {
    if (!styleTarget) return;
    const name = styleName.trim();
    if (!name) {
      toast.error("请输入风格名称");
      return;
    }
    const card: StyleCard = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      thumb: styleTarget.results?.length
        ? imageUrl(styleTarget.results[0])
        : "",
      hint: (styleTarget.prompt ?? "").slice(0, 500),
    };
    setStyleCards((prev) => {
      const next = [card, ...prev.filter((c) => c.name !== name)];
      persistStyleCards(next);
      return next;
    });
    toast.success(`风格「${name}」已保存`);
    setStyleTarget(null);
  };

  // 注入风格:写入优化提示词管线读取的 localStorage 键
  const applyStyleCard = (card: StyleCard) => {
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(STYLE_HINT_KEY, card.hint);
      } catch {
        /* localStorage 不可用时静默忽略 */
      }
    }
    toast.success("风格已注入,到工作台点优化生效");
  };

  // 点击删除风格卡:仅打开确认对话框(P0-2,与删除作品同一交互范式)
  const requestDeleteStyleCard = (card: StyleCard) => {
    setConfirmDeleteStyle(card);
  };

  // 确认删除风格卡:从 localStorage 移除后 toast(原直接删除逻辑下沉到此)
  const confirmDeleteStyleCard = () => {
    if (!confirmDeleteStyle) return;
    const card = confirmDeleteStyle;
    setStyleCards((prev) => {
      const next = prev.filter((c) => c.id !== card.id);
      persistStyleCards(next);
      return next;
    });
    setConfirmDeleteStyle(null);
    toast.info(`风格「${card.name}」已删除`);
  };

  const libraryEmpty =
    !loading && !error && (jobs?.length ?? 0) === 0;
  // 查询无结果(库非空):搜索/筛选收敛掉的,给「清空条件」出口
  const resultEmpty =
    !loading && !error && !libraryEmpty && filtered.length === 0;
  const skeletonCount = 8;

  const clearQuery = () => {
    setSearch("");
    setFilter("all");
    setContentFilter("all");
    resetPage();
  };

  return (
    <div
      className={`single-view library-view${density === "compact" ? " is-compact" : ""}${batchMode ? " is-batch" : ""}`}
    >
      <header className="page-header lib-header">
        <div className="page-header-text">
          <h1 className="page-header-title">作品库</h1>
          <p className="page-header-desc">
            全部生成产物统一收录,支持检索、复用提示词与批量管理
          </p>
        </div>
        <div className="page-header-actions">
          <span className="lib-count-pill">
            {loading
              ? "加载中…"
              : error
                ? "加载失败"
                : `${filtered.length} 件作品`}
          </span>
        </div>
      </header>

      {/* 工具条(sticky):搜索 / 类型 chips / 内容分级 / 排序 / 密度 / 批量管理 */}
      <div className="lib-toolbar">
        <div className="lib-search">
          <span className="lib-search-icon" aria-hidden="true">
            <Icon name="search" size={14} />
          </span>
          <input
            className="lib-search-input"
            value={search}
            placeholder="搜索提示词…"
            aria-label="搜索提示词"
            onChange={(e) => {
              setSearch(e.target.value);
              resetPage();
            }}
          />
          {search && (
            <button
              type="button"
              className="lib-search-clear"
              aria-label="清空搜索"
              title="清空搜索"
              onClick={() => {
                setSearch("");
                resetPage();
              }}
            >
              <Icon name="close" size={12} />
            </button>
          )}
        </div>

        <div className="lib-chips" role="group" aria-label="作品类型筛选">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={`lib-chip${filter === f.key ? " is-active" : ""}`}
              aria-pressed={filter === f.key}
              onClick={() => {
                setFilter(f.key);
                resetPage();
              }}
            >
              <span>{f.label}</span>
              <span className="lib-chip-count">{counts[f.key]}</span>
            </button>
          ))}
        </div>

        <div className="lib-chips" role="group" aria-label="内容分级筛选">
          {(
            [
              { key: "all", label: "全部" },
              { key: "sfw", label: "SFW" },
              ...(r18Mode ? [{ key: "r18", label: "R18" }] : []),
            ] as { key: ContentFilterKey; label: string }[]
          ).map((c) => (
            <button
              key={c.key}
              type="button"
              className={`lib-chip lib-chip--sm${contentFilter === c.key ? " is-active" : ""}${c.key === "r18" ? " lib-chip--danger" : ""}`}
              aria-pressed={contentFilter === c.key}
              onClick={() => {
                setContentFilter(c.key);
                resetPage();
              }}
            >
              {c.label}
            </button>
          ))}
        </div>

        <div className="lib-toolbar-cluster">
          <div className="lib-seg" role="group" aria-label="排序方式">
            <button
              type="button"
              className={`lib-seg-btn${sort === "newest" ? " is-active" : ""}`}
              aria-pressed={sort === "newest"}
              onClick={() => {
                setSort("newest");
                resetPage();
              }}
            >
              最新
            </button>
            <button
              type="button"
              className={`lib-seg-btn${sort === "oldest" ? " is-active" : ""}`}
              aria-pressed={sort === "oldest"}
              onClick={() => {
                setSort("oldest");
                resetPage();
              }}
            >
              最早
            </button>
          </div>

          <div className="lib-seg lib-density" role="group" aria-label="密度切换">
            <button
              type="button"
              className={`lib-seg-btn${density === "comfortable" ? " is-active" : ""}`}
              aria-pressed={density === "comfortable"}
              aria-label="舒适密度"
              title="舒适"
              onClick={() => changeDensity("comfortable")}
            >
              <Icon name="layout-grid" size={14} />
            </button>
            <button
              type="button"
              className={`lib-seg-btn${density === "compact" ? " is-active" : ""}`}
              aria-pressed={density === "compact"}
              aria-label="紧凑密度"
              title="紧凑"
              onClick={() => changeDensity("compact")}
            >
              <Icon name="grid" size={14} />
            </button>
          </div>

          <Button
            size="sm"
            variant={batchMode ? "primary" : "secondary"}
            className="lib-batch-toggle"
            icon={<Icon name={batchMode ? "check" : "list-ordered"} size={14} />}
            onClick={() => (batchMode ? exitBatchMode() : setBatchMode(true))}
          >
            {batchMode ? "完成" : "批量管理"}
          </Button>
        </div>
      </div>

      {/* 风格库横条(WS4):空态 StyleBar 内部返回 null,不渲染整条 */}
      <StyleBar
        cards={styleCards}
        onApply={applyStyleCard}
        onDelete={requestDeleteStyleCard}
      />

      <div className="lib-body">
        {error && !loading && (
          /* P1-2:错误块收敛为统一 ErrorBar 基座(可关闭),重试交互保留 */
          <div className="lib-error">
            <ErrorBar message={error} onClose={() => setError(null)} />
            <Button size="sm" onClick={load} icon={<Icon name="refresh" size={14} />}>
              重试
            </Button>
          </div>
        )}

        {!error && loading && (
          <div className="lib-grid">
            {Array.from({ length: skeletonCount }).map((_, i) => (
              <div key={i} className="lib-card lib-skeleton" aria-hidden="true">
                <div className="lib-thumb-skel" />
                <div className="lib-foot-skel">
                  <div className="skel-line skel-w-1" />
                  <div className="skel-line skel-w-2" />
                </div>
              </div>
            ))}
          </div>
        )}

        {!error && !loading && libraryEmpty && (
          <LibraryEmptyState onCreate={goCreate} />
        )}

        {!error && !loading && resultEmpty && (
          <div className="lib-empty lib-empty--result">
            <div className="lib-empty-icon" aria-hidden="true">
              <Icon name="search" size={26} strokeWidth={1.2} />
            </div>
            <h2 className="lib-empty-display">没有匹配的作品</h2>
            <p className="lib-empty-desc">
              当前筛选 / 搜索条件下没有结果,试试调整关键词或清空全部条件。
            </p>
            <Button
              size="sm"
              icon={<Icon name="close" size={14} />}
              onClick={clearQuery}
            >
              清空筛选与搜索
            </Button>
          </div>
        )}

        {!error && !loading && !libraryEmpty && !resultEmpty && (
          <>
            <div className="lib-grid">
              {visibleJobs.map((job) => {
              // 后端作业状态枚举为 queued/running/done/error;done 表示成功且有产物
              const hasResult = job.status === "done" && job.results?.length > 0;
              const isVideo = isVideoKind(job.kind);
              // R18 作品(M9):18+ 徽标 + 缩略图默认模糊,点击单张解除/恢复
              const isNsfw = !!job.nsfw;
              const isBlurred = isNsfw && !revealedIds.has(job.id);
              const isSelected = selectedIds.has(job.id);
              return (
                <article
                  key={job.id}
                  className={`lib-card${deletingId === job.id ? " is-deleting" : ""}${isSelected ? " is-selected" : ""}`}
                >
                  <div className={`lib-thumb${job.status === "running" && !hasResult ? " is-running" : ""}`}>
                    {/* 预览/勾选触发区用真实 <button>,避免嵌套交互控件(WCAG nested-interactive) */}
                    <button
                      type="button"
                      className="lib-thumb-hit"
                      aria-label={
                        batchMode
                          ? isSelected
                            ? `取消选择作品: ${job.prompt || "无提示词"}`
                            : `选择作品: ${job.prompt || "无提示词"}`
                          : isBlurred
                            ? "点击显示 R18 作品内容"
                            : isNsfw
                              ? "恢复模糊(R18 作品)"
                              : `预览作品: ${job.prompt || "无提示词"}`
                      }
                      aria-pressed={batchMode ? isSelected : undefined}
                      onClick={() => {
                        if (batchMode) toggleSelect(job.id);
                        else if (isNsfw) toggleReveal(job.id);
                        else openLightbox(job);
                      }}
                      onMouseEnter={() => {
                        if (isBlurred && !batchMode) setHoveredBlurId(job.id);
                      }}
                      onMouseLeave={() => {
                        setHoveredBlurId((id) => (id === job.id ? null : id));
                      }}
                    >
                    {hasResult ? (
                      isVideo ? (
                        // P1-14:LazyVideo 初始 preload="none",进视口/悬停才拉首帧,
                        // 避免作品库首屏几十张视频卡同时发 Range 请求
                        <LazyVideo
                          src={imageUrl(job.results[0])}
                          muted
                          loop
                          playsInline
                          style={
                            isBlurred
                              ? {
                                  filter: "blur(18px)",
                                  pointerEvents: "auto",
                                  cursor: "pointer",
                                }
                              : undefined
                          }
                        />
                      ) : (
                        <ImageThumb job={job} blurred={isBlurred} />
                      )
                    ) : (
                      <ThumbPlaceholder job={job} />
                    )}

                    {/* R18 模糊卡 hover 提示层:半透明「点击显示」,不拦截点击 */}
                    {isBlurred && !batchMode && hoveredBlurId === job.id && (
                      <div className="lib-blur-hint" aria-hidden="true">
                        点击显示
                      </div>
                    )}
                    </button>

                    {/* 批量模式:左上勾选圈(与缩略图点击同效,提供独立焦点目标) */}
                    {batchMode && (
                      <button
                        type="button"
                        className={`lib-check${isSelected ? " is-checked" : ""}`}
                        aria-label={
                          isSelected
                            ? `取消选择作品: ${job.prompt || "无提示词"}`
                            : `选择作品: ${job.prompt || "无提示词"}`
                        }
                        aria-pressed={isSelected}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleSelect(job.id);
                        }}
                      >
                        <Icon name="check" size={12} />
                      </button>
                    )}

                    {/* 快捷操作浮层:hover 浮出右上角玻璃操作组(查看/复用/存风格/删除) */}
                    {!batchMode && (
                      <div
                        className="lib-actions"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          className="lib-action-btn"
                          title="查看大图"
                          aria-label="查看大图"
                          onClick={(e) => {
                            e.stopPropagation();
                            openLightbox(job);
                          }}
                        >
                          <Icon name="zoom-in" size={14} />
                        </button>
                        <button
                          type="button"
                          className="lib-action-btn"
                          title="复用提示词"
                          aria-label="复用提示词"
                          onClick={(e) => {
                            e.stopPropagation();
                            reusePrompt(job);
                          }}
                        >
                          <Icon name="link" size={14} />
                        </button>
                        <button
                          type="button"
                          className="lib-action-btn"
                          title="存为风格"
                          aria-label="存为风格"
                          onClick={(e) => {
                            e.stopPropagation();
                            openStylePopover(job, e.currentTarget);
                          }}
                        >
                          <Icon name="palette" size={14} />
                        </button>
                        <button
                          type="button"
                          className="lib-action-btn lib-action-btn--danger"
                          title="删除作品"
                          aria-label="删除作品"
                          disabled={deletingId === job.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(job);
                          }}
                        >
                          <Icon
                            name={deletingId === job.id ? "loading" : "delete"}
                            size={14}
                          />
                        </button>
                      </div>
                    )}

                    {isVideo && hasResult && (
                      <div className="lib-video-badge" aria-hidden="true">
                        <Icon name="playing" size={11} />
                        视频
                      </div>
                    )}

                    {/* R18 徽标(M9):缩略图右下角(避开左上状态与右上操作组),仅 nsfw 作品渲染 */}
                    {isNsfw && (
                      <span className="lib-nsfw-badge" aria-hidden="true">
                        18+
                      </span>
                    )}
                  </div>

                  <div className="lib-foot">
                    <div className="lib-card-title" title={job.prompt}>
                      {job.prompt || "(无提示词)"}
                    </div>
                    <div className="lib-meta">
                      <span className="lib-kind" title={kindLabel(job.kind)}>
                        {kindLabel(job.kind)}
                      </span>
                      <span className="lib-time">{formatTime(job.created_at)}</span>
                      <span
                        className={`lib-status-dot is-${job.status}`}
                        title={statusLabel(job.status)}
                        aria-label={`状态:${statusLabel(job.status)}`}
                      />
                    </div>
                  </div>
                </article>
              );
            })}
            </div>
            {hasMore && (
              <div className="lib-load-more">
                <Button
                  variant="secondary"
                  className="lib-load-more-btn"
                  onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                >
                  加载更多(已显示 {visibleJobs.length} / {filtered.length})
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {/* 批量模式:底部浮动操作条(已选计数 / 批量删除 / 取消) */}
      {batchMode && (
        <div className="lib-batchbar" role="region" aria-label="批量操作">
          <span className="lib-batchbar-count">已选 {selectedIds.size} 项</span>
          <span className="lib-batchbar-sep" aria-hidden="true" />
          <Button
            size="sm"
            variant="danger"
            disabled={selectedIds.size === 0 || batchDeleting}
            loading={batchDeleting}
            icon={<Icon name="delete" size={14} />}
            onClick={() => {
              setDeleteError(null);
              setConfirmBatchDelete(true);
            }}
          >
            批量删除
          </Button>
          <Button size="sm" variant="ghost" onClick={exitBatchMode}>
            取消
          </Button>
        </div>
      )}

      {/* 沉浸查看器:Frame.io 式左舞台 + 右元信息面板;←/→ 穿梭 + 快捷操作 */}
      {lightboxIdx !== null && filtered[lightboxIdx] && (
        <LibraryLightbox
          jobs={filtered}
          index={lightboxIdx}
          onClose={() => setLightboxIdx(null)}
          onIndex={setLightboxIdx}
          onSaveStyle={openStylePopover}
          onReuse={reusePromptAsDraft}
          onDelete={handleDelete}
          deletingId={deletingId}
          dialogsOpen={!!styleTarget || !!confirmDelete || !!confirmDeleteStyle || confirmBatchDelete}
        />
      )}

      {/* 存为风格 Popover(WS4):锚定到触发按钮,命名后写入 toiv_style_cards */}
      <Popover
        open={!!styleTarget}
        anchorRef={styleAnchorRef}
        onClose={() => setStyleTarget(null)}
        width={260}
        className="lib-style-pop"
        role="dialog"
        ariaLabel="存为风格"
        /* 灯箱(z-modal)内触发时弹层须压过灯箱背板 */
        zIndex="calc(var(--z-modal) + 1)"
      >
        <span className="lib-style-pop-title">存为风格</span>
        <div className="lib-style-pop-row">
          <Input
            value={styleName}
            placeholder="风格名称(同名覆盖)"
            maxLength={30}
            autoFocus
            onChange={(e) => setStyleName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveStyleCard();
            }}
          />
          <Button size="sm" onClick={saveStyleCard}>
            保存
          </Button>
        </div>
      </Popover>

      {/* 删除确认对话框(Modal 基座,替代原生 window.confirm) */}
      <Modal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title="删除作品"
        danger
        preventClose={deletingId !== null}
        footer={
          <>
            <Button
              variant="secondary"
              disabled={deletingId !== null}
              onClick={() => setConfirmDelete(null)}
            >
              取消
            </Button>
            <Button
              variant="danger"
              loading={deletingId !== null}
              icon={<Icon name="delete" size={14} />}
              onClick={handleConfirmDelete}
            >
              {deletingId ? "删除中…" : "确认删除"}
            </Button>
          </>
        }
      >
        <div className="lib-confirm-body">
          <div className="lib-confirm-warn">
            确定删除这件作品?此操作不可撤销,作品的所有数据将被永久移除。
          </div>
          {confirmDelete?.prompt && (
            <div className="lib-confirm-prompt">
              {confirmDelete.prompt.length > 80
                ? confirmDelete.prompt.slice(0, 80) + "…"
                : confirmDelete.prompt}
            </div>
          )}
          {deleteError && (
            <div className="lib-confirm-error">
              <Icon name="error" size={13} /> {deleteError}
            </div>
          )}
        </div>
      </Modal>

      {/* 批量删除确认对话框:列出数量,同一 Modal danger 基座 */}
      <Modal
        open={confirmBatchDelete}
        onClose={() => setConfirmBatchDelete(false)}
        title="批量删除作品"
        danger
        preventClose={batchDeleting}
        footer={
          <>
            <Button
              variant="secondary"
              disabled={batchDeleting}
              onClick={() => setConfirmBatchDelete(false)}
            >
              取消
            </Button>
            <Button
              variant="danger"
              loading={batchDeleting}
              icon={<Icon name="delete" size={14} />}
              onClick={handleConfirmBatchDelete}
            >
              {batchDeleting ? "删除中…" : `确认删除 ${selectedIds.size} 件`}
            </Button>
          </>
        }
      >
        <div className="lib-confirm-body">
          <div className="lib-confirm-warn">
            确定删除选中的 {selectedIds.size} 件作品?此操作不可撤销,这些作品的所有数据将被永久移除。
          </div>
          {deleteError && (
            <div className="lib-confirm-error">
              <Icon name="error" size={13} /> {deleteError}
            </div>
          )}
        </div>
      </Modal>

      {/* 删除风格卡确认对话框(P0-2):与删除作品同一确认范式,文案同款 */}
      <Modal
        open={!!confirmDeleteStyle}
        onClose={() => setConfirmDeleteStyle(null)}
        title="删除风格"
        danger
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setConfirmDeleteStyle(null)}
            >
              取消
            </Button>
            <Button
              variant="danger"
              icon={<Icon name="delete" size={14} />}
              onClick={confirmDeleteStyleCard}
            >
              确认删除
            </Button>
          </>
        }
      >
        <div className="lib-confirm-body">
          <div className="lib-confirm-warn">
            确定删除这个风格?此操作不可撤销,风格卡数据将被永久移除。
          </div>
          {confirmDeleteStyle && (
            <div className="lib-confirm-prompt">{confirmDeleteStyle.name}</div>
          )}
        </div>
      </Modal>

    </div>
  );
}


// ────────────────────────────────────────────────────────────────
// LibraryLightbox:作品沉浸查看器(Frame.io 式重设计,2026-08-15)
// 左侧大预览舞台(深色恒压暗,作品是主角)+ 右侧固定宽元信息面板
// (类型/状态/时间/kind/seed/提示词全文/操作组);←/→ 键盘与按钮穿梭;
// 操作复用 LibraryView 现有逻辑:下载(anchor download)、存为风格(锚点 Popover)、
// 复用提示词(引擎草稿 + 跳工作台)、删除(既有确认 Modal)。
// ────────────────────────────────────────────────────────────────

interface LibraryLightboxProps {
  /** 当前查询结果列表(穿梭范围) */
  jobs: JobItem[];
  index: number;
  onClose: () => void;
  onIndex: (idx: number) => void;
  /** 存为风格:复用 LibraryView.openStylePopover(锚定到灯箱面板按钮) */
  onSaveStyle: (job: JobItem, anchor: HTMLButtonElement) => void;
  /** 复用提示词:复用 LibraryView.reusePromptAsDraft(写草稿 + 跳工作台) */
  onReuse: (job: JobItem) => void;
  /** 删除:复用 LibraryView.handleDelete(打开既有确认 Modal) */
  onDelete: (job: JobItem) => void;
  deletingId: string | null;
  /** 存风格 Popover / 删除 Modal 打开时,灯箱让出 Esc/方向键(避免一按两关) */
  dialogsOpen: boolean;
}

function LibraryLightbox({
  jobs,
  index,
  onClose,
  onIndex,
  onSaveStyle,
  onReuse,
  onDelete,
  deletingId,
  dialogsOpen,
}: LibraryLightboxProps) {
  const job = jobs[index];
  const hasResult = job.status === "done" && job.results?.length > 0;
  const isVideo = isVideoKind(job.kind);
  const isAudio = kindToFilter(job.kind) === "audio";
  const mediaUrl = hasResult ? imageUrl(job.results[0]) : "";

  // 打开期间锁定 body 滚动(与 ui/Modal 同一模式;overscroll-behavior 在 CSS 侧拦截滚轮链)
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // 键盘:Esc 关闭,←/→ 穿梭;存风格/删除对话框打开时让出按键
  useEffect(() => {
    if (dialogsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      else if (e.key === "ArrowRight" && index < jobs.length - 1) onIndex(index + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialogsOpen, index, jobs.length, onClose, onIndex]);

  let createdFull = job.created_at;
  try {
    createdFull = new Date(job.created_at).toLocaleString("zh-CN");
  } catch {
    /* 非法日期回显原始串 */
  }

  return (
    <div
      className="lib-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`作品查看器: ${job.prompt || "无提示词"}`}
      onClick={onClose}
    >
      <div className="lib-lb-shell" onClick={(e) => e.stopPropagation()}>
        {/* 左侧:媒体舞台(全出血 contain;失败/音频作品显示对应占位) */}
        <div className="lib-lb-stage">
          {hasResult ? (
            isVideo ? (
              <video
                key={mediaUrl}
                className="lib-lb-media"
                src={mediaUrl}
                controls
                autoPlay
                loop
              />
            ) : isAudio ? (
              <div className="lib-lb-audio">
                <div className="lib-lb-audio-icon">
                  <Icon name="audio" size={36} strokeWidth={1.4} />
                </div>
                <audio src={mediaUrl} controls autoPlay />
              </div>
            ) : (
              <img
                className="lib-lb-media"
                src={mediaUrl}
                alt={job.prompt}
                /* 纵横比提示(基准 16:9),contain 适配舞台,加载后按自然比例还原 */
                width={480}
                height={270}
                loading="lazy"
                decoding="async"
              />
            )
          ) : (
            <div className="lib-lb-placeholder">
              <ThumbPlaceholder job={job} />
            </div>
          )}

          {/* 左右穿梭按钮(键盘 ←/→ 同效),悬于舞台两侧 */}
          {index > 0 && (
            <button
              type="button"
              className="lib-lb-nav lib-lb-nav-prev"
              aria-label="上一作品"
              title="上一作品(←)"
              onClick={() => onIndex(index - 1)}
            >
              <Icon name="chevron-left" size={18} />
            </button>
          )}
          {index < jobs.length - 1 && (
            <button
              type="button"
              className="lib-lb-nav lib-lb-nav-next"
              aria-label="下一作品"
              title="下一作品(→)"
              onClick={() => onIndex(index + 1)}
            >
              <Icon name="chevron-right" size={18} />
            </button>
          )}
        </div>

        {/* 右侧:固定宽元信息面板(类型 / 状态 / 时间 / kind / seed / 提示词全文 / 操作组) */}
        <aside className="lib-lb-side">
          <div className="lib-lb-side-head">
            <span className="lib-kind">{kindLabel(job.kind)}</span>
            <span className="lib-lb-counter">
              {index + 1} / {jobs.length}
            </span>
            <button
              type="button"
              className="lib-lb-close"
              aria-label="关闭预览"
              title="关闭(Esc)"
              onClick={onClose}
            >
              <Icon name="close" size={16} />
            </button>
          </div>

          <dl className="lib-lb-meta">
            <div className="lib-lb-meta-row">
              <dt>状态</dt>
              <dd>
                <span
                  className={`lib-status-dot is-${job.status}`}
                  aria-hidden="true"
                />
                {statusLabel(job.status)}
              </dd>
            </div>
            <div className="lib-lb-meta-row">
              <dt>类型</dt>
              <dd className="lib-lb-kind-value">{job.kind}</dd>
            </div>
            <div className="lib-lb-meta-row">
              <dt>时间</dt>
              <dd>
                {createdFull}
                <span className="lib-lb-time-rel">({formatTime(job.created_at)})</span>
              </dd>
            </div>
            <div className="lib-lb-meta-row">
              <dt>Seed</dt>
              <dd className="lib-lb-num">{job.seed}</dd>
            </div>
          </dl>

          <div className="lib-lb-prompt-block">
            <span className="lib-lb-prompt-label">提示词</span>
            <p className="lib-lb-prompt-text">{job.prompt || "(无提示词)"}</p>
          </div>

          <div className="lib-lb-side-actions">
            {hasResult && (
              <a
                className="lib-lb-action"
                href={mediaUrl}
                download
                aria-label="下载作品"
              >
                <Icon name="download" size={14} />
                下载
              </a>
            )}
            <button
              type="button"
              className="lib-lb-action"
              onClick={() => onReuse(job)}
            >
              <Icon name="link" size={14} />
              复用提示词
            </button>
            <button
              type="button"
              className="lib-lb-action"
              onClick={(e) => onSaveStyle(job, e.currentTarget)}
            >
              <Icon name="palette" size={14} />
              存为风格
            </button>
            <button
              type="button"
              className="lib-lb-action lib-lb-action--danger"
              disabled={deletingId === job.id}
              onClick={() => onDelete(job)}
            >
              <Icon name={deletingId === job.id ? "loading" : "delete"} size={14} />
              删除作品
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
