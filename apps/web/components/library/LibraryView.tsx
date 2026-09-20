"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { pickFromJob, saveAssetPick } from "@/lib/assetPick";
import { pullPreferences, schedulePush } from "@/lib/preferencesSync";
import { BoardsView } from "@/components/library/BoardsView";
import { fetchBoardItems, fetchBoards, putBoardItems, type BoardOut } from "@/lib/api";
import { buildRemixLink } from "@/lib/remixLink";
import { cleanupFailedJobs, deleteJob, fetchJobCount, fetchJobsPage, imageThumbUrl, fetchTrash, getVideoUpscaleStatus, imageUrl, invalidateJobs, listJobs, permanentDeleteJob, purgeTrash, rerunJob, restoreJob, threeDOps, threeDTexture, undoDelete, upscaleVideo } from "@/lib/api";
import { ENGINE_DRAFT_KEY } from "@/lib/engine";
import { begin as genBegin, end as genEnd, progress as genProgress } from "@/lib/generationBus";
import { useR18Mode } from "@/lib/r18";
import {
  applyLibraryQuery,
  countByFilter,
  deleteJobsBatch,
  FILTERS,
  flattenLightboxEntries,
  folderCover,
  formatRetention,
  formatTime,
  groupLibraryEntries,
  isVideoKind,
  buildMetaBlock,
  canRerun,
  kindLabel,
  loadFavorites,
  loadViews,
  pngHasWorkflow,
  saveFavorites,
  saveViews,
  timeSlotKeyOf,
  TIME_SLOT_LABELS,
  type SavedView,
  kindToFilter,
  kindsQueryForFilter,
  loadDensity,
  makeSeqGate,
  persistDensity,
  splitCardTitle,
  statusLabel,
  type BatchFolder,
  type ContentFilterKey,
  type FilterKey,
  type LibraryDensity,
  type LightboxEntry,
  type SortKey,
} from "@/lib/libraryQuery";
import type { JobItem, TrashJobItem } from "@/lib/types";
import { mediaKindOf } from "@/lib/mediaKind";
import { Icon } from "@/components/ui/Icon";
import { LazyVideo } from "@/components/ui/LazyVideo";
import { ServiceWakeOverlay } from "@/components/orch/ServiceWakeOverlay";
import { parseWakeError } from "@/lib/orch";
import { ModelViewer } from "@/components/ui/ModelViewer";
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
const MAX_MOUNTED = 180;
// 服务端页大小:作品库 60(jobs 全局 200 过重:单页 200 条全量对象+产物列表)
const LIBRARY_PAGE_LIMIT = 60;

/** 占位卡类型桶:kind 映射优先;未知 kind 用产物扩展名兜底;都无则 other(「其他」)。 */
function thumbFilterOf(job: JobItem): "image" | "video" | "audio" | "3d" | "other" {
  const f = kindToFilter(job.kind);
  if (f === "image" || f === "video" || f === "audio" || f === "3d") return f;
  if (job.results?.length) {
    const mk = mediaKindOf(job.results[0], job.kind);
    if (mk === "model3d") return "3d";
    if (mk === "video" || mk === "audio" || mk === "image") return mk;
  }
  return "other";
}

/** 来源筛选当前值的中文展示(工具条 chip 文案)。 */
function sourceLabelOf(
  source: string,
  options: { engines: { value: string; label: string; count: number }[]; apps: { value: string; label: string; count: number }[] },
): string {
  if (!source) return "来源";
  const hit = [...options.engines, ...options.apps].find((o) => o.value === source);
  return hit ? hit.label : "来源";
}

