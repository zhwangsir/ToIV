"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { deleteJob, fetchJobsPage, fetchTrash, getVideoUpscaleStatus, imageUrl, invalidateJobs, JOBS_PAGE_LIMIT, listJobs, permanentDeleteJob, purgeTrash, restoreJob, undoDelete, upscaleVideo } from "@/lib/api";
import { ENGINE_DRAFT_KEY } from "@/lib/engine";
import { begin as genBegin, end as genEnd, progress as genProgress } from "@/lib/generationBus";
import { useR18Mode } from "@/lib/r18";
import {
  applyLibraryQuery,
  countByFilter,
  deleteJobsBatch,
  FILTERS,
  folderCover,
  formatRetention,
  formatTime,
  groupLibraryEntries,
  isVideoKind,
  kindLabel,
  kindToFilter,
  loadDensity,
  persistDensity,
  splitCardTitle,
  statusLabel,
  type BatchFolder,
  type ContentFilterKey,
  type FilterKey,
  type LibraryDensity,
  type SortKey,
} from "@/lib/libraryQuery";
import type { JobItem, TrashJobItem } from "@/lib/types";
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
  // 服务端分页(2026-08-16):首页走 swr 缓存(≤200 条),触底自动拉下一页追加;
  // serverHasMore = 最后拉取的一页返回满页(==JOBS_PAGE_LIMIT)即可能还有
  const [serverHasMore, setServerHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // 工具条(2026-08-15 重设计):prompt 搜索 / 时间排序 / 网格密度(持久化)
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");
  const [density, setDensity] = useState<LibraryDensity>(() => loadDensity());
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
  // 风格卡(WS4):StyleBar 数据源 + 「存为风格」Popover 状态
  const [styleCards, setStyleCards] = useState<StyleCard[]>([]);
  const [styleTarget, setStyleTarget] = useState<JobItem | null>(null);
  const [styleName, setStyleName] = useState("");
  const styleAnchorRef = useRef<HTMLButtonElement | null>(null);
  // 回收站(2026-08-23):组件内条件渲染切换,不动路由
  const [showTrash, setShowTrash] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    listJobs()
      .then((page1) => {
        setJobs(page1);
        // 首页满页 → 服务端可能还有更早的作品(老作品不再被 50 条截断)
        setServerHasMore(page1.length >= JOBS_PAGE_LIMIT);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "加载作品失败"))
      .finally(() => setLoading(false));
  }, []);

  // 服务端下一页:offset=已加载条数;按 id 去重(首页缓存 stale 期间新作业插入顶部
  // 会导致页间位置漂移重叠,去重兜底)
  const loadMoreServer = useCallback(() => {
    if (loadingMore || !serverHasMore) return;
    setLoadingMore(true);
    fetchJobsPage(jobs?.length ?? 0)
      .then((page) => {
        setServerHasMore(page.length >= JOBS_PAGE_LIMIT);
        if (page.length > 0) {
          setJobs((prev) => {
            const seen = new Set((prev ?? []).map((j) => j.id));
            return [...(prev ?? []), ...page.filter((j) => !seen.has(j.id))];
          });
        }
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : "加载更多失败"))
      .finally(() => setLoadingMore(false));
  }, [jobs?.length, loadingMore, serverHasMore, toast]);

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

  // 内容分组(2026-08-24):带 batch_id 的作业(360° 环绕序列)折叠为文件夹卡,
  // 主网格不再平铺成员;筛选已先作用于成员 → 文件夹按成员 kind 归属对应类型桶
  const entries = useMemo(() => groupLibraryEntries(filtered), [filtered]);

  // 当前打开的文件夹(下钻);成员删到 <2 时文件夹自然消失 → 自动退回主网格
  const openFolder: BatchFolder | null = useMemo(() => {
    if (!openBatchId) return null;
    const hit = entries.find((e) => e.type === "batch" && e.folder.batchId === openBatchId);
    return hit && hit.type === "batch" ? hit.folder : null;
  }, [entries, openBatchId]);

  useEffect(() => {
    if (openBatchId && !openFolder) setOpenBatchId(null);
  }, [openBatchId, openFolder]);

  // 灯箱穿梭列表:文件夹下钻内点开成员时限定在组内,否则为整个查询结果
  const lightboxJobs = lightboxScope ?? filtered;

  // 灯箱索引越界钳制:删除当前作品后列表收缩,滑到下一件;列表清空则关闭
  useEffect(() => {
    if (lightboxIdx === null) return;
    if (lightboxJobs.length === 0) setLightboxIdx(null);
    else if (lightboxIdx >= lightboxJobs.length) setLightboxIdx(lightboxJobs.length - 1);
  }, [lightboxJobs.length, lightboxIdx]);

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
    () => entries.slice(0, visibleCount),
    [entries, visibleCount],
  );
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
    const idx = list.findIndex((j) => j.id === job.id);
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

  // 回收站视图(组件内条件渲染,不动路由;恢复后失效缓存并刷新主列表)
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

      {/* 工具条(sticky):搜索 / 类型 chips / 内容分级 / 排序 / 密度 / 批量管理;
          文件夹下钻视图隐藏(返回主网格即恢复) */}
      {!openFolder && (
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
        </div>
      </div>
      )}

      {/* 风格库横条(WS4):空态 StyleBar 内部返回 null,不渲染整条 */}
      {!openFolder && (
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
          <div className="lib-empty lib-empty--result">
            <div className="lib-empty-icon" aria-hidden="true">
              <Icon name="search" size={26} strokeWidth={1.2} />
            </div>
            <h2 className="lib-empty-display">没有匹配的作品</h2>
            <p className="lib-empty-desc">
              当前筛选 / 搜索条件下没有结果,试试调整关键词或清空全部条件。
            </p>
            {/* 搜索范围明示:客户端过滤只覆盖已加载分页,避免「搜不到=不存在」的误导 */}
            {search.trim() && (jobs?.length ?? 0) > 0 && (
              <p className="lib-empty-scope">
                注:搜索仅覆盖已加载的 {jobs?.length ?? 0} 件作品,更早的作品需向下滚动加载后可搜。
              </p>
            )}
            <Button
              size="sm"
              icon={<Icon name="close" size={14} />}
              onClick={clearQuery}
            >
              清空筛选与搜索
            </Button>
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
                环绕序列 {openFolder.batchId.slice(0, 8)}
              </span>
              <span className="lib-breadcrumb-count">{openFolder.members.length} 张</span>
            </nav>
            <div className="lib-grid">
              {openFolder.members.map((job) => {
                const hasResult = job.status === "done" && job.results?.length > 0;
                const isVideo = isVideoKind(job.kind);
                const cardText = splitCardTitle(job);
                return (
                  <article
                    key={job.id}
                    className={`lib-card${deletingId === job.id ? " is-deleting" : ""}`}
                  >
                    <div className="lib-thumb">
                      <button
                        type="button"
                        className="lib-thumb-hit"
                        aria-label={`预览作品: ${job.prompt || "无提示词"}`}
                        onClick={() => openLightbox(job, openFolder.members)}
                      >
                        {hasResult ? (
                          isVideo ? (
                            <LazyVideo src={imageUrl(job.results[0])} muted loop playsInline />
                          ) : (
                            <ImageThumb job={job} />
                          )
                        ) : (
                          <ThumbPlaceholder job={job} />
                        )}
                      </button>
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

        {!error && !loading && !openFolder && !libraryEmpty && !resultEmpty && (
          <>
            <div className="lib-grid">
              {visibleEntries.map((entry) => {
              // 文件夹卡(内容分组):同批成员折叠为一卡,封面=首张产物缩略图,点击进入下钻
              if (entry.type === "batch") {
                const folder = entry.folder;
                const cover = folderCover(folder);
                const coverDone = cover.status === "done" && cover.results?.length > 0;
                return (
                  <article key={`batch-${folder.batchId}`} className="lib-card lib-folder-card">
                    <div className="lib-thumb">
                      <button
                        type="button"
                        className="lib-thumb-hit"
                        aria-label={`打开文件夹: 360° 环绕序列,共 ${folder.members.length} 张`}
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
                      <div className="lib-card-title">360° 环绕序列</div>
                      <div className="lib-meta">
                        <span className="lib-kind">{kindLabel(cover.kind)}</span>
                        <span className="lib-time">{formatTime(cover.created_at)}</span>
                      </div>
                    </div>
                  </article>
                );
              }
              const job = entry.job;
              // 后端作业状态枚举为 queued/running/done/error;done 表示成功且有产物
              const hasResult = job.status === "done" && job.results?.length > 0;
              const isVideo = isVideoKind(job.kind);
              // R18 作品(M9):18+ 徽标 + 缩略图默认模糊,点击单张解除/恢复
              const isNsfw = !!job.nsfw;
              const isBlurred = isNsfw && !revealedIds.has(job.id);
              const isSelected = selectedIds.has(job.id);
              // 2026-08-16 视图批 1:标题位优先语义首段,后端写入的元信息串降级为副标
              const cardText = splitCardTitle(job);
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

                    {/* R18 徽标(M9):缩略图右下角(避开左上状态与右上操作组),仅 nsfw 作品渲染 */}
                    {isNsfw && (
                      <span className="lib-nsfw-badge" aria-hidden="true">
                        18+
                      </span>
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
          文件夹下钻内点开成员时穿梭范围限定为该组成员(lightboxScope) */}
      {lightboxIdx !== null && lightboxJobs[lightboxIdx] && (
        <LibraryLightbox
          jobs={lightboxJobs as JobItem[]}
          index={lightboxIdx}
          onClose={closeLightbox}
          onIndex={setLightboxIdx}
          onSaveStyle={openStylePopover}
          onReuse={reusePromptAsDraft}
          onDelete={handleDelete}
          deletingId={deletingId}
          dialogsOpen={!!styleTarget || !!confirmDelete || !!confirmDeleteStyle || confirmBatchDelete || !!confirmUpscale}
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
    <div className="single-view library-view">
      <header className="page-header lib-header">
        <div className="page-header-text">
          <h1 className="page-header-title">回收站</h1>
          <p className="page-header-desc">
            删除的作品在此保留 72 小时,期间可恢复;到期自动彻底删除
          </p>
        </div>
        <div className="page-header-actions">
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
          <Button
            size="sm"
            variant="secondary"
            className="lib-trash-back"
            icon={<Icon name="chevron-left" size={14} />}
            onClick={onBack}
          >
            返回作品库
          </Button>
        </div>
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
          <div className="lib-empty">
            <div className="lib-empty-icon" aria-hidden="true">
              <Icon name="delete" size={26} strokeWidth={1.2} />
            </div>
            <h2 className="lib-empty-display">回收站是空的</h2>
            <p className="lib-empty-desc">
              删除的作品会在这里保留 72 小时,期间随时可以恢复到作品库。
            </p>
          </div>
        )}

        {!error && !loading && !trashEmpty && (
          <div className="lib-grid">
            {(items ?? []).map((job) => {
              const hasResult = job.status === "done" && job.results?.length > 0;
              const isVideo = isVideoKind(job.kind);
              const cardText = splitCardTitle(job);
              return (
                <article key={job.id} className="lib-card">
                  <div className="lib-thumb">
                    {hasResult ? (
                      isVideo ? (
                        <LazyVideo
                          src={imageUrl(job.results[0])}
                          muted
                          loop
                          playsInline
                        />
                      ) : (
                        <ImageThumb job={job} />
                      )
                    ) : (
                      <ThumbPlaceholder job={job} />
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