/** 秒 → m:ss(时长角标)。 */
function formatDurationHint(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function ThumbPlaceholder({ job }: { job: JobItem }) {
  const filterKey = thumbFilterOf(job);
  const iconName =
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
              : filterKey === "other"
                ? "file"
                : "image";
  return (
    <div
      className={`lib-thumb-placeholder${job.status === "error" ? " has-error" : ""}`}
      data-filter={filterKey}
    >
      {/* 类型图标居中 + 渐变底(跟市场 rh-card-placeholder 同范式);状态 chip 左上分层 */}
      <span className="lib-thumb-placeholder-icon" aria-hidden="true">
        <Icon name={iconName} size={28} strokeWidth={1.4} />
      </span>
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
      src={imageThumbUrl(job.results[0])}
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

/** 视频缩略:LazyVideo 加载失败(坏链/非视频)降级类型占位,不露出破图/空黑卡。 */
function VideoThumb({ job, blurred = false }: { job: JobItem; blurred?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <ThumbPlaceholder job={job} />;
  return (
    <LazyVideo
      src={imageUrl(job.results[0])}
      /* 海报=服务端 ffmpeg 抽帧(360px JPEG,~15KB):网格秒开,不再整屏拉视频元数据;
         悬停才拉元数据做 hover 预览 */
      poster={imageThumbUrl(job.results[0])}
      hoverOnly
      muted
      loop
      playsInline
      onError={() => setFailed(true)}
      style={
        blurred
          ? { filter: "blur(18px)", pointerEvents: "auto", cursor: "pointer" }
          : undefined
      }
    />
  );
}

/**
 * 网格缩略统一入口(文件夹/主网格/回收站共用):
 * 无产物 → 类型渐变占位;3D/音频永不走 <img>;视频/图像加载失败降级占位(P2 破图兜底)。
 */
function JobThumbMedia({ job, blurred = false }: { job: JobItem; blurred?: boolean }) {
  const hasResult = job.status === "done" && job.results?.length > 0;
  if (!hasResult) return <ThumbPlaceholder job={job} />;
  const mk = mediaKindOf(job.results[0], job.kind);
  // 3D / 音频:网格不尝试 <img>/<video> 加载,类型图标 + 渐变底占位(预览进灯箱)
  if (mk === "model3d" || mk === "audio") return <ThumbPlaceholder job={job} />;
  if (mk === "video") return <VideoThumb job={job} blurred={blurred} />;
  return <ImageThumb job={job} blurred={blurred} />;
}

/** 作品库空态(库本身为空):单行 muted 提示 + 行内「去创作」(2026-09-02 W3 大图标面板退役)。 */
export function LibraryEmptyState({ onCreate }: { onCreate?: () => void }) {
  return (
    <div className="lib-empty">
      <span className="lib-empty-hint">暂无作品</span>
      {onCreate && (
        <Button
          variant="ghost"
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
  // 服务端分页(2026-08-16):首页走 swr 缓存(≤200 条),触底自动拉下一页追加;
  // serverHasMore = 最后拉取的一页返回满页(==LIBRARY_PAGE_LIMIT)即可能还有
  const [serverHasMore, setServerHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // 工具条(2026-08-15 重设计):prompt 搜索 / 时间排序 / 网格密度(持久化)
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");
  const [density, setDensity] = useState<LibraryDensity>(() => loadDensity());
  // 来源筛选(2026-09-20 A2):空=全部;engine:{kind} / app:{appId}
  const [source, setSource] = useState("");
  // 重试状态机(2026-09-20 A1):jobId → 新 prompt_id(轮询中)
  const [retrying, setRetrying] = useState<ReadonlyMap<string, string>>(new Map());
  const [sourceOpen, setSourceOpen] = useState(false);
  // 收藏(P1 A5):localStorage 持久;只看收藏开关;跨端同步留 P2
  const [favorites, setFavorites] = useState<ReadonlySet<string>>(() => loadFavorites());
  const [favOnly, setFavOnly] = useState(false);
  // 动态文件夹(P2):已存视图 localStorage;saveName=内联命名输入(空=未在命名)
  const [views, setViews] = useState<SavedView[]>(() => loadViews());
  const [saveName, setSaveName] = useState("");
  const saveCurrentView = useCallback(() => {
    const name = saveName.trim();
    if (!name) return;
    const v: SavedView = {
      id: `view-${Date.now().toString(36)}`,
      name,
      query: { filter, contentFilter, source, search, favOnly },
    };
    setViews((prev) => {
      const next = [...prev, v];
      saveViews(next);
      schedulePush({ views: JSON.stringify(next) });
      return next;
    });
    setSaveName("");
  }, [saveName, filter, contentFilter, source, search, favOnly]);

  const deleteView = useCallback((id: string) => {
    setViews((prev) => {
      const next = prev.filter((v) => v.id !== id);
      saveViews(next);
      schedulePush({ views: JSON.stringify(next) });
      return next;
    });
  }, []);

  const toggleFavorite = useCallback((jobId: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      saveFavorites(next);
      schedulePush({ favorites: JSON.stringify([...next]) });
      return next;
    });
  }, []);
  // 来源弹层 Esc 关闭(与灯箱同惯例)
  useEffect(() => {
    if (!sourceOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSourceOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sourceOpen]);
  // 删除确认对话框状态:confirmDelete=待删作品;skipConfirmChecked=「不再确认」勾选
  const [confirmDelete, setConfirmDelete] = useState<JobItem | null>(null);
  const [skipConfirmChecked, setSkipConfirmChecked] = useState(false);
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // 删除确认对话框(替代 window.confirm / window.alert);skipConfirmChecked=「不再确认」勾选
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // 删除风格卡确认对话框(P0-2,与删除作品同一 Modal 基座)
  const [confirmDeleteStyle, setConfirmDeleteStyle] = useState<StyleCard | null>(null);
  // 视频超分到 4K:确认 Modal + 提交 busy 态(防重复提交)
  const [confirmUpscale, setConfirmUpscale] = useState<JobItem | null>(null);
  const [upscalingId, setUpscalingId] = useState<string | null>(null);
  const [upscaleError, setUpscaleError] = useState<string | null>(null);
  // 超分轮询计时器集合(组件卸载时清理,防 setState on unmounted;支持多作业并发)
  const upscaleTimerRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  // 沉浸查看器:当前查询结果列表内的索引;失败/音频作品也允许打开(显示对应占位)
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  // 灯箱穿梭范围:null=主列表;文件夹下钻内点开成员时=该文件夹成员(不穿梭出组)
  const [lightboxScope, setLightboxScope] = useState<readonly JobItem[] | null>(null);
  // 内容分组下钻:当前打开的文件夹 batch_id(null=主网格)
  const [openBatchId, setOpenBatchId] = useState<string | null>(null);
  // 多产物作业二级页(2026-09-15 用户拍板):叠放卡点击下钻,一页看全组图片
  const [openStackJobId, setOpenStackJobId] = useState<string | null>(null);
  // 风格卡(WS4):StyleBar 数据源 + 「存为风格」Popover 状态
  const [styleCards, setStyleCards] = useState<StyleCard[]>([]);
  const [styleTarget, setStyleTarget] = useState<JobItem | null>(null);
  const [styleName, setStyleName] = useState("");
  const styleAnchorRef = useRef<HTMLButtonElement | null>(null);
  // 回收站(2026-08-23):组件内条件渲染切换,不动路由
  const [showTrash, setShowTrash] = useState(false);
  // 画板(2026-09-21):画板视图切换 + 「移入画板」选择器(目标作品)
  const [showBoards, setShowBoards] = useState(false);
  const [boardPickerJob, setBoardPickerJob] = useState<JobItem | null>(null);
  const [boardsForPicker, setBoardsForPicker] = useState<BoardOut[] | null>(null);
  // 类型 chip 连点:忽略过期 fetchJobsPage 响应
  const jobsFetchGate = useRef(makeSeqGate()).current;

  // 类型桶总数(2026-09-15 计数重设计):服务端 COUNT,与分页/已加载量无关;
  // contentFilter 决定 nsfw 三态(主库 SFW 恒准;R18 模式下 SFW/R18 分开计)
  const [serverCounts, setServerCounts] = useState<Record<string, number> | null>(null);
  // 失败作品数(一键清理角标):counts 接口全量口径,与 kind/nsfw 过滤无关
  const [failedCount, setFailedCount] = useState(0);
  const countsFetchGate = useRef(makeSeqGate()).current;
  const loadCounts = useCallback(() => {
    const seq = countsFetchGate.next();
    const nsfw = !r18Mode ? "" : contentFilter === "r18" ? "true" : contentFilter === "sfw" ? "false" : "";
    const buckets: [FilterKey, string][] = [
      ["all", ""],
      ...FILTERS.filter((f) => f.key !== "all").map((f) => [f.key, kindsQueryForFilter(f.key)] as [FilterKey, string]),
    ];
    Promise.all(buckets.map(async ([key, kinds]) => [key, await fetchJobCount(kinds, nsfw)] as const))
      .then((entries) => {
        if (!countsFetchGate.isLive(seq)) return;
        setServerCounts(Object.fromEntries(entries.map(([k, v]) => [k, v.count])));
        const allEntry = entries.find(([k]) => k === "all");
        setFailedCount(allEntry ? allEntry[1].failed : 0);
      })
      .catch(() => {
        /* 静默回落客户端计数(仅反映已加载部分) */
      });
  }, [r18Mode, contentFilter]);

  const load = useCallback(() => {
    const seq = jobsFetchGate.next();
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    const kind = kindsQueryForFilter(filter);
    const req = kind ? fetchJobsPage(0, LIBRARY_PAGE_LIMIT, kind) : fetchJobsPage(0, LIBRARY_PAGE_LIMIT);
    req
      .then((page1) => {
        if (!jobsFetchGate.isLive(seq)) return;
        setJobs(page1);
        // 首页满页 → 服务端可能还有更早的作品(老作品不再被 50 条截断)
        setServerHasMore(page1.length >= LIBRARY_PAGE_LIMIT);
      })
      .catch((err) => {
        if (!jobsFetchGate.isLive(seq)) return;
        setError(err instanceof Error ? err.message : "加载作品失败");
      })
      .finally(() => {
        if (!jobsFetchGate.isLive(seq)) return;
        setLoading(false);
      });
  }, [filter]);

  // 服务端下一页:offset=已加载条数;按 id 去重(首页缓存 stale 期间新作业插入顶部
  // 会导致页间位置漂移重叠,去重兜底)
  const loadMoreServer = useCallback(() => {
    if (loadingMore || !serverHasMore) return;
    const seq = jobsFetchGate.peek();
    setLoadingMore(true);
    fetchJobsPage(jobs?.length ?? 0, LIBRARY_PAGE_LIMIT, kindsQueryForFilter(filter))
      .then((page) => {
        if (!jobsFetchGate.isLive(seq)) return;
        setServerHasMore(page.length >= LIBRARY_PAGE_LIMIT); // 页大小就是 60,误用 200 会让滚动提前停
        if (page.length > 0) {
          setJobs((prev) => {
            const seen = new Set((prev ?? []).map((j) => j.id));
            return [...(prev ?? []), ...page.filter((j) => !seen.has(j.id))];
          });
        }
      })
      .catch((err) => {
        if (!jobsFetchGate.isLive(seq)) return;
        toast.error(err instanceof Error ? err.message : "加载更多失败");
      })
      .finally(() => {
        if (!jobsFetchGate.isLive(seq)) return;
        setLoadingMore(false);
      });
  }, [jobs?.length, loadingMore, serverHasMore, toast, filter]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    loadCounts();
  }, [loadCounts]);

  // 挂载后读取本地风格卡(SSR 安全:loadStyleCards 内部判 window)
  useEffect(() => {
    setStyleCards(loadStyleCards());
  }, []);

  // 跨端偏好同步(2026-09-21):登录时拉服务端覆盖本地(服务端为准);空串字段不动本地
  useEffect(() => {
    void pullPreferences({
      favorites: (json) => {
        try {
          const arr = JSON.parse(json);
          if (Array.isArray(arr)) {
            const set = new Set(arr as string[]);
            setFavorites(set);
            saveFavorites(set);
          }
        } catch { /* 坏 JSON 不覆盖 */ }
      },
      views: (json) => {
        try {
          const arr = JSON.parse(json);
          if (Array.isArray(arr)) {
            setViews(arr);
            saveViews(arr);
          }
        } catch { /* 同上 */ }
      },
      density: (v) => {
        if (v === "comfortable" || v === "compact") {
          setDensity(v);
          persistDensity(v);
        }
      },
      styleCards: (json) => {
        try {
          window.localStorage.setItem(STYLE_CARDS_KEY, json);
          setStyleCards(loadStyleCards());
        } catch { /* 同上 */ }
      },
    });
  }, []);

  // 查询管线(纯函数,见 lib/libraryQuery):内容分级 → 类型 → 搜索 → 排序
  const baseFiltered = useMemo(
    () =>
      applyLibraryQuery(jobs ?? [], {
        filter,
        contentFilter,
        search,
        sort,
        source,
      }),
    [jobs, filter, contentFilter, search, sort, source],
  );

  // 只看收藏(P1 A5):组件态收藏集过滤(集合来自 localStorage,不进纯函数)
  const filtered = useMemo(
    () => (favOnly ? baseFiltered.filter((j) => favorites.has(j.id)) : baseFiltered),
    [baseFiltered, favOnly, favorites],
  );

  // 来源选项(A2):引擎族=已加载作品里的 kind 去重(带计数);应用=app_id 去重。
  // 只基于已加载部分(服务端分页),选项随加载自然增多——对「找最近来源」场景足够。
  const sourceOptions = useMemo(() => {
    const jobsArr = jobs ?? [];
    const engines = new Map<string, number>();
    const apps = new Map<string, { name: string; count: number }>();
    for (const j of jobsArr) {
      if (!j.app_id) {
        engines.set(j.kind, (engines.get(j.kind) ?? 0) + 1);
      } else {
        const cur = apps.get(j.app_id);
        apps.set(j.app_id, {
          name: j.app_name || j.app_id,
          count: (cur?.count ?? 0) + 1,
        });
      }
    }
    const eng = [...engines.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([kind, count]) => ({ value: `engine:${kind}`, label: kindLabel(kind), count }));
    const app = [...apps.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([id, v]) => ({ value: `app:${id}`, label: v.name, count: v.count }));
    return { engines: eng, apps: app };
  }, [jobs]);

  // 类型计数(chip 徽标):服务端真实总数优先(与分页无关);
  // 未回/失败时回落客户端口径(只反映已加载部分,过渡态)
  const counts = useMemo(() => {
    const client = countByFilter(jobs ?? [], contentFilter);
    if (!serverCounts) return client;
    if (!r18Mode || contentFilter === "all") {
      // 非 R18 模式服务端已剔 R18;all 桶三态同义 → 服务端数
      return { ...client, ...serverCounts } as Record<FilterKey, number>;
    }
    // R18 模式 + SFW/R18 分级:服务端数已是该分级的口径(loadCounts 按 nsfw 三态拉取)
    return { ...client, ...serverCounts } as Record<FilterKey, number>;
  }, [jobs, contentFilter, serverCounts, r18Mode]);

  // 内容分组(2026-08-24):带 batch_id 的作业(360° 环绕序列)折叠为文件夹卡;
  // P2 变体组:同 kind+seed+prompt 的作业折叠为「变体组」文件夹(防 rerun 刷库);
  // 筛选已先作用于成员 → 文件夹按成员 kind 归属对应类型桶
  const entries = useMemo(() => groupLibraryEntries(filtered, { groupVariants: true }), [filtered]);

  // 当前打开的文件夹(下钻);成员删到 <2 时文件夹自然消失 → 自动退回主网格
  const openFolder: BatchFolder | null = useMemo(() => {
    if (!openBatchId) return null;
    const hit = entries.find((e) => e.type === "batch" && e.folder.batchId === openBatchId);
    return hit && hit.type === "batch" ? hit.folder : null;
  }, [entries, openBatchId]);

  useEffect(() => {
    if (openBatchId && !openFolder) setOpenBatchId(null);
  }, [openBatchId, openFolder]);

  // 多图二级页目标作业:作业被删/不在客户端列表时自动退回作品库
  const openStackJob: JobItem | null = useMemo(() => {
    if (!openStackJobId) return null;
    return (jobs ?? []).find((j) => j.id === openStackJobId) ?? null;
  }, [jobs, openStackJobId]);
  useEffect(() => {
    if (openStackJobId && !openStackJob) setOpenStackJobId(null);
  }, [openStackJobId, openStackJob]);

  // 灯箱穿梭列表:文件夹下钻内点开成员时限定在组内,否则为整个查询结果;
  // 展平为条目序列(单作业多产物逐张翻看,2026-09-15)
  const lightboxJobs = lightboxScope ?? filtered;
  const lightboxEntries = useMemo(
    () => flattenLightboxEntries(lightboxJobs),
    [lightboxJobs],
  );

  // 灯箱索引越界钳制:删除当前作品后列表收缩,滑到下一件;列表清空则关闭
  useEffect(() => {
    if (lightboxIdx === null) return;
    if (lightboxEntries.length === 0) setLightboxIdx(null);
    else if (lightboxIdx >= lightboxEntries.length) setLightboxIdx(lightboxEntries.length - 1);
  }, [lightboxEntries.length, lightboxIdx]);

  // 列表收缩(删除/刷新)后 prune 选中集,避免选中已不存在的作品
  useEffect(() => {
    if (!jobs || selectedIds.size === 0) return;
    const alive = new Set(jobs.map((j) => j.id));
    setSelectedIds((prev) => {
      const next = new Set([...prev].filter((id) => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [jobs, selectedIds.size]);

  const visibleEntries = useMemo(
    // DOM 窗口化:最多挂载 180 条,更早的移出(滚动位置由锚点/重挂兜底),防长会话卡顿
    () => entries.slice(Math.max(0, visibleCount - MAX_MOUNTED), visibleCount),
    [entries, visibleCount],
  );

  // 时间分组头部(B3):仅「最新」排序生效;文件夹按最新成员时间归槽;
  // Map<可视索引, 槽文案>,槽变化处插粘性组标题(纯展示,不影响条目 key/穿梭)。
  const timeHeaderAt = useMemo(() => {
    const m = new Map<number, string>();
    if (sort !== "newest") return m;
    let prevSlot: string | null = null;
    const msOf = (iso: string) => {
      const t = Date.parse(iso);
      return Number.isNaN(t) ? 0 : t;
    };
    visibleEntries.forEach((entry, i) => {
      const t =
        entry.type === "job"
          ? msOf(entry.job.created_at)
          : Math.max(...entry.folder.members.map((mm) => msOf(mm.created_at)));
      const slot = timeSlotKeyOf(t);
      if (slot !== prevSlot) {
        m.set(i, TIME_SLOT_LABELS[slot]);
        prevSlot = slot;
      }
    });
    return m;
  }, [visibleEntries, sort]);
  const hasMore = entries.length > visibleCount;

  // 统一推进一步:客户端已加载的先看(扩 visibleCount),看完了再拉服务端下一页
  const advance = useCallback(() => {
    if (hasMore) setVisibleCount((c) => c + PAGE_SIZE);
    else loadMoreServer();
  }, [hasMore, loadMoreServer]);

  // 触底自动加载:监听底部哨兵;客户端/服务端两层分页都对用户透明(无限滚动)
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) advance();
    }, { rootMargin: "400px" }); // 提前 400px 预拉,滚动到底前就已加载
    io.observe(el);
    return () => io.disconnect();
  }, [advance]);

  // 查询条件变更统一重置分页(首屏 60 条)
  const resetPage = useCallback(() => setVisibleCount(PAGE_SIZE), []);

  // 应用视图:整组覆盖工具条筛选态(与 Midjourney Saved Searches 同哲学:管属性不管位置)
  const applyView = useCallback(
    (v: SavedView) => {
      setFilter(v.query.filter);
      setContentFilter(v.query.contentFilter);
      setSource(v.query.source);
      setSearch(v.query.search);
      setFavOnly(v.query.favOnly);
      resetPage();
    },
    [resetPage],
  );

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
    schedulePush({ density: next });
  };

  // ── 重试(2026-09-20 A1)──
  // 原参数原 seed 重放(rerunJob=后端 /jobs/{id}/rerun keep);
  // 旧失败卡原位显示「重试中」遮罩并轮询新作业,成功后旧卡移除、新卡自然浮顶,
  // 失败则原位恢复并内联报错。轮询定时器随组件卸载清理。
  const retryTimers = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  useEffect(() => {
    const timers = retryTimers.current;
    return () => {
      timers.forEach((t) => clearInterval(t));
    };
  }, []);

  const pollRetry = useCallback((oldJobId: string, promptId: string) => {
    const tick = async () => {
      try {
        const res = await fetch(
          `/api/jobs/lookup?prompt_id=${encodeURIComponent(promptId)}`,
          { headers: { Authorization: `Bearer ${localStorage.getItem("toiv_token") ?? ""}` } },
        );
        if (!res.ok) return;
        const job = (await res.json()) as JobItem;
        if (job.status === "queued" || job.status === "running" || job.status === "held") return;
        const timer = retryTimers.current.get(oldJobId);
        if (timer) clearInterval(timer);
        retryTimers.current.delete(oldJobId);
        setRetrying((prev) => {
          const next = new Map(prev);
          next.delete(oldJobId);
          return next;
        });
        if (job.status === "done") {
          // 旧失败卡移除,新卡由顶部 natural 排序浮出(若已加载页内则原地有数据)
          setJobs((prev) => (prev ? prev.filter((x) => x.id !== oldJobId) : prev));
          invalidateJobs();
          toast.success("重试成功,新作品已入库");
        } else {
          toast.error(job.error || "重试失败,可再次尝试");
        }
      } catch {
        /* 网络抖动下一拍再试 */
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 4000);
    retryTimers.current.set(oldJobId, timer);
  }, [toast]);

  const handleRetry = useCallback(
    async (job: JobItem, seedMode: "keep" | "random" = "keep") => {
      try {
        const r = await rerunJob(job.id, { seed_mode: seedMode });
        setRetrying((prev) => new Map(prev).set(job.id, r.prompt_id));
        pollRetry(job.id, r.prompt_id);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "重试提交失败");
      }
    },
    [pollRetry, toast],
  );

  // 续写链:按 id 盘内找源作品开灯箱,找不到则提示
  const openJobById = useCallback(
    (jobId: string) => {
      const hit = (jobs ?? []).find((j) => j.id === jobId);
      if (hit) {
        setLightboxScope(null);
        const idx = flattenLightboxEntries(filtered).findIndex((en) => en.job.id === hit.id);
        if (idx >= 0) setLightboxIdx(idx);
        else openLightbox(hit);
      } else {
        toast.info("源作品不在当前列表(可能被删除或未加载)");
      }
    },
    [jobs, filtered, toast],
  );

  // 一键同款(C2):成功作品原参数换 seed 重抽(rerun random);与重试共用状态机。
  const handleMakeAnother = useCallback(
    (job: JobItem) => {
      void handleRetry(job, "random");
    },
    [handleRetry],
  );

  // 闭门同款(2026-09-21):分享链接携带 prompt+seed+引擎+标量参数,
  // 接收方打开链接即导入运行台(媒体自备);纯前端零后端、无广场不触发 UGC 合规。
  const handleShareRemix = useCallback(
    async (job: JobItem) => {
      try {
        const url = buildRemixLink(job, isVideoKind(job.kind) ? "video" : "image");
        await navigator.clipboard.writeText(url);
        toast.success("同款链接已复制——对方打开即导入参数(媒体请自备)");
      } catch {
        toast.error("复制失败:请检查浏览器剪贴板权限");
      }
    },
    [toast],
  );

  // 移入画板:拉板列表开选择器 → 追加成员(读现有整组+PUT)
  const openBoardPicker = useCallback(async (job: JobItem) => {
    setBoardPickerJob(job);
    setBoardsForPicker(null);
    try {
      setBoardsForPicker(await fetchBoards());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "拉取画板失败");
      setBoardsForPicker([]);
    }
  }, [toast]);

  const addJobToBoard = useCallback(
    async (board: BoardOut) => {
      if (!boardPickerJob) return;
      try {
        const cur = await fetchBoardItems(board.id);
        if (cur.some((it) => it.job.id === boardPickerJob.id)) {
          toast.info(`已在画板「${board.name}」中`);
        } else {
          await putBoardItems(board.id, [
            ...cur.map((it) => ({ job_id: it.job.id, note: it.note, shot_text: it.shot_text })),
            { job_id: boardPickerJob.id },
          ]);
          toast.success(`已移入画板「${board.name}」`);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "移入画板失败");
      } finally {
        setBoardPickerJob(null);
      }
    },
    [boardPickerJob, toast],
  );

  // 资产即输入(C1):作品句柄暂存 → 跳对应生成台,引擎切换时自动填入媒体槽(免二次上传);
  // video 类目标引擎带 video 槽(longcat-continue/wan-animate 等)即续写入口。
  const handleUseAsInput = useCallback(
    (job: JobItem) => {
      const pick = pickFromJob(job);
      if (!pick) {
        toast.info("该作品无可用产物文件");
        return;
      }
      saveAssetPick(pick);
      const target = pick.kind === "video" ? "video" : pick.kind === "audio" ? "audio" : "image";
      setLightboxIdx(null);
      setLightboxScope(null);
      if (onNavigate) onNavigate(target);
      else window.location.assign(`/?view=${target}`);
    },
    [onNavigate, toast],
  );

  // ── 批量管理 ──

  const toggleSelect = (jobId: string) => {
    batchAnchorRef.current = jobId;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  };

  // Shift 连选(B1 2026-09-20):从上次点选锚点连选到当前(仅普通作品卡,跳过文件夹)
  const batchAnchorRef = useRef<string | null>(null);
  const rangeSelectTo = (jobId: string) => {
    const ids = visibleEntries.flatMap((e) => (e.type === "job" ? [e.job.id] : []));
    const from = batchAnchorRef.current ? ids.indexOf(batchAnchorRef.current) : -1;
    const to = ids.indexOf(jobId);
    if (from < 0 || to < 0 || from === to) {
      toggleSelect(jobId);
      return;
    }
    const [lo, hi] = from < to ? [from, to] : [to, from];
    setSelectedIds((prev) => new Set([...prev, ...ids.slice(lo, hi + 1)]));
  };

  const exitBatchMode = () => {
    setBatchMode(false);
    setSelectedIds(new Set());
    setConfirmBatchDelete(false);
    setDeleteError(null);
  };

  /** 全选当前已渲染的筛选结果(批量清理免逐张点;已全选时再点切换为清空)。
   *  文件夹成员不参与主网格批量选择(防整组误删),仅普通作品卡可选。 */
  const toggleSelectAllVisible = () => {
    setSelectedIds((prev) => {
      const allVisibleIds = visibleEntries.flatMap((e) => (e.type === "job" ? [e.job.id] : []));
      const allSelected = allVisibleIds.length > 0 && allVisibleIds.every((id) => prev.has(id));
      if (allSelected) {
        const next = new Set(prev);
        for (const id of allVisibleIds) next.delete(id);
        return next;
      }
      return new Set([...prev, ...allVisibleIds]);
    });
  };

  // 确认批量删除:顺序执行,成功项移出列表;有失败则保留失败项选中并内联报错
  const handleConfirmBatchDelete = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setBatchDeleting(true);
    setDeleteError(null);
    const { done, failed, undoTokens } = await deleteJobsBatch(ids, deleteJob);
    setBatchDeleting(false);
    if (done.length > 0) {
      invalidateJobs();
      const doneSet = new Set(done);
      setJobs((prev) => (prev ?? []).filter((j) => !doneSet.has(j.id)));
    }
    if (failed.length === 0) {
      // SAFETY:批量删除同样可撤销(逐件恢复,回收站保留期 72h)
      if (undoTokens.length > 0) {
        toast.success(`已删除 ${done.length} 件作品`, {
          label: "全部撤销",
          onClick: () => {
            Promise.allSettled(undoTokens.map((t) => undoDelete(t)))
              .then(() => {
                invalidateJobs();
                load();
                loadCounts();
                toast.success(`已恢复 ${undoTokens.length} 件作品`);
              })
              .catch(() => toast.error("撤销失败(可能已过期)"));
          },
        });
      } else {
        toast.success(`已删除 ${done.length} 件作品`);
      }
      exitBatchMode();
    } else {
      setSelectedIds(new Set(failed));
      setDeleteError(`${failed.length} 件删除失败,已保留选中,可重试`);
    }
  };

  // 点击删除:确认门可记忆跳过(SAFETY:删除已有回收站 72h 恢复兜底,熟练用户免打扰);
  // 记忆开关在确认对话框内勾选(localStorage 持久化)
  const handleDelete = (job: JobItem) => {
    setDeleteError(null);
    if (typeof window !== "undefined" && window.localStorage.getItem("toiv_skip_del_confirm") === "1") {
      void handleConfirmDeleteDirect(job);
      return;
    }
    setSkipConfirmChecked(false);
    setConfirmDelete(job);
  };

  // 确认删除:执行实际删除,失败时把错误信息内联显示在对话框中;
  // 勾选「不再确认」时持久化(SAFETY:熟练用户效率;撤销兜底仍在)
  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    if (typeof window !== "undefined") {
      if (skipConfirmChecked) window.localStorage.setItem("toiv_skip_del_confirm", "1");
      else window.localStorage.removeItem("toiv_skip_del_confirm");
    }
    await handleConfirmDeleteDirect(confirmDelete);
  };

  // 删除执行体(确认对话框与「不再确认」直达共用):SAFETY toast 带撤销入口
  const handleConfirmDeleteDirect = async (job: JobItem) => {
    setDeletingId(job.id);
    try {
      const result = await deleteJob(job.id);
      invalidateJobs();
      setJobs((prev) => (prev ?? []).filter((j) => j.id !== job.id));
      loadCounts();
      setConfirmDelete(null);
      setDeleteError(null);
      if (result.undo_token) {
        toast.success("已移入回收站(72 小时内可恢复)", {
          label: "撤销",
          onClick: () => {
            undoDelete(result.undo_token as string)
              .then(() => {
                invalidateJobs();
                load();
                loadCounts();
                toast.success("已恢复作品");
              })
              .catch((e: unknown) => toast.error(e instanceof Error ? e.message : "撤销失败(可能已过期)"));
          },
        });
      } else {
        toast.success("已删除作品");
      }
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "删除失败");
    } finally {
      setDeletingId(null);
    }
  };

  // 一键清理失败作品(2026-09-15):软删入回收站(72h 可恢复),不逐件出 undo
  const [confirmCleanupFailed, setConfirmCleanupFailed] = useState(false);
  const [cleanupFailedBusy, setCleanupFailedBusy] = useState(false);
  const handleCleanupFailed = async () => {
    setCleanupFailedBusy(true);
    try {
      const { deleted } = await cleanupFailedJobs();
      setConfirmCleanupFailed(false);
      invalidateJobs();
      load();
      loadCounts();
      toast.success(
        deleted > 0
          ? `已清理 ${deleted} 件失败作品(72 小时内可在回收站恢复)`
          : "没有需要清理的失败作品",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "清理失败作品出错");
    } finally {
      setCleanupFailedBusy(false);
    }
  };

  // ── 视频超分到 4K(M6 fleet 帧级管线) ──

  // 卸载清理:停掉全部超分轮询计时器(防 setState on unmounted)
  useEffect(() => {
    const timers = upscaleTimerRef.current;
    return () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    };
  }, []);

  // 点击「超分到 4K」:仅打开确认 Modal(与删除同一确认范式,不用 window.confirm)
  const handleUpscale = (job: JobItem) => {
    setUpscaleError(null);
    setConfirmUpscale(job);
  };

  // 轮询超分作业:帧级进度写全局进度条;终态收口(刷新作品库 + toast)
  const pollUpscale = useCallback(
    (jobId: string, taskId: string) => {
      const tick = async () => {
        try {
          const st = await getVideoUpscaleStatus(jobId);
          if (st.progress?.pct != null) genProgress(taskId, st.progress.pct);
          if (st.status === "done") {
            genEnd(taskId);
            invalidateJobs();
            load();
            toast.success("超分完成,4K 版本已收录作品库");
            return;
          }
          if (st.status === "error") {
            genEnd(taskId);
            toast.error("视频超分失败,可重新发起(已超分帧会断点续跑)");
            return;
          }
        } catch {
          // 单次轮询失败(网络抖动/重启)不打断,下轮继续
        }
        const t = setTimeout(tick, 3000);
        upscaleTimerRef.current.add(t);
      };
      const t = setTimeout(tick, 3000);
      upscaleTimerRef.current.add(t);
    },
    [load, toast],
  );

  // 确认超分:提交后端(秒回 Job),随后轮询状态;busy 态防重复提交
  const handleConfirmUpscale = async () => {
    if (!confirmUpscale) return;
    const job = confirmUpscale;
    const src = job.results?.[0];
    if (!src) {
      setUpscaleError("该作品没有可用产物");
      return;
    }
    setUpscalingId(job.id);
    setUpscaleError(null);
    try {
      const res = await upscaleVideo({ video_url: src, target: "4k" });
      const taskId = `video-upscale-${res.job_id}`;
      genBegin(taskId, "视频超分到 4K");
      toast.success("超分任务已提交,完成后自动收录作品库");
      setConfirmUpscale(null);
      pollUpscale(res.job_id, taskId);
    } catch (err) {
      setUpscaleError(err instanceof Error ? err.message : "超分提交失败");
    } finally {
      setUpscalingId(null);
    }
  };

  // 打开沉浸查看器:定位到穿梭列表中的索引(失败/音频作品同样可打开);
  // scope 缺省=主列表,文件夹下钻内传成员列表(穿梭不出组)
  const openLightbox = (job: JobItem, scope?: readonly JobItem[]) => {
    const list = scope ?? filtered;
    const entries = flattenLightboxEntries(list);
    const idx = entries.findIndex((e) => e.job.id === job.id);
    if (idx >= 0) {
      setLightboxScope(scope ?? null);
      setLightboxIdx(idx);
    }
  };

  /** 关闭灯箱:同时清空穿梭范围(回到主列表口径)。 */
  const closeLightbox = () => {
    setLightboxIdx(null);
    setLightboxScope(null);
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
    setLightboxScope(null);
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
      schedulePush({ style_cards: JSON.stringify(next) });
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
      schedulePush({ style_cards: JSON.stringify(next) });
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

  // 回收站视图(组件内条件渲染,不动路由;恢复后失效缓存并刷新主列表)
  if (showBoards) {
    return (
      <BoardsView
        onBack={() => setShowBoards(false)}
        onOpenJob={(memberJobs, idx) => {
          setLightboxScope(memberJobs);
          setLightboxIdx(idx);
        }}
        onUseAsInput={handleUseAsInput}
      />
    );
  }

  if (showTrash) {
    return (
      <LibraryTrashView
        onBack={() => setShowTrash(false)}
        onRestored={() => {
          invalidateJobs();
          load();
        }}
      />
    );
  }

  return (
    <div
      className={`single-view library-view${density === "compact" ? " is-compact" : ""}${batchMode ? " is-batch" : ""}`}
    >
      {/* 页头移除(2026-09-02 W3):计数胶囊并入工具条尾部 */}

      {/* 工具条(sticky):搜索 / 类型 chips / 内容分级 / 排序 / 密度 / 批量管理 / 计数;
          文件夹下钻视图隐藏(返回主网格即恢复) */}
      {!openFolder && !openStackJob && (
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

        {/* 组间 hairline(2026-08-16 审计):类型过滤 / 内容分级 / 排序三组胶囊混排难分边界 */}
        <span className="lib-toolbar-divider" aria-hidden="true" />

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

        {/* 来源筛选(2026-09-20 A2):引擎族/应用 两组带计数;点遮罩或选「全部来源」关闭 */}
        <div className="lib-source">
          <button
            type="button"
            className={`lib-chip lib-chip--sm${source ? " is-active" : ""}`}
            aria-pressed={!!source}
            aria-haspopup="listbox"
            aria-expanded={sourceOpen}
            onClick={() => setSourceOpen((v) => !v)}
            title="按来源筛选(引擎 / 应用)"
          >
            <Icon name="sliders" size={12} />
            <span>{sourceLabelOf(source, sourceOptions)}</span>
            <Icon name={sourceOpen ? "chevron-up" : "chevron-down"} size={12} />
          </button>
          {sourceOpen && (
            <>
              <button
                type="button"
                className="lib-source-scrim"
                aria-label="关闭来源筛选"
                onClick={() => setSourceOpen(false)}
              />
              <div className="lib-source-pop" role="listbox" aria-label="来源筛选">
                <button
                  type="button"
                  role="option"
                  aria-selected={!source}
                  className={`lib-source-item${!source ? " is-active" : ""}`}
                  onClick={() => { setSource(""); setSourceOpen(false); resetPage(); }}
                >
                  全部来源
                </button>
                {sourceOptions.engines.length > 0 && (
                  <div className="lib-source-group">引擎</div>
                )}
                {sourceOptions.engines.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="option"
                    aria-selected={source === o.value}
                    className={`lib-source-item${source === o.value ? " is-active" : ""}`}
                    onClick={() => { setSource(o.value); setSourceOpen(false); resetPage(); }}
                  >
                    <span className="lib-source-item-label">{o.label}</span>
                    <span className="lib-chip-count">{o.count}</span>
                  </button>
                ))}
                {sourceOptions.apps.length > 0 && (
                  <div className="lib-source-group">应用</div>
                )}
                {sourceOptions.apps.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="option"
                    aria-selected={source === o.value}
                    className={`lib-source-item${source === o.value ? " is-active" : ""}`}
                    onClick={() => { setSource(o.value); setSourceOpen(false); resetPage(); }}
                  >
                    <span className="lib-source-item-label">{o.label}</span>
                    <span className="lib-chip-count">{o.count}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <button
          type="button"
          className={`lib-chip lib-chip--sm${favOnly ? " is-active" : ""}`}
          aria-pressed={favOnly}
          title="只看收藏的作品"
          onClick={() => { setFavOnly((v) => !v); resetPage(); }}
        >
          <Icon name="heart" size={12} />
          收藏{favorites.size > 0 ? ` ${favorites.size}` : ""}
        </button>

        {/* 存视图(P2):把当前筛选组合存为动态文件夹;命名输入内联展开 */}
        {saveName === "" ? (
          <button
            type="button"
            className="lib-chip lib-chip--sm"
            title="把当前筛选组合存为视图(动态文件夹)"
            onClick={() => setSaveName(" ")}
          >
            <Icon name="plus" size={12} />
            存视图
          </button>
        ) : (
          <span className="lib-view-save">
            <input
              className="lib-view-save-input"
              value={saveName.trim()}
              placeholder="视图名称…"
              aria-label="视图名称"
              autoFocus
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveCurrentView();
                if (e.key === "Escape") setSaveName("");
              }}
            />
            <button type="button" className="lib-chip lib-chip--sm is-active" onClick={saveCurrentView}>
              存
            </button>
          </span>
        )}

        <div className="lib-toolbar-cluster">
          <span className="lib-toolbar-divider" aria-hidden="true" />
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

          {/* 组间 hairline(2026-08-16 视图批 1):「排序与视图」与「批量管理」划界,
              工具行四组结构成形(类型过滤 | 内容门控 | 排序与视图 | 批量管理) */}
          <span className="lib-toolbar-divider" aria-hidden="true" />

          <Button
            size="sm"
            variant={batchMode ? "primary" : "secondary"}
            className="lib-batch-toggle"
            icon={<Icon name={batchMode ? "check" : "list-ordered"} size={14} />}
            onClick={() => (batchMode ? exitBatchMode() : setBatchMode(true))}
          >
            {batchMode ? "完成" : "批量管理"}
          </Button>

          {/* 画板入口(2026-09-21 手动主题板) */}
          <Button
            size="sm"
            variant="secondary"
            className="lib-boards-toggle"
            icon={<Icon name="layers" size={14} />}
            onClick={() => setShowBoards(true)}
          >
            画板
          </Button>

          {/* 回收站入口(72h 保留期;与工具行同款次要按钮) */}
          <Button
            size="sm"
            variant="secondary"
            className="lib-trash-toggle"
            icon={<Icon name="delete" size={14} />}
            onClick={() => setShowTrash(true)}
          >
            回收站
          </Button>

          {/* 一键清理失败作品(2026-09-15 用户需求):有失败作品才出现;软删入回收站可恢复 */}
          {failedCount > 0 && (
            <Button
              size="sm"
              variant="secondary"
              className="lib-trash-toggle"
              icon={<Icon name="eraser" size={14} />}
              onClick={() => setConfirmCleanupFailed(true)}
            >
              清理失败 {failedCount}
            </Button>
          )}

          {/* 作品计数(2026-09-02 W3:页头移除,计数并入工具条尾;2026-09-15 改服务端总数) */}
          <span
            className="lib-count-pill"
            title={serverCounts ? `已加载 ${filtered.length} / 共 ${serverCounts[filter] ?? 0} 件` : undefined}
          >
            {loading
              ? "加载中…"
              : error
                ? "加载失败"
                : serverCounts
                  ? `共 ${serverCounts[filter] ?? 0} 件作品`
                  : `${filtered.length} 件作品`}
          </span>
        </div>
      </div>
      )}

      {/* 风格库横条(WS4):空态 StyleBar 内部返回 null,不渲染整条 */}
      {!openFolder && !openStackJob && (
      <StyleBar
        cards={styleCards}
        onApply={applyStyleCard}
        onDelete={requestDeleteStyleCard}
      />
      )}

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
          /* 结果空态(2026-09-02 W3):大图标面板 → 单行 muted 提示 + 行内清空;
             搜索范围注释收进 title 悬浮 */
          <div className="lib-empty lib-empty--result">
            <span
              className="lib-empty-hint"
              title={
                search.trim() && (jobs?.length ?? 0) > 0
                  ? `搜索仅覆盖已加载的 ${jobs?.length ?? 0} 件作品,更早的作品需向下滚动加载后可搜`
                  : undefined
              }
            >
              没有匹配的作品——试试调整关键词或清空全部条件
            </span>
            <Button
              variant="ghost"
              size="sm"
              icon={<Icon name="close" size={14} />}
              onClick={clearQuery}
            >
              清空筛选与搜索
            </Button>
            {/* 筛选空结果仍可能只是当前页没命中:服务端还有时继续拉,避免 chip 卡死空态 */}
            {serverHasMore && (
              <div ref={sentinelRef} className="lib-load-sentinel" aria-hidden="true" />
            )}
          </div>
        )}

        {/* 文件夹下钻视图(内容分组,2026-08-24):面包屑 + 成员网格;
            成员卡与普通作品卡同行为(点开大图组内穿梭/单独删除),不做整组删除 */}
        {!error && !loading && openFolder && (
          <>
            <nav className="lib-breadcrumb" aria-label="位置">
              <button
                type="button"
                className="lib-breadcrumb-back"
                onClick={() => setOpenBatchId(null)}
              >
                <Icon name="chevron-left" size={14} />
                作品库
              </button>
              <span className="lib-breadcrumb-sep" aria-hidden="true">
                /
              </span>
              <span className="lib-breadcrumb-current">
                {openFolder.variant
                  ? `同参数变体 ×${openFolder.members.length}`
                  : `环绕序列 ${openFolder.batchId.slice(0, 8)}`}
              </span>
              <span className="lib-breadcrumb-count">{openFolder.members.length} 张</span>
            </nav>
            <div className="lib-grid">
              {openFolder.members.map((job) => {
                const hasResult = job.status === "done" && job.results?.length > 0;
                const isVideo = isVideoKind(job.kind);
                // 3D 角标(缩略走 JobThumbMedia 占位)
                const is3d =
                  hasResult && mediaKindOf(job.results[0], job.kind) === "model3d";
                const isNsfw = !!job.nsfw;
                const isBlurred = isNsfw && !revealedIds.has(job.id);
                const cardText = splitCardTitle(job);
                return (
                  <article
                    key={job.id}
                    className={`lib-card${isVideo ? " is-video" : ""}${deletingId === job.id ? " is-deleting" : ""}`}
                  >
                    <div className="lib-thumb">
                      <button
                        type="button"
                        className="lib-thumb-hit"
                        aria-label={
                          isBlurred
                            ? "点击显示 R18 作品内容"
                            : `预览作品: ${job.prompt || "无提示词"}`
                        }
                        onClick={() => {
                          if (isBlurred) toggleReveal(job.id);
                          else openLightbox(job, openFolder.members);
                        }}
                      >
                        <JobThumbMedia job={job} blurred={isBlurred} />
                      </button>
                      {is3d && (
                        <span className="lib-3d-badge" aria-hidden="true">
                          <Icon name="box" size={11} />
                          3D
                        </span>
                      )}
                      {isNsfw && (
                        <button
                          type="button"
                          className="lib-nsfw-badge"
                          aria-label={isBlurred ? "显示 R18 作品内容" : "恢复模糊"}
                          title={isBlurred ? "显示内容" : "恢复模糊"}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleReveal(job.id);
                          }}
                        >
                          18+
                        </button>
                      )}
                      {/* 快捷操作浮层:查看大图(组内穿梭)/ 单独删除 */}
                      <div className="lib-actions" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="lib-action-btn"
                          title="查看大图"
                          aria-label="查看大图"
                          onClick={(e) => {
                            e.stopPropagation();
                            openLightbox(job, openFolder.members);
                          }}
                        >
                          <Icon name="zoom-in" size={14} />
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
                    </div>
                    <div className="lib-foot">
                      <div className="lib-card-title" title={job.prompt}>
                        {cardText.title || "(无提示词)"}
                      </div>
                      {cardText.meta && (
                        <div className="lib-card-sub" title={cardText.meta}>
                          {cardText.meta}
                        </div>
                      )}
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
          </>
        )}

        {/* 多产物二级页(2026-09-15 用户拍板):叠放卡下钻,一页看全组图片;
            点任意一张进灯箱并从该张起翻(穿梭范围=本组) */}
        {!error && !loading && !openFolder && openStackJob && (
          <>
            <nav className="lib-breadcrumb" aria-label="位置">
              <button
                type="button"
                className="lib-breadcrumb-back"
                onClick={() => setOpenStackJobId(null)}
              >
                <Icon name="chevron-left" size={14} />
                作品库
              </button>
              <span className="lib-breadcrumb-sep" aria-hidden="true">
                /
              </span>
              <span className="lib-breadcrumb-current">
                {splitCardTitle(openStackJob).title || "多图作品"}
              </span>
              <span className="lib-breadcrumb-count">
                {openStackJob.results.length} 张
              </span>
            </nav>
            <div className="lib-grid lib-stack-grid">
              {openStackJob.results.map((url, i) => {
                const mk = mediaKindOf(url, openStackJob.kind);
                // R18 纪律(M9):组内图片同样默认模糊,先揭示才可进灯箱
                const blurred = !!openStackJob.nsfw && !revealedIds.has(openStackJob.id);
                return (
                  <article key={`${openStackJob.id}-${i}`} className="lib-card">
                    <div className="lib-thumb">
                      <button
                        type="button"
                        className="lib-thumb-hit"
                        aria-label={
                          blurred
                            ? "点击显示 R18 作品内容"
                            : `预览第 ${i + 1} 张`
                        }
                        onClick={() => {
                          if (blurred) {
                            toggleReveal(openStackJob.id);
                            return;
                          }
                          setLightboxScope([openStackJob]);
                          setLightboxIdx(
                            flattenLightboxEntries([openStackJob]).findIndex(
                              (e) => e.index === i,
                            ),
                          );
                        }}
                      >
                        {mk === "audio" || mk === "model3d" ? (
                          <ThumbPlaceholder job={openStackJob} />
                        ) : mk === "video" ? (
                          <LazyVideo
                            src={imageUrl(url)}
                            poster={imageThumbUrl(url)}
                            hoverOnly
                            muted
                            loop
                            playsInline
                            style={blurred ? { filter: "blur(18px)" } : undefined}
                          />
                        ) : (
                          <img
                            src={imageUrl(url)}
                            alt={`第 ${i + 1} 张`}
                            loading="lazy"
                            decoding="async"
                            style={blurred ? { filter: "blur(18px)" } : undefined}
                          />
                        )}
                      </button>
                      <span className="lib-folder-badge" aria-hidden="true">
                        {i + 1}
                      </span>
                    </div>
                  </article>
                );
              })}
            </div>
          </>
        )}

        {!error && !loading && !openFolder && !openStackJob && !libraryEmpty && !resultEmpty && (
          <>
            {views.length > 0 && (
              <div className="lib-views" role="group" aria-label="已存视图">
                <Icon name="layers" size={12} aria-hidden="true" />
                {views.map((v) => (
                  <span key={v.id} className="lib-view-chip">
                    <button
                      type="button"
                      className="lib-view-chip-hit"
                      title="应用该视图的筛选组合"
                      onClick={() => applyView(v)}
                    >
                      {v.name}
                    </button>
                    <button
                      type="button"
                      className="lib-view-chip-x"
                      aria-label={`删除视图 ${v.name}`}
                      title="删除视图"
                      onClick={() => deleteView(v.id)}
                    >
                      <Icon name="close" size={10} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="lib-grid">
              {visibleEntries.map((entry, entryIdx) => {
              // 时间分组粘性标题(B3):槽变化处在网格里占满整行
              const timeHeader = timeHeaderAt.get(entryIdx);
              // 文件夹卡(内容分组):同批成员折叠为一卡,封面=首张产物缩略图,点击进入下钻
              if (entry.type === "batch") {
                const folder = entry.folder;
                const cover = folderCover(folder);
                const coverDone = cover.status === "done" && cover.results?.length > 0;
                return (
                  <Fragment key={`batch-${folder.batchId}`}>
                  {timeHeader && (
                    <div className="lib-time-header" role="separator" aria-label={timeHeader}>
                      {timeHeader}
                    </div>
                  )}
                  <article className="lib-card lib-folder-card">
                    <div className="lib-thumb">
                      <button
                        type="button"
                        className="lib-thumb-hit"
                        aria-label={`打开文件夹: ${folder.variant ? "变体组" : "360° 环绕序列"},共 ${folder.members.length} 张`}
                        onClick={() => setOpenBatchId(folder.batchId)}
                      >
                        {coverDone ? (
                          <ImageThumb job={cover} />
                        ) : (
                          <ThumbPlaceholder job={cover} />
                        )}
                      </button>
                      {/* 文件夹角标:右上角成员数(成员产物 URL 带 sig,封面直接复用) */}
                      <span className="lib-folder-badge" aria-hidden="true">
                        <Icon name="library" size={11} />
                        ×{folder.members.length}
                      </span>
                    </div>
                    <div className="lib-foot">
                      <div className="lib-card-title">{folder.variant ? "同参数变体" : "360° 环绕序列"}</div>
                      <div className="lib-meta">
                        <span className="lib-kind">{kindLabel(cover.kind)}</span>
                        <span className="lib-time">{formatTime(cover.created_at)}</span>
                      </div>
                    </div>
                  </article>
                  </Fragment>
                );
              }
              const job = entry.job;
              // 后端作业状态枚举为 queued/running/done/error;done 表示成功且有产物
              const hasResult = job.status === "done" && job.results?.length > 0;
              const isVideo = isVideoKind(job.kind);
              // 3D 产物(GLB/GLTF):网格不尝试 <img> 加载,图标占位 + 「3D」角标,预览进灯箱
              const is3d =
                hasResult && mediaKindOf(job.results[0], job.kind) === "model3d";
              // R18 作品(M9):18+ 徽标 + 缩略图默认模糊,点击单张解除/恢复
              const isNsfw = !!job.nsfw;
              const isBlurred = isNsfw && !revealedIds.has(job.id);
              const isSelected = selectedIds.has(job.id);
              // 多产物作业(叠放卡):点击进二级页看全组
              const isStack = hasResult && (job.results?.length ?? 0) > 1;
              // 2026-08-16 视图批 1:标题位优先语义首段,后端写入的元信息串降级为副标
              const cardText = splitCardTitle(job);
              return (
                <Fragment key={job.id}>
                {timeHeader && (
                  <div className="lib-time-header" role="separator" aria-label={timeHeader}>
                    {timeHeader}
                  </div>
                )}
                <article
                  className={`lib-card${isVideo ? " is-video" : ""}${deletingId === job.id ? " is-deleting" : ""}${isSelected ? " is-selected" : ""}${isStack ? " is-stack" : ""}`}
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
                            : `预览作品: ${job.prompt || "无提示词"}`
                      }
                      aria-pressed={batchMode ? isSelected : undefined}
                      onClick={(e) => {
                        if (batchMode) {
                          if (e.shiftKey) rangeSelectTo(job.id);
                          else toggleSelect(job.id);
                        }
                        else if (isBlurred) toggleReveal(job.id);
                        else if (isStack) setOpenStackJobId(job.id);
                        else openLightbox(job);
                      }}
                      onMouseEnter={() => {
                        if (isBlurred && !batchMode) setHoveredBlurId(job.id);
                      }}
                      onMouseLeave={() => {
                        setHoveredBlurId((id) => (id === job.id ? null : id));
                      }}
                    >
                    {/* P2:统一缩略入口(含破图/音频/3D 占位兜底;视频仍走 LazyVideo) */}
                    <JobThumbMedia job={job} blurred={isBlurred} />

                    {/* R18 模糊卡 hover 提示层:半透明「点击显示」,不拦截点击 */}
                    {isBlurred && !batchMode && hoveredBlurId === job.id && (
                      <div className="lib-blur-hint" aria-hidden="true">
                        点击显示
                      </div>
                    )}
                    </button>

                    {/* 3D 作业角标:缩略图是图标占位,角标标明可进灯箱交互预览 */}
                    {is3d && (
                      <span className="lib-3d-badge" aria-hidden="true">
                        <Icon name="box" size={11} />
                        3D
                      </span>
                    )}

                    {/* 多产物作业(2026-09-15):叠放卡角标,进灯箱可逐张翻看 */}
                    {hasResult && (job.results?.length ?? 0) > 1 && (
                      <span className="lib-stack-badge" aria-hidden="true">
                        <Icon name="library" size={11} />
                        {job.results.length} 张
                      </span>
                    )}

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
                          className={`lib-action-btn${favorites.has(job.id) ? " lib-action-btn--fav" : ""}`}
                          title={favorites.has(job.id) ? "取消收藏" : "收藏"}
                          aria-label={favorites.has(job.id) ? `取消收藏: ${job.prompt || "无提示词"}` : `收藏: ${job.prompt || "无提示词"}`}
                          aria-pressed={favorites.has(job.id)}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleFavorite(job.id);
                          }}
                        >
                          <Icon name="heart" size={14} />
                        </button>
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
                        {/* 用作参考(C1):作品直引为生成台媒体槽(图/视/音) */}
                        {hasResult && (
                          <button
                            type="button"
                            className="lib-action-btn"
                            title={
                              isVideo
                                ? "用作驱动/续写(生成台自动填入视频槽)"
                                : thumbFilterOf(job) === "audio"
                                  ? "用作音频(生成台自动填入音频槽)"
                                  : "用作参考图(生成台自动填入图槽)"
                            }
                            aria-label={`用作输入: ${job.prompt || "无提示词"}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleUseAsInput(job);
                            }}
                          >
                            <Icon name="send" size={14} />
                          </button>
                        )}
                        {/* 一键同款(C2):成功作品换 seed 重抽 */}
                        {job.status === "done" && canRerun(job) && (
                          <button
                            type="button"
                            className="lib-action-btn"
                            title="再做一张(同参数换 seed)"
                            aria-label={`再做一张: ${job.prompt || "无提示词"}`}
                            disabled={retrying.has(job.id)}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleMakeAnother(job);
                            }}
                          >
                            <Icon name="replay" size={14} />
                          </button>
                        )}
                        {/* 闭门同款:分享链接(成功且有提示词) */}
                        {job.status === "done" && (job.prompt ?? "").trim() && (
                          <button
                            type="button"
                            className="lib-action-btn"
                            title="复制同款链接(对方打开即导入参数)"
                            aria-label={`分享同款: ${job.prompt || "无提示词"}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleShareRemix(job);
                            }}
                          >
                            <Icon name="share" size={14} />
                          </button>
                        )}
                        {/* 移入画板(2026-09-21):聚合到手动主题板 */}
                        {job.status === "done" && (
                          <button
                            type="button"
                            className="lib-action-btn"
                            title="移入画板"
                            aria-label={`移入画板: ${job.prompt || "无提示词"}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              void openBoardPicker(job);
                            }}
                          >
                            <Icon name="layers" size={14} />
                          </button>
                        )}
                        {/* 一键重试(A1):失败且有快照时显示 */}
                        {job.status === "error" && canRerun(job) && (
                          <button
                            type="button"
                            className="lib-action-btn lib-action-btn--accent"
                            title="一键重试(原参数原 seed)"
                            aria-label={`一键重试: ${job.prompt || "无提示词"}`}
                            disabled={retrying.has(job.id)}
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleRetry(job);
                            }}
                          >
                            <Icon name="refresh" size={14} />
                          </button>
                        )}
                        {/* 视频超分到 4K:仅视频产物卡渲染(超分产物自身不再二次超分) */}
                        {isVideo && hasResult && job.kind !== "video_upscale" && (
                          <button
                            type="button"
                            className="lib-action-btn"
                            title="超分到 4K"
                            aria-label={`超分到 4K: ${job.prompt || "无提示词"}`}
                            disabled={upscalingId === job.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleUpscale(job);
                            }}
                          >
                            <Icon
                              name={upscalingId === job.id ? "loading" : "maximize"}
                              size={14}
                            />
                          </button>
                        )}
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

                    {/* 元信息角标(2026-09-20 A3):左下玻璃组——分辨率/时长(参数快照派生) */}
                    {job.meta && (job.meta.width || job.meta.duration_hint) && (
                      <span className="lib-meta-badges" aria-hidden="true">
                        {job.meta.width && job.meta.height && (
                          <span className="lib-meta-badge">
                            {job.meta.width}×{job.meta.height}
                          </span>
                        )}
                        {job.meta.duration_hint ? (
                          <span className="lib-meta-badge">
                            <Icon name="clock" size={10} />
                            {formatDurationHint(job.meta.duration_hint)}
                          </span>
                        ) : null}
                      </span>
                    )}

                    {/* 续写链徽标(2026-09-21):续写产物的源作品入口,点击跳父作灯箱 */}
                    {!!job.continued_from && isVideo && (
                      <button
                        type="button"
                        className="lib-continued-badge"
                        title="查看续写来源作品"
                        aria-label="查看续写来源作品"
                        onClick={(e) => {
                          e.stopPropagation();
                          const parent = (jobs ?? []).find((j) => j.id === job.continued_from);
                          if (parent) openLightbox(parent);
                          else toast.info("源作品不在当前列表(可能被删除或未加载)");
                        }}
                      >
                        <Icon name="history" size={10} />
                        续写于
                      </button>
                    )}

                    {/* 重试中遮罩(A1):conic 流光 + 脉冲 pill,原位反馈不跳转 */}
                    {retrying.has(job.id) && (
                      <div className="lib-retrying" role="status" aria-label="重试生成中">
                        <span className="lib-retrying-ring" aria-hidden="true" />
                        <span className="lib-retrying-pill">重试中</span>
                      </div>
                    )}

                    {/* 失败卡的内联重试(A1):白底主按钮比 hover 浮层更易发现;
                        canRerun=false(h3_i2v 等)时不显示,引导走「复用提示词」 */}
                    {job.status === "error" && canRerun(job) && !retrying.has(job.id) && (
                      <button
                        type="button"
                        className="lib-retry-inline"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleRetry(job);
                        }}
                      >
                        <Icon name="refresh" size={13} />
                        一键重试
                      </button>
                    )}

                    {/* R18 徽标:右下角可点,切换本卡模糊/揭示;缩略图点击揭示后进灯箱 */}
                    {isNsfw && (
                      <button
                        type="button"
                        className="lib-nsfw-badge"
                        aria-label={isBlurred ? "显示 R18 作品内容" : "恢复模糊"}
                        title={isBlurred ? "显示内容" : "恢复模糊"}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleReveal(job.id);
                        }}
                      >
                        18+
                      </button>
                    )}
                  </div>

                  <div className="lib-foot">
                    {/* 标题位:prompt 首段(2 行截断);元信息串已拆出,不再整串当标题 */}
                    <div className="lib-card-title" title={job.prompt}>
                      {cardText.title || "(无提示词)"}
                    </div>
                    {/* 副标:元信息(分辨率/帧数/时长)降级一行,label 档 muted */}
                    {cardText.meta && (
                      <div className="lib-card-sub" title={cardText.meta}>
                        {cardText.meta}
                      </div>
                    )}
                    {/* 来源 + 时间戳同一行 */}
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
                </Fragment>
              );
            })}
            </div>
            {/* 无限滚动哨兵:触底自动 advance(客户端扩渲染 → 服务端拉下页) */}
            {(hasMore || serverHasMore) && (
              <div ref={sentinelRef} className="lib-load-sentinel" aria-hidden="true" />
            )}
            {(hasMore || serverHasMore) && (
              <div className="lib-load-more">
                <Button
                  variant="secondary"
                  className="lib-load-more-btn"
                  loading={loadingMore}
                  onClick={advance}
                >
                  {hasMore
                    ? `加载更多(已显示 ${visibleEntries.length} / ${entries.length})`
                    : "加载更早的作品"}
                </Button>
              </div>
            )}
            {serverCounts && !loading && (
              <p className="lib-loaded-hint" role="status">
                {(() => {
                  const total = serverCounts[filter] ?? 0;
                  const loaded = filtered.length;
                  return total > loaded
                    ? `已显示 ${loaded} / 共 ${total} 件,下滑继续加载更早作品`
                    : `共 ${total} 件作品`;
                })()}
              </p>
            )}
          </>
        )}
      </div>

      {/* 批量模式:底部浮动操作条(已选计数 / 批量删除 / 取消);文件夹下钻内不显示 */}
      {batchMode && !openFolder && (
        <div className="lib-batchbar" role="region" aria-label="批量操作">
          <span className="lib-batchbar-count">已选 {selectedIds.size} 项</span>
          <span className="lib-batchbar-sep" aria-hidden="true" />
          <Button
            size="sm"
            variant="ghost"
            disabled={visibleEntries.length === 0 || batchDeleting}
            icon={<Icon name="grid" size={14} />}
            onClick={toggleSelectAllVisible}
            title="选中/取消当前已显示的全部作品"
          >
            全选本页
          </Button>
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

      {/* 沉浸查看器:Frame.io 式左舞台 + 右元信息面板;←/→ 穿梭 + 快捷操作;
          文件夹下钻内点开成员时穿梭范围限定为该组成员(lightboxScope)。
          portal 到 body:.view-stage 的 view-transition-name 会创建层叠上下文
          (自身层级 auto≈0),fixed 灯箱困于其中时被根层级的账户按钮(z-100)反压
          盖住右上角关闭钮(2026-08-27 实证);portal 逃脱后 z-modal(300) 在根级生效 */}
      {lightboxIdx !== null && lightboxEntries[lightboxIdx] && createPortal(
        <LibraryLightbox
          entries={lightboxEntries}
          index={lightboxIdx}
          onClose={closeLightbox}
          onIndex={setLightboxIdx}
          onSaveStyle={openStylePopover}
          onReuse={reusePromptAsDraft}
          onOpenApp={(j) => {
            if (j.app_id) {
              closeLightbox();
              onNavigate?.(`market?app=${j.app_id}`);
            }
          }}
          onDelete={handleDelete}
          deletingId={deletingId}
          onRetry={handleRetry}
          onUseAsInput={handleUseAsInput}
          onMakeAnother={handleMakeAnother}
          onOpenJobById={openJobById}
          onShareRemix={handleShareRemix}
          favorites={favorites}
          onToggleFav={(j) => toggleFavorite(j.id)}
          retryingId={
            lightboxIdx !== null && retrying.has(lightboxEntries[lightboxIdx]?.job.id ?? "")
              ? lightboxEntries[lightboxIdx].job.id
              : null
          }
          dialogsOpen={!!styleTarget || !!confirmDelete || !!confirmDeleteStyle || confirmBatchDelete || !!confirmUpscale}
        />,
        document.body,
      )}

      {/* 移入画板选择器(2026-09-21):作品 → 目标板(无板时引导新建) */}
      {boardPickerJob && (
        <>
          <button
            type="button"
            className="lib-source-scrim"
            aria-label="关闭画板选择器"
            onClick={() => setBoardPickerJob(null)}
          />
          <div className="lib-source-pop lib-board-picker" role="dialog" aria-label="移入画板">
            <div className="lib-source-group">移入画板:{boardPickerJob.prompt?.slice(0, 24) || "作品"}</div>
            {boardsForPicker === null ? (
              <div className="lib-board-picker-empty">加载中…</div>
            ) : boardsForPicker.length === 0 ? (
              <div className="lib-board-picker-empty">
                还没有画板——点工具条「画板」先新建一个
              </div>
            ) : (
              boardsForPicker.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  className="lib-source-item"
                  onClick={() => void addJobToBoard(b)}
                >
                  <span className="lib-source-item-label">{b.name}</span>
                  <span className="lib-chip-count">{b.item_count}</span>
                </button>
              ))
            )}
            <button
              type="button"
              className="lib-source-item lib-board-picker-new"
              onClick={() => {
                setBoardPickerJob(null);
                setShowBoards(true);
              }}
            >
              <Icon name="plus" size={12} />
              新建画板…
            </button>
          </div>
        </>
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
            确定删除这件作品?作品将移入回收站;<strong>72 小时内可恢复</strong>(删除提示中点「撤销」,或到回收站恢复)。
          </div>
          {confirmDelete?.prompt && (
            <div className="lib-confirm-prompt">
              {confirmDelete.prompt.length > 80
                ? confirmDelete.prompt.slice(0, 80) + "…"
                : confirmDelete.prompt}
            </div>
          )}
          <label className="lib-confirm-skip">
            <input
              type="checkbox"
              checked={skipConfirmChecked}
              onChange={(e) => setSkipConfirmChecked(e.target.checked)}
            />
            <span>不再确认(删除后仍可在回收站恢复)</span>
          </label>
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
            确定删除选中的 {selectedIds.size} 件作品?这些作品将移入回收站;
            <strong>72 小时内可逐件恢复</strong>(删除提示中点「全部撤销」,或到回收站恢复)。
          </div>
          {deleteError && (
            <div className="lib-confirm-error">
              <Icon name="error" size={13} /> {deleteError}
            </div>
          )}
        </div>
      </Modal>

      {/* 一键清理失败作品确认对话框:同一 Modal danger 基座;软删可从回收站恢复 */}
      <Modal
        open={confirmCleanupFailed}
        onClose={() => setConfirmCleanupFailed(false)}
        title="清理失败作品"
        danger
        preventClose={cleanupFailedBusy}
        footer={
          <>
            <Button
              variant="secondary"
              disabled={cleanupFailedBusy}
              onClick={() => setConfirmCleanupFailed(false)}
            >
              取消
            </Button>
            <Button
              variant="danger"
              loading={cleanupFailedBusy}
              icon={<Icon name="eraser" size={14} />}
              onClick={handleCleanupFailed}
            >
              {cleanupFailedBusy ? "清理中…" : `清理 ${failedCount} 件失败作品`}
            </Button>
          </>
        }
      >
        <div className="lib-confirm-body">
          <div className="lib-confirm-warn">
            将移除全部 <strong>{failedCount}</strong> 件生成失败的作品(各类任务通用,
            不限当前筛选)。作品移入回收站,<strong>72 小时内可恢复</strong>;确认后本页
            失败占位卡一并消失。
          </div>
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

      {/* 视频超分确认对话框(与删除同一 Modal 确认范式;说明耗时与产物去向) */}
      <Modal
        open={!!confirmUpscale}
        onClose={() => setConfirmUpscale(null)}
        title="超分到 4K"
        preventClose={upscalingId !== null}
        footer={
          <>
            <Button
              variant="secondary"
              disabled={upscalingId !== null}
              onClick={() => setConfirmUpscale(null)}
            >
              取消
            </Button>
            <Button
              variant="primary"
              loading={upscalingId !== null}
              icon={<Icon name="maximize" size={14} />}
              onClick={handleConfirmUpscale}
            >
              {upscalingId ? "提交中…" : "开始超分"}
            </Button>
          </>
        }
      >
        <div className="lib-confirm-body">
          <div className="lib-confirm-warn">
            将把该视频逐帧放大到 4K(横屏 3840×2160 / 竖屏 2160×3840,画幅方向自动识别)。
            耗时约 1-2 分钟/10 秒片,具体取决于片长与引擎占用;完成后新作品自动收录作品库,
            期间可继续其他操作。
          </div>
          {confirmUpscale?.prompt && (
            <div className="lib-confirm-prompt">
              {confirmUpscale.prompt.length > 80
                ? confirmUpscale.prompt.slice(0, 80) + "…"
                : confirmUpscale.prompt}
            </div>
          )}
          {upscaleError && (
            <div className="lib-confirm-error">
              <Icon name="error" size={13} /> {upscaleError}
            </div>
          )}
        </div>
      </Modal>

    </div>
  );
}


// ────────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────────
// ThreeDOpsBar:灯箱 3D 分支的材质/渲染操作条(2026-08-24;渲染语义纠偏同日)
// 主按钮「应用材质生成新模型」→ POST /api/3d/ops op=render out=glb(材质烘焙回
// 模型本身,产物新 GLB 作为 threed_render 作业进作品库 3D 桶);
// 快照 PNG / 旋转视频 MP4 为纯查看产物,折叠进「更多渲染方式」。
// wireframe/normal 是纯查看模式,不能烘焙成 GLB,主按钮禁用并提示。
// 样式走 <style jsx global> + t3dops- 前缀
// (P-2b:子组件元素拿不到主组件 styled-jsx 作用域类,必须 global)。
// ────────────────────────────────────────────────────────────────

const T3DOPS_PRESETS = [
  { value: "clay", label: "黏土" },
  { value: "matte", label: "哑光" },
  { value: "metal", label: "金属" },
  { value: "glossy", label: "陶瓷" },
  { value: "wireframe", label: "线框" },
  { value: "normal", label: "法线" },
] as const;

// 纯查看模式:不能烘焙为 GLB 材质(仅快照/视频可用)
const T3DOPS_VIEW_ONLY = new Set<string>(["wireframe", "normal"]);

function ThreeDOpsBar({ job }: { job: JobItem }) {
  const toast = useToast();
  const [preset, setPreset] = useState<string>("clay");
  const [busy, setBusy] = useState<"glb" | "png" | "mp4" | "texture" | null>(null);
  const [texPrompt, setTexPrompt] = useState<string>("");
  // 冷层唤醒遮罩:3D 纹理 503「冷层服务 hy3dtex 唤醒失败」时显示
  const [wakeService, setWakeService] = useState<string | null>(null);

  const run = async (out: "glb" | "png" | "mp4") => {
    if (busy) return;
    setBusy(out);
    try {
      await threeDOps({
        op: "render",
        job_id: job.id,
        material: preset as "clay",
        out,
        frames: 36,
      });
      invalidateJobs();
      toast.success(
        out === "glb"
          ? "新 3D 模型已生成,已收入作品库(3D 筛选)"
          : out === "mp4"
            ? "旋转视频已生成,已收入作品库"
            : "渲染快照已生成,已收入作品库",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "3D 渲染失败");
    } finally {
      setBusy(null);
    }
  };

  // AI 纹理贴图(Hunyuan3D 2.1):分钟级同步等待,产物新 GLB 进作品库 3D 桶
  const runTexture = async () => {
    if (busy) return;
    setBusy("texture");
    try {
      await threeDTexture({
        job_id: job.id,
        prompt: texPrompt.trim() || undefined,
      });
      invalidateJobs();
      toast.success("纹理贴图模型已生成,已收入作品库(3D 筛选)");
    } catch (e) {
      const svc = parseWakeError(e);
      if (svc) {
        setWakeService(svc);
      } else {
        toast.error(e instanceof Error ? e.message : "3D 纹理生成失败");
      }
    } finally {
      setBusy(null);
    }
  };

  const viewOnly = T3DOPS_VIEW_ONLY.has(preset);

  return (
    <div className="t3dops-bar">
      <span className="t3dops-label">3D 材质 / 渲染</span>
      <select
        className="t3dops-select"
        aria-label="材质预设"
        value={preset}
        disabled={busy !== null}
        onChange={(e) => setPreset(e.target.value)}
      >
        {T3DOPS_PRESETS.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>
      <div className="t3dops-actions">
        <button
          type="button"
          className="t3dops-btn t3dops-btn--primary"
          disabled={busy !== null || viewOnly}
          title={viewOnly ? "线框/法线是纯查看模式,请用下方快照/旋转视频" : "把材质烘焙回模型,产出新 GLB"}
          onClick={() => run("glb")}
        >
          <Icon name={busy === "glb" ? "loading" : "model3d"} size={13} />
          应用材质生成新模型
        </button>
      </div>
      <details className="t3dops-more">
        <summary>更多渲染方式(快照 / 旋转视频)</summary>
        <div className="t3dops-actions">
          <button
            type="button"
            className="t3dops-btn"
            disabled={busy !== null}
            onClick={() => run("png")}
          >
            <Icon name={busy === "png" ? "loading" : "image"} size={13} />
            渲染快照
          </button>
          <button
            type="button"
            className="t3dops-btn"
            disabled={busy !== null}
            onClick={() => run("mp4")}
          >
            <Icon name={busy === "mp4" ? "loading" : "film"} size={13} />
            渲染旋转视频
          </button>
        </div>
      </details>
      {/* AI 纹理贴图(Hunyuan3D 2.1,2026-08-25 P0):真 PBR 贴图烘焙,分钟级同步等待 */}
      <details className="t3dops-more">
        <summary>AI 纹理贴图(约几分钟)</summary>
        <div className="t3dops-texture">
          <input
            className="t3dops-input"
            type="text"
            placeholder="风格描述(可选),如:青铜锈蚀质感"
            aria-label="纹理风格描述"
            maxLength={200}
            value={texPrompt}
            disabled={busy !== null}
            onChange={(e) => setTexPrompt(e.target.value)}
          />
          <button
            type="button"
            className="t3dops-btn"
            disabled={busy !== null}
            title="Hunyuan3D 2.1 多视图扩散生成真 PBR 贴图并烘焙回模型,分钟级耗时"
            onClick={runTexture}
          >
            <Icon name={busy === "texture" ? "loading" : "palette"} size={13} />
            {busy === "texture" ? "纹理生成中(约几分钟)…" : "生成纹理贴图新模型"}
          </button>
        </div>
      </details>

      {/* 冷层唤醒遮罩:3D 纹理 503「冷层服务 hy3dtex 唤醒失败」时显示 */}
      {wakeService && (
        <ServiceWakeOverlay
          serviceName={wakeService}
          visible={!!wakeService}
          onCancel={() => setWakeService(null)}
          onClose={() => setWakeService(null)}
        />
      )}

      {/* global + t3dops- 前缀(P-2b):子组件样式不进主组件 styled-jsx 作用域;
          批 D:伪 token 回退值(白玻璃 hex/7px 野值)清零,全量走基座 token */}
      <style jsx global>{`
        .t3dops-bar {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
          padding: var(--space-3);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-panel);
          background: var(--bg-surface-1);
        }
        .t3dops-label {
          font-size: var(--text-label);
          font-weight: var(--font-medium);
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: var(--text-muted);
        }
        .t3dops-select {
          width: 100%;
          padding: var(--space-1) var(--space-2);
          font-size: var(--text-aux);
          color: var(--text-primary);
          background: var(--bg-surface-2);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
        }
        .t3dops-texture {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
          margin-top: var(--space-2);
        }
        .t3dops-input {
          width: 100%;
          padding: var(--space-1) var(--space-2);
          font-size: var(--text-aux);
          color: var(--text-primary);
          background: var(--bg-surface-2);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
        }
        .t3dops-input::placeholder {
          color: var(--text-muted);
        }
        .t3dops-actions {
          display: flex;
          gap: var(--space-2);
        }
        .t3dops-btn {
          flex: 1;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: var(--space-1);
          padding: var(--space-2);
          font-size: var(--text-aux);
          color: var(--text-primary);
          background: var(--bg-surface-2);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          cursor: pointer;
        }
        .t3dops-btn:hover:not(:disabled) {
          border-color: var(--accent);
          color: var(--accent);
        }
        .t3dops-btn:disabled {
          opacity: 0.6;
          cursor: wait;
        }
        .t3dops-btn--primary {
          border-color: var(--accent);
          color: var(--accent);
          font-weight: var(--font-medium);
        }
        .t3dops-more summary {
          cursor: pointer;
          font-size: var(--text-label);
          color: var(--text-muted);
          user-select: none;
        }
        .t3dops-more[open] summary {
          margin-bottom: var(--space-2);
        }
      `}</style>
    </div>
  );
}


// LibraryLightbox:作品沉浸查看器(Frame.io 式重设计,2026-08-15)
// 左侧大预览舞台(深色恒压暗,作品是主角)+ 右侧固定宽元信息面板
// (类型/状态/时间/kind/seed/提示词全文/操作组);←/→ 键盘与按钮穿梭;
// 操作复用 LibraryView 现有逻辑:下载(anchor download)、存为风格(锚点 Popover)、
// 复用提示词(引擎草稿 + 跳工作台)、删除(既有确认 Modal)。
// ────────────────────────────────────────────────────────────────

interface LibraryLightboxProps {
  /** 展平后的浏览条目(单作业多产物逐条展开,2026-09-15):穿梭/计数都按条目 */
  entries: LightboxEntry[];
  index: number;
  onClose: () => void;
  onIndex: (idx: number) => void;
  /** 存为风格:复用 LibraryView.openStylePopover(锚定到灯箱面板按钮) */
  onSaveStyle?: (job: JobItem, anchor: HTMLButtonElement) => void;
  /** 复用提示词:复用 LibraryView.reusePromptAsDraft(写草稿 + 跳工作台) */
  onReuse?: (job: JobItem) => void;
  /** 打开来源应用(2026-09-15 作品库×应用搭配):job.app_id 存在时出现「打开应用」 */
  onOpenApp?: (job: JobItem) => void;
  /** 删除:复用 LibraryView.handleDelete(打开既有确认 Modal) */
  onDelete?: (job: JobItem) => void;
  deletingId?: string | null;
  /** 一键重试(2026-09-20 A1):失败且有快照时显示;retryingId 时转圈禁用 */
  onRetry?: (job: JobItem) => void;
  retryingId?: string | null;
  /** 收藏(P1 A5):favorites 为当前收藏集;onToggleFav 切换 */
  favorites?: ReadonlySet<string>;
  onToggleFav?: (job: JobItem) => void;
  /** 资产即输入(P3 C1):作品直引为生成台媒体槽 */
  onUseAsInput?: (job: JobItem) => void;
  /** 一键同款(P3 C2):同参数换 seed 重抽 */
  onMakeAnother?: (job: JobItem) => void;
  /** 续写链(2026-09-21):按 id 打开源作品(不在灯箱条目内时父级兜底盘内查找) */
  onOpenJobById?: (jobId: string) => void;
  /** 闭门同款(2026-09-21):复制同款分享链接 */
  onShareRemix?: (job: JobItem) => void;
  /** 存风格 Popover / 删除 Modal 打开时,灯箱让出 Esc/方向键(避免一按两关) */
  dialogsOpen: boolean;
  /** 回收站预览:只看不改,隐藏复用/存风格/删除/3D 操作,避免误恢复或加厚删除 */
  previewOnly?: boolean;
}

function LibraryLightbox({
  entries,
  index,
  onClose,
  onIndex,
  onSaveStyle,
  onReuse,
  onOpenApp,
  onDelete,
  deletingId = null,
  onRetry,
  retryingId = null,
  favorites,
  onToggleFav,
  onUseAsInput,
  onMakeAnother,
  onOpenJobById,
  onShareRemix,
  dialogsOpen,
  previewOnly = false,
}: LibraryLightboxProps) {
  const entry = entries[index];
  const job = entry?.job;
  // 越界钳制 effect 在父层兜底;此处仅防御渲染(条目清空瞬间)
  if (!entry || !job) return null;
  const hasResult = !entry.placeholder;
  const mediaUrl = hasResult ? imageUrl(entry.url) : "";
  // 统一格式识别(扩展名优先、kind 兜底):glb 不再落进 <img> 裂图;
  // kind 非音频类但产物是 .mp3/.wav 的作业也能进音频分支
  const mediaKind = hasResult ? mediaKindOf(mediaUrl, job.kind) : null;
  // P2:灯箱图/视频坏链降级类型占位,避免舞台露出破图图标
  const [mediaFailed, setMediaFailed] = useState(false);
  useEffect(() => {
    setMediaFailed(false);
  }, [mediaUrl]);

  // PNG 内嵌 ComfyUI workflow 反显(B4):点开图作品时探测 tEXt/zTXt 关键字,缓存于组件态
  const [pngWorkflow, setPngWorkflow] = useState<boolean | null>(null);
  useEffect(() => {
    setPngWorkflow(null);
    if (!hasResult || mediaKind !== "image" || !mediaUrl) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(mediaUrl);
        if (!res.ok || cancelled) return;
        const buf = new Uint8Array(await res.arrayBuffer());
        if (!cancelled) setPngWorkflow(pngHasWorkflow(buf));
      } catch {
        /* 探测失败=不显示徽标 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mediaUrl, hasResult, mediaKind]);

  // 打开期间锁定 body 滚动(与 ui/Modal 同一模式;overscroll-behavior 在 CSS 侧拦截滚轮链)
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // 键盘:Esc 关闭,←/→ 穿梭,D 下载,R 重试(A4 2026-09-20);
  // 存风格/删除对话框打开时让出按键;输入焦点在表单时也不劫持。
  useEffect(() => {
    if (dialogsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      else if (e.key === "ArrowRight" && index < entries.length - 1) onIndex(index + 1);
      else if ((e.key === "d" || e.key === "D") && hasResult) {
        const a = document.createElement("a");
        a.href = mediaUrl;
        a.download = "";
        a.click();
      } else if ((e.key === "r" || e.key === "R") && onRetry && canRerun(job) && retryingId !== job.id) {
        onRetry(job);
      } else if ((e.key === "f" || e.key === "F") && onToggleFav) {
        onToggleFav(job);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialogsOpen, index, entries.length, onClose, onIndex, hasResult, mediaUrl, onRetry, retryingId, onToggleFav, job]);

  const copyMetaBlock = async () => {
    try {
      await navigator.clipboard.writeText(buildMetaBlock(job));
      setMetaCopied(true);
      setTimeout(() => setMetaCopied(false), 1600);
    } catch {
      /* 剪贴板不可用时静默(不打扰浏览) */
    }
  };
  const [metaCopied, setMetaCopied] = useState(false);

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
          {hasResult && !mediaFailed ? (
            mediaKind === "model3d" ? (
              <ModelViewer src={mediaUrl} className="lib-lb-model3d" />
            ) : mediaKind === "video" ? (
              <video
                key={mediaUrl}
                className="lib-lb-media"
                src={mediaUrl}
                controls
                autoPlay
                loop
                onError={() => setMediaFailed(true)}
              />
            ) : mediaKind === "audio" ? (
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
                onError={() => setMediaFailed(true)}
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
          {index < entries.length - 1 && (
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

          {/* 组内胶片条(2026-09-15):多产物作业在舞台底部平铺全组小图,点选直达;
              仅图片条目入条(视频/音频组走顺序翻页) */}
          {entry.count > 1 && (
            <div className="lib-lb-filmstrip" role="tablist" aria-label="本组图片">
              {entries.map((e, i) =>
                e.job.id === job.id && !e.placeholder && mediaKindOf(e.url, e.job.kind) === "image" ? (
                  <button
                    key={`${e.job.id}-${e.index}`}
                    type="button"
                    role="tab"
                    aria-selected={i === index}
                    aria-label={`第 ${e.index + 1} 张`}
                    className={`lib-lb-film${i === index ? " is-on" : ""}`}
                    onClick={() => onIndex(i)}
                  >
                    <img src={imageUrl(e.url)} alt="" loading="lazy" decoding="async" />
                  </button>
                ) : null,
              )}
            </div>
          )}
        </div>

        {/* 右侧:固定宽元信息面板(类型 / 状态 / 时间 / kind / seed / 提示词全文 / 操作组) */}
        <aside className="lib-lb-side">
          <div className="lib-lb-side-head">
            <span className="lib-kind">{kindLabel(job.kind)}</span>
            <span className="lib-lb-counter">
              {index + 1} / {entries.length}
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
              <dd className="lib-lb-kind-value" title={job.kind}>{kindLabel(job.kind)}</dd>
            </div>
            <div className="lib-lb-meta-row">
              <dt>时间</dt>
              <dd>
                {createdFull}
                <span className="lib-lb-time-rel">({formatTime(job.created_at)})</span>
              </dd>
            </div>
            {pngWorkflow === true && (
              <div className="lib-lb-meta-row">
                <dt>工作流</dt>
                <dd>
                  <span className="lib-lb-wf-chip">已内嵌 ComfyUI 工作流</span>
                </dd>
              </div>
            )}
            {!!job.continued_from && (
              <div className="lib-lb-meta-row">
                <dt>续写于</dt>
                <dd>
                  <button
                    type="button"
                    className="lib-lb-src-link"
                    onClick={() => {
                      const parent = entries.map((en) => en.job).find((j) => j.id === job.continued_from)
                        ?? null;
                      if (parent) {
                        const idx = entries.findIndex((en) => en.job.id === parent.id);
                        if (idx >= 0) onIndex(idx);
                      } else if (job.continued_from) {
                        onOpenJobById?.(job.continued_from);
                      }
                    }}
                  >
                    源作品
                  </button>
                </dd>
              </div>
            )}
            <div className="lib-lb-meta-row">
              <dt>Seed</dt>
              <dd className="lib-lb-num">{job.seed}</dd>
            </div>
            {entry.count > 1 && (
              <div className="lib-lb-meta-row">
                <dt>本组</dt>
                <dd className="lib-lb-num">
                  第 {entry.index + 1} / {entry.count} 张
                </dd>
              </div>
            )}
          </dl>

          <div className="lib-lb-prompt-block">
            <span className="lib-lb-prompt-label">提示词</span>
            <p className="lib-lb-prompt-text">{job.prompt || "(无提示词)"}</p>
          </div>

          {/* 3D 产物:材质烘焙成新模型(默认)+ 快照/旋转视频(折叠,产物作为新作业进作品库) */}
          {!previewOnly && mediaKind === "model3d" && <ThreeDOpsBar job={job} />}

          <div className="lib-lb-side-actions">
            {!previewOnly && onOpenApp && job.app_id && (
              <button
                type="button"
                className="lib-lb-action"
                onClick={() => onOpenApp(job)}
                title="在应用市场中打开来源应用"
              >
                <Icon name="store" size={14} />
                打开应用
              </button>
            )}
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
            {!previewOnly && onUseAsInput && hasResult && (
            <button
              type="button"
              className="lib-lb-action"
              onClick={() => onUseAsInput(job)}
              title="作品直引为生成台媒体槽(免二次上传)"
            >
              <Icon name="send" size={14} />
              用作参考
            </button>
            )}
            {!previewOnly && onMakeAnother && job.status === "done" && canRerun(job) && (
            <button
              type="button"
              className="lib-lb-action"
              onClick={() => onMakeAnother(job)}
              title="同参数换 seed 重抽一张"
            >
              <Icon name="replay" size={14} />
              再做一张
            </button>
            )}
            {!previewOnly && (job.prompt ?? "").trim() && (
            <button
              type="button"
              className="lib-lb-action"
              onClick={() => onShareRemix?.(job)}
              title="复制同款链接(对方打开即导入参数)"
            >
              <Icon name="share" size={14} />
              分享同款
            </button>
            )}
            {!previewOnly && onToggleFav && (
            <button
              type="button"
              className={`lib-lb-action${favorites?.has(job.id) ? " lib-lb-action--fav" : ""}`}
              onClick={() => onToggleFav(job)}
              title="收藏 / 取消收藏(F)"
            >
              <Icon name="heart" size={14} />
              {favorites?.has(job.id) ? "已收藏" : "收藏"}
            </button>
            )}
            {hasResult && (
            <button
              type="button"
              className="lib-lb-action"
              onClick={() => void copyMetaBlock()}
              title="复制参数块(站外重建上下文)"
            >
              <Icon name="filecode" size={14} />
              {metaCopied ? "已复制" : "复制参数"}
            </button>
            )}
            {!previewOnly && onRetry && canRerun(job) && (
            <button
              type="button"
              className="lib-lb-action lib-lb-action--accent"
              disabled={retryingId === job.id}
              onClick={() => onRetry(job)}
            >
              <Icon name={retryingId === job.id ? "loading" : "refresh"} size={14} />
              一键重试
            </button>
            )}
            {!previewOnly && onReuse && (
            <button
              type="button"
              className="lib-lb-action"
              onClick={() => onReuse(job)}
            >
              <Icon name="link" size={14} />
              复用提示词
            </button>
            )}
            {!previewOnly && onSaveStyle && (
            <button
              type="button"
              className="lib-lb-action"
              onClick={(e) => onSaveStyle(job, e.currentTarget)}
            >
              <Icon name="palette" size={14} />
              存为风格
            </button>
            )}
            {!previewOnly && onDelete && (
            <button
              type="button"
              className="lib-lb-action lib-lb-action--danger"
              disabled={deletingId === job.id}
              onClick={() => onDelete(job)}
            >
              <Icon name={deletingId === job.id ? "loading" : "delete"} size={14} />
              删除作品
            </button>
            )}
          </div>

          {/* 快捷键提示(A4):底部 kbd 行,半透明不抢焦点 */}
          <div className="lib-lb-kbd-hints" aria-hidden="true">
            <span><kbd>←</kbd><kbd>→</kbd> 切换</span>
            <span><kbd>Esc</kbd> 关闭</span>
            {hasResult && <span><kbd>D</kbd> 下载</span>}
            {!previewOnly && onRetry && canRerun(job) && <span><kbd>R</kbd> 重试</span>}
            {!previewOnly && onToggleFav && <span><kbd>F</kbd> 收藏</span>}
          </div>
        </aside>
      </div>
    </div>
  );
}


// ────────────────────────────────────────────────────────────────
// LibraryTrashView:回收站(2026-08-23)
// 软删作品 72h 保留期内的浏览/恢复/彻底删除;网格复用作品卡片样式,
// 卡片脚部显示删除时间与剩余保留期;彻底删除走 Modal 二次确认(物理删除不可恢复)。
// ────────────────────────────────────────────────────────────────

interface LibraryTrashViewProps {
  onBack: () => void;
  /** 恢复成功后回调(失效作品库缓存 + 刷新主列表) */
  onRestored?: () => void;
}

export function LibraryTrashView({ onBack, onRestored }: LibraryTrashViewProps) {
  const toast = useToast();
  const [items, setItems] = useState<TrashJobItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 恢复/彻底删除进行中的条目 id(按钮 busy + 防重复提交,与主列表 deletingId 同范式)
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmPurge, setConfirmPurge] = useState<TrashJobItem | null>(null);
  const [purgeError, setPurgeError] = useState<string | null>(null);
  // 一键清空:独立确认态与进行中态(复用 busyId 语义,"__all__" 表示整桶操作)
  const [confirmPurgeAll, setConfirmPurgeAll] = useState(false);
  const [revealedIds, setRevealedIds] = useState<ReadonlySet<string>>(new Set());
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

  const toggleReveal = (id: string) => {
    setRevealedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const trashJobs = items ?? [];
  const trashEntries = useMemo(
    () => flattenLightboxEntries(trashJobs),
    [trashJobs],
  );
  const openLightbox = (job: JobItem) => {
    const idx = trashEntries.findIndex((e) => e.job.id === job.id);
    if (idx >= 0) setLightboxIdx(idx);
  };

  useEffect(() => {
    if (lightboxIdx === null) return;
    if (trashEntries.length === 0) setLightboxIdx(null);
    else if (lightboxIdx >= trashEntries.length) setLightboxIdx(trashEntries.length - 1);
  }, [trashEntries.length, lightboxIdx]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchTrash()
      .then(setItems)
      .catch((err) => setError(err instanceof Error ? err.message : "加载回收站失败"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 恢复:移出回收站条目 + 失效作品库缓存(作品回归主列表)
  const handleRestore = async (item: TrashJobItem) => {
    setBusyId(item.id);
    try {
      await restoreJob(item.id);
      setItems((prev) => (prev ?? []).filter((j) => j.id !== item.id));
      toast.success("已恢复到作品库");
      onRestored?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "恢复失败(可能已过保留期)");
    } finally {
      setBusyId(null);
    }
  };

  // 彻底删除:Modal 二次确认后物理删除,失败内联报错在对话框中
  const handleConfirmPurge = async () => {
    if (!confirmPurge) return;
    setBusyId(confirmPurge.id);
    setPurgeError(null);
    try {
      await permanentDeleteJob(confirmPurge.id);
      setItems((prev) => (prev ?? []).filter((j) => j.id !== confirmPurge.id));
      setConfirmPurge(null);
      toast.info("已彻底删除");
    } catch (err) {
      setPurgeError(err instanceof Error ? err.message : "彻底删除失败");
    } finally {
      setBusyId(null);
    }
  };

  // 一键清空:Modal 二次确认后整桶物理删除,成功后本地清空并提示件数
  const handleConfirmPurgeAll = async () => {
    setBusyId("__all__");
    setPurgeError(null);
    try {
      const purged = await purgeTrash();
      setItems([]);
      setConfirmPurgeAll(false);
      toast.info(`已彻底删除 ${purged} 件作品`);
    } catch (err) {
      setPurgeError(err instanceof Error ? err.message : "清空回收站失败");
    } finally {
      setBusyId(null);
    }
  };

  const trashEmpty = !loading && !error && (items?.length ?? 0) === 0;
  const skeletonCount = 8;

  return (
    <div className="single-view library-view is-trash">
      {/* 回收站细顶条(2026-09-02 W3 PageHeader 退役):返回 + 标题 + 说明 + 清空;
          操作槽类名 lib-trash-* 保留(e2e 锚点);is-trash 根类(2026-09-04 W2B):条目灰化降级 */}
      <header className="lib-trash-head">
        <Button
          size="sm"
          variant="ghost"
          className="lib-trash-back"
          icon={<Icon name="chevron-left" size={14} />}
          onClick={onBack}
        >
          返回作品库
        </Button>
        <span className="lib-trash-title">回收站</span>
        <span className="lib-trash-desc">删除的作品保留 72 小时,到期自动彻底删除</span>
        {(items?.length ?? 0) > 0 && (
          <Button
            size="sm"
            variant="danger"
            className="lib-trash-purge-all"
            icon={<Icon name="delete" size={14} />}
            onClick={() => {
              setPurgeError(null);
              setConfirmPurgeAll(true);
            }}
          >
            清空回收站
          </Button>
        )}
      </header>

      <div className="lib-body">
        {error && !loading && (
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

        {!error && !loading && trashEmpty && (
          /* 回收站空态(2026-09-02 W3):单行 muted 提示,72h 说明已在细顶条 */
          <div className="lib-empty">
            <span className="lib-empty-hint">回收站是空的</span>
          </div>
        )}

        {!error && !loading && !trashEmpty && (
          <div className="lib-grid">
            {(items ?? []).map((job) => {
              const hasResult = job.status === "done" && job.results?.length > 0;
              const isVideo = isVideoKind(job.kind);
              const is3d =
                hasResult && mediaKindOf(job.results[0], job.kind) === "model3d";
              const isNsfw = !!job.nsfw;
              const isBlurred = isNsfw && !revealedIds.has(job.id);
              const cardText = splitCardTitle(job);
              return (
                <article key={job.id} className={`lib-card${isVideo ? " is-video" : ""}`}>
                  <div className="lib-thumb">
                    <button
                      type="button"
                      className="lib-thumb-hit"
                      aria-label={
                        isBlurred
                          ? "点击显示 R18 作品内容"
                          : `预览作品: ${job.prompt || "无提示词"}`
                      }
                      onClick={() => {
                        if (isBlurred) toggleReveal(job.id);
                        else openLightbox(job);
                      }}
                    >
                    <JobThumbMedia job={job} blurred={isBlurred} />
                    </button>
                    {is3d && (
                      <span className="lib-3d-badge" aria-hidden="true">
                        <Icon name="box" size={11} />
                        3D
                      </span>
                    )}
                    {isNsfw && (
                      <button
                        type="button"
                        className="lib-nsfw-badge"
                        aria-label={isBlurred ? "显示 R18 作品内容" : "恢复模糊"}
                        title={isBlurred ? "显示内容" : "恢复模糊"}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleReveal(job.id);
                        }}
                      >
                        18+
                      </button>
                    )}
                    {isVideo && hasResult && (
                      <div className="lib-video-badge" aria-hidden="true">
                        <Icon name="playing" size={11} />
                        视频
                      </div>
                    )}
                  </div>

                  <div className="lib-foot">
                    <div className="lib-card-title" title={job.prompt}>
                      {cardText.title || "(无提示词)"}
                    </div>
                    {/* 删除时间 + 剩余保留期(到期后端清理任务物理删除) */}
                    <div className="lib-meta">
                      <span className="lib-kind" title={kindLabel(job.kind)}>
                        {kindLabel(job.kind)}
                      </span>
                      <span className="lib-time">删除于 {formatTime(job.deleted_at)}</span>
                    </div>
                    <div className="lib-trash-retention">
                      {formatRetention(job.restore_remaining_seconds)}后彻底删除
                    </div>
                    <div className="lib-trash-actions">
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busyId === job.id}
                        loading={busyId === job.id}
                        icon={<Icon name="undo" size={14} />}
                        onClick={() => handleRestore(job)}
                      >
                        恢复
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={busyId === job.id}
                        icon={<Icon name="delete" size={14} />}
                        onClick={() => {
                          setPurgeError(null);
                          setConfirmPurge(job);
                        }}
                      >
                        彻底删除
                      </Button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      {lightboxIdx !== null && trashEntries[lightboxIdx] && createPortal(
        <LibraryLightbox
          entries={trashEntries}
          index={lightboxIdx}
          onClose={() => setLightboxIdx(null)}
          onIndex={setLightboxIdx}
          dialogsOpen={!!confirmPurge || confirmPurgeAll}
          previewOnly
        />,
        document.body,
      )}

      {/* 彻底删除确认对话框(与删除作品同一 Modal danger 基座;后果文案明示不可恢复) */}
      <Modal
        open={!!confirmPurge}
        onClose={() => setConfirmPurge(null)}
        title="彻底删除作品"
        danger
        preventClose={busyId !== null}
        footer={
          <>
            <Button
              variant="secondary"
              disabled={busyId !== null}
              onClick={() => setConfirmPurge(null)}
            >
              取消
            </Button>
            <Button
              variant="danger"
              loading={busyId !== null}
              icon={<Icon name="delete" size={14} />}
              onClick={handleConfirmPurge}
            >
              {busyId ? "删除中…" : "彻底删除"}
            </Button>
          </>
        }
      >
        <div className="lib-confirm-body">
          <div className="lib-confirm-warn">
            确定彻底删除这件作品?<strong>此操作不可恢复</strong>,作品数据将被永久移除。
          </div>
          {confirmPurge?.prompt && (
            <div className="lib-confirm-prompt">
              {confirmPurge.prompt.length > 80
                ? confirmPurge.prompt.slice(0, 80) + "…"
                : confirmPurge.prompt}
            </div>
          )}
          {purgeError && (
            <div className="lib-confirm-error">
              <Icon name="error" size={13} /> {purgeError}
            </div>
          )}
        </div>
      </Modal>

      {/* 一键清空确认对话框(整桶物理删除,不可恢复;件数在文案里明示) */}
      <Modal
        open={confirmPurgeAll}
        onClose={() => setConfirmPurgeAll(false)}
        title="清空回收站"
        danger
        preventClose={busyId !== null}
        footer={
          <>
            <Button
              variant="secondary"
              disabled={busyId !== null}
              onClick={() => setConfirmPurgeAll(false)}
            >
              取消
            </Button>
            <Button
              variant="danger"
              loading={busyId !== null}
              icon={<Icon name="delete" size={14} />}
              onClick={handleConfirmPurgeAll}
            >
              {busyId ? "删除中…" : "全部彻底删除"}
            </Button>
          </>
        }
      >
        <div className="lib-confirm-body">
          <div className="lib-confirm-warn">
            确定清空回收站?{items?.length ?? 0} 件作品将被全部彻底删除,
            <strong>此操作不可恢复</strong>。
          </div>
          {purgeError && (
            <div className="lib-confirm-error">
              <Icon name="error" size={13} /> {purgeError}
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
