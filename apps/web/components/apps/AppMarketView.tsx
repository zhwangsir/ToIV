"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Empty } from "@/components/ui/Empty";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { Icon, type IconName } from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toast";
import {
  appAuthorInitial,
  appAuthorOf,
  COMMUNITY_PAGE_SIZE,
  COMMUNITY_SEARCH_CAP,
  filterApps,
  forkApp,
  listApps,
  placeholderAspect,
  sortAppsHot,
  sortFeaturedApps,
  USE_CASE_GROUPS,
  useCaseGroup,
  type AppItem,
  type AppMarketSort,
  type AppOutputKind,
} from "@/lib/apps";
import { getMe, getToken, imageUrl, TOKEN_KEY } from "@/lib/api";
import { useCrossTabSync } from "@/lib/crossTab";
import { useR18Mode } from "@/lib/r18";
import { AppImportModal } from "./AppImportModal";
import { AppRunnerView } from "./AppRunnerView";
/* 样式在 app/styles/apps.css(文件级):子树不被 styled-jsx 注入哈希类,
   作用域样式会静默失效(skills.css 同款教训),故迁文件样式同范式 */
import "@/app/styles/apps.css";

/**
 * 应用市场(M3 → 2026-09-07 统一流;2026-09-12 市场策展层):.rh-dark 作用域;单流瀑布
 * (去掉「内置/社区/公共/我的」分区与分类/family chips);
 * 仍走 filterApps NSFW 门控 + outputKind;工具栏保留搜索 + 默认/热门。
 * 策展层:工具栏下用途分类 chips(use_case,与 q 叠加过滤,再点取消);
 * 「未搜索且未选用途」时瀑布上方挂精选(featured)/热门(usage_count top10)横滚小卡;
 * 搜索时显示「找到 N 个应用」。
 * 瀑布(稳定多列 DOM 6/5/4/2,非 CSS columns);封面 IntersectionObserver 懒加载 +
 * skeleton-shimmer 占位(列表与单卡封面均主题感知)。
 * 列表触底无限滚动(哨兵 IO ~150px 提前量),小步续载(+10),按钮式分页已移除。
 * 追加时已放置 id 永不换列,仅列底增长;断点变化才一次性重分。
 */

/** 一级分类(2026-09-15):空串=市场首页 */
type MarketCat = "" | "image" | "video" | "audio";

const STREAM_PAGE = COMMUNITY_PAGE_SIZE;
const STREAM_MOUNT_CAP = 240;  // DOM 挂载上限(长会话窗口化)
const STREAM_SEARCH_CAP = COMMUNITY_SEARCH_CAP;

function iconOf(a: AppItem): IconName {
  return (a.icon || "package") as IconName;
}

export interface AppMarketViewProps {
  /** 按产物类型收窄(图片/视频创作页);不传 = 市场全量 */
  outputKind?: AppOutputKind;
  /** 置顶 id(视频页 H3 精选);过滤后再排 */
  featuredIds?: readonly string[];
  /** 运行页返回按钮文案,默认「返回市场」 */
  runnerBackLabel?: string;
}

export function AppMarketView({ outputKind, featuredIds, runnerBackLabel }: AppMarketViewProps = {}) {
  const toast = useToast();
  const [apps, setApps] = useState<AppItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [marketSort, setMarketSort] = useState<AppMarketSort>("default");
  /** 场景组 chips(2026-09-14 分类重设计:12 use_case → 8 场景组);"all" = 不过滤 */
  const [useCase, setUseCase] = useState("all");
  /** 一级分类页(2026-09-15 用户拍板):空串=市场首页;image/video/audio=二级功能页 */
  const [cat, setCat] = useState<MarketCat>("");
  const [streamShown, setStreamShown] = useState(STREAM_PAGE);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  /** 本轮追加起点下标;仅 i >= enterFrom 的卡加 is-appended fade,整表不重播 */
  const [enterFrom, setEnterFrom] = useState<number | null>(null);
  const [r18] = useR18Mode();

  const [openId, setOpenId] = useState<string | null>(null);
  // 深链(2026-09-15 作品库「打开应用」):/?view=market&app=<id> 直开运行台;
  // 挂载时读一次,关闭运行台时清掉 URL 参数(刷新不再重开,但保留可分享性)
  // 二级分类页(2026-09-15 用户拍板):/?view=market&cat=image|video|audio
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const appParam = params.get("app");
    if (appParam) setOpenId(appParam);
    const catParam = params.get("cat");
    if (catParam === "image" || catParam === "video" || catParam === "audio") setCat(catParam);
  }, []);

  /** 写/清 URL 的 cat 参数(不触发导航,replaceState 保分享可回放) */
  const syncCatUrl = useCallback((next: MarketCat) => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (next) params.set("cat", next);
    else params.delete("cat");
    const qs = params.toString();
    window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : ""));
  }, []);
  const openCat = useCallback((c: MarketCat) => {
    setCat(c);
    setUseCase("all");
    syncCatUrl(c);
  }, [syncCatUrl]);
  const exitCat = useCallback(() => {
    setCat("");
    setUseCase("all");
    syncCatUrl("");
  }, [syncCatUrl]);
  const closeRunner = useCallback(() => {
    setOpenId(null);
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("app")) {
      const params = new URLSearchParams(window.location.search);
      params.delete("app");
      const qs = params.toString();
      window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : ""));
    }
  }, []);
  const [forkingId, setForkingId] = useState<string | null>(null);

  const [loggedIn, setLoggedIn] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  useEffect(() => {
    setLoggedIn(!!getToken());
  }, []);
  useCrossTabSync(TOKEN_KEY, (v) => setLoggedIn(!!v));

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setApps(await listApps());
    } catch (e) {
      setApps([]);
      setLoadError(e instanceof Error ? e.message : "应用列表加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 可见集(NSFW 门控 + outputKind;不含 q/useCase):chips 计数与合集位的共同基底 */
  const visibleApps = useMemo(
    () => filterApps(apps, { category: "all", r18, outputKind }),
    [apps, r18, outputKind],
  );

  /** 场景组 chips:计数 = 组内不同功能入口(指纹)数,与折叠后的网格一致 */
  const groupChips = useMemo(() => {
    const all = new Set<string>();
    const per = new Map<string, Set<string>>();
    for (const a of visibleApps) {
      const fp = a.fingerprint || a.id;
      all.add(fp);
      const g = USE_CASE_GROUPS.find((x) => (x.useCases as readonly string[]).includes(a.use_case ?? ""));
      if (g) {
        let set = per.get(g.id);
        if (!set) {
          set = new Set();
          per.set(g.id, set);
        }
        set.add(fp);
      }
    }
    return {
      total: all.size,
      chips: USE_CASE_GROUPS.map((g) => ({
        id: g.id,
        label: g.label,
        icon: g.icon,
        count: per.get(g.id)?.size ?? 0,
      })).filter((c) => c.count > 0 || c.id === useCase),
    };
  }, [visibleApps, useCase]);

  // 二级分类页数据(2026-09-15 用户拍板):图片/视频大分类 → 组内按功能组细分
  const catPage = useMemo(() => {
    if (!cat) return null;
    const inCat = visibleApps.filter((a) => (a.output_kind || "image") === cat);
    const per = new Map<string, Set<string>>();
    for (const a of inCat) {
      const g = USE_CASE_GROUPS.find((x) => (x.useCases as readonly string[]).includes(a.use_case ?? ""));
      if (!g) continue;
      const set = per.get(g.id) ?? new Set<string>();
      set.add(a.fingerprint || a.id);
      per.set(g.id, set);
    }
    const chips = USE_CASE_GROUPS.map((g) => ({
      id: g.id,
      label: g.label,
      icon: g.icon,
      count: per.get(g.id)?.size ?? 0,
    })).filter((c) => c.count > 0);
    const labels: Record<string, string> = { image: "图片应用", video: "视频应用", audio: "音频应用" };
    return {
      label: labels[cat] ?? cat,
      total: inCat.length,
      chips,
    };
  }, [visibleApps, cat]);

  // 首页一级入口卡(图片/视频/音频):计数=该类功能入口数,封面取该类头部应用的图
  const heroCats = useMemo(() => {
    const defs: { key: "image" | "video" | "audio"; label: string; icon: IconName; desc: string }[] = [
      { key: "image", label: "图片", icon: "image", desc: "写真 · 编辑 · 换装 · 风格创作" },
      { key: "video", label: "视频", icon: "video", desc: "文生视频 · 图生视频 · 数字人" },
      { key: "audio", label: "音频", icon: "audio", desc: "音乐生成与音频处理" },
    ];
    return defs
      .map((d) => {
        const inCat = visibleApps.filter((a) => !a.is_variant && (a.output_kind || "image") === d.key);
        const covers = inCat
          .map((a) => a.cover_url)
          .filter((u): u is string => !!u)
          .slice(0, 3);
        return { ...d, count: new Set(inCat.map((a) => a.fingerprint || a.id)).size, covers };
      })
      .filter((d) => d.count > 0);
  }, [visibleApps]);

  const [showVariants, setShowVariants] = useState(false);
  // 管理员视角默认只看已上架:私有/草稿导入残堆(曾达 1711)不进市场网格
  const [showUnlisted, setShowUnlisted] = useState(false);
  // 是否登录为管理员(决定「含未上架」chip 是否出现;普通用户恒只看已上架)
  const [adminSeen, setAdminSeen] = useState(false);
  useEffect(() => {
    let alive = true;
    getMe()
      .then((me) => {
        if (alive && me.user?.role === "admin") setAdminSeen(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const variantTotal = useMemo(
    () => apps.reduce((n, a) => n + (a.is_variant ? 1 : 0), 0),
    [apps],
  );
  const filtered = useMemo(() => {
    // category 固定 all:分区/旧分类 chips 已撤;NSFW 与 outputKind 仍生效;
    // 场景组 = 组内 use_case 白名单过滤(未分类应用仅在「全部」出现)
    const grp = useCase === "all" ? null : useCaseGroup(useCase);
    const base = showUnlisted ? apps : apps.filter((a) => a.is_public || !adminSeen);
    const list0 = filterApps(base, { q: query, category: "all", r18, outputKind });
    // 一级分类(二级页):按产物类型;空串=首页不过滤
    const byCat = cat ? list0.filter((a) => (a.output_kind || "image") === cat) : list0;
    const list = grp
      ? byCat.filter((a) => (grp.useCases as readonly string[]).includes(a.use_case ?? ""))
      : byCat;
    // 功能归组(2026-09-15):同指纹变体默认折叠,搜索时仍全量(搜到变体算命中)
    const folded = showVariants || query.trim() !== "" ? list : list.filter((a) => !a.is_variant);
    const ranked = sortFeaturedApps(folded, featuredIds);
    return marketSort === "hot" ? sortAppsHot(ranked) : ranked;
  }, [apps, query, r18, outputKind, cat, useCase, featuredIds, marketSort, showVariants, showUnlisted, adminSeen]);

  const searching = query.trim() !== "";
  /** 合集位(精选/热门)仅在「未搜索 且 未选用途」时挂在瀑布流上方 */
  const curatedRails = useMemo(() => {
    const featured = visibleApps.filter((a) => a.featured);
    const featuredIdSet = new Set(featured.map((a) => a.id));
    const hot = sortAppsHot(visibleApps.filter((a) => !featuredIdSet.has(a.id))).slice(0, 10);
    return { featured, hot };
  }, [visibleApps, searching, useCase]);
  const streamSlice = useMemo(() => {
    if (searching) {
      return {
        items: filtered.slice(0, STREAM_SEARCH_CAP),
        matched: filtered.length,
        truncated: filtered.length > STREAM_SEARCH_CAP,
        hasMore: false,
      };
    }
    // DOM 窗口化:最多挂载 240 张卡(与作品库同款),防长会话「加载更多」累积卡顿
    const shown = Math.min(Math.max(STREAM_PAGE, streamShown), STREAM_MOUNT_CAP);
    return {
      items: filtered.slice(0, shown),
      matched: filtered.length,
      truncated: false,
      hasMore: shown < filtered.length,
    };
  }, [filtered, searching, streamShown]);

  useEffect(() => {
    setStreamShown(STREAM_PAGE);
    setLoadingMore(false);
    loadingMoreRef.current = false;
    setEnterFrom(null);
  }, [query, outputKind, marketSort, r18, useCase, cat]);

  /** 触底小步推进(+STREAM_PAGE);同步切片,安静追加(不闪 loading 细条) */
  const advanceStream = useCallback(() => {
    if (searching || loadingMoreRef.current) return;
    const shown = Math.max(STREAM_PAGE, streamShown);
    if (shown >= filtered.length) return;
    loadingMoreRef.current = true;
    setEnterFrom(shown);
    setStreamShown(shown + STREAM_PAGE);
    // 本地 slice 即时完成:保持 loadingMore=false,避免填视口连闪底条
    queueMicrotask(() => {
      loadingMoreRef.current = false;
    });
  }, [searching, streamShown, filtered.length]);

  // 无限滚动:底部哨兵进入视口(含 ~150px 提前量)即 advance(小步续载)
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !streamSlice.hasMore) return;
    if (typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) advanceStream();
      },
      { rootMargin: "150px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [advanceStream, streamSlice.hasMore, streamSlice.items.length]);

  // 视口较高时哨兵可能一直可见:rAF 节流补页,避免连闪 loading UI
  useEffect(() => {
    if (!streamSlice.hasMore || searching) return;
    const el = sentinelRef.current;
    if (!el) return;
    let cancelled = false;
    let raf = 0;
    const tick = () => {
      if (cancelled) return;
      const vh = window.innerHeight;
      if (el.getBoundingClientRect().top < vh + 150) {
        advanceStream();
        raf = requestAnimationFrame(() => {
          raf = requestAnimationFrame(tick);
        });
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [streamSlice.hasMore, streamSlice.items.length, searching, advanceStream]);

  // 瀑布流(2026-09-15 重构):CSS 原生多列(columns)接管,浏览器自行分列,
  // 任何视口宽度都不会塌成单列;组件只负责窗口化切片
  const masonryItems = streamSlice.items;

  async function fork(a: AppItem) {
    setForkingId(a.id);
    try {
      const copy = await forkApp(a.id);
      toast.success(`已 Fork 为我的应用「${copy.name}」`);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Fork 失败");
    } finally {
      setForkingId(null);
    }
  }

  if (openId) {
    return (
      <AppRunnerView
        appId={openId}
        onBack={closeRunner}
        backLabel={runnerBackLabel}
      />
    );
  }

  return (
    <div className="single-view apps-market rh-dark">
      {loading ? (
        <MarketSkeleton count={12} />
      ) : loadError ? (
        <div className="apps-load-error">
          <ErrorBar message={loadError} onClose={() => setLoadError(null)} />
          <Button
            variant="secondary"
            size="sm"
            icon={<Icon name="refresh" size={13} />}
            onClick={() => void refresh()}
          >
            重试
          </Button>
        </div>
      ) : (
        <>
          <div className="apps-toolbar" role="search">
            <div className="apps-toolbar-search">
              <Icon name="search" size={14} strokeWidth={1.8} />
              <input
                type="search"
                className="apps-search-input"
                placeholder="搜索应用名称或描述…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="搜索应用"
              />
            </div>
            <div className="apps-toolbar-chips" role="group" aria-label="排序">
              {(
                [
                  ["default", "默认"],
                  ["hot", "热门"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`apps-chip${marketSort === value ? " is-on" : ""}`}
                  aria-pressed={marketSort === value}
                  onClick={() => setMarketSort(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            {loggedIn && (
              <Button
                variant="secondary"
                size="sm"
                icon={<Icon name="wand" size={13} />}
                onClick={() => setImportOpen(true)}
              >
                智能导入
              </Button>
            )}
          </div>

          {/* 二级分类页:面包屑 + 功能组 chips(2026-09-15 用户拍板两级结构) */}
          {catPage && (
            <>
              <nav className="apps-mkt-crumb" aria-label="位置">
                <button type="button" className="apps-mkt-crumb-back" onClick={() => exitCat()}>
                  <Icon name="chevron-left" size={13} />
                  市场首页
                </button>
                <span className="apps-mkt-crumb-sep" aria-hidden="true">/</span>
                <span className="apps-mkt-crumb-current">{catPage.label}</span>
                <span className="apps-mkt-crumb-count">{catPage.total} 个应用</span>
              </nav>
              <div className="apps-mkt-chips" role="group" aria-label="按功能筛选">
                <button
                  type="button"
                  className={`apps-mkt-chip${useCase === "all" ? " is-on" : ""}`}
                  aria-pressed={useCase === "all"}
                  onClick={() => setUseCase("all")}
                >
                  全部
                  <span className="apps-mkt-chip-count">{catPage.total}</span>
                </button>
                {catPage.chips.map((c) => {
                  const grp = useCaseGroup(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      className={`apps-mkt-chip${useCase === c.id ? " is-on" : ""}`}
                      aria-pressed={useCase === c.id}
                      onClick={() => setUseCase((prev) => (prev === c.id ? "all" : c.id))}
                      title={grp?.blurb}
                    >
                      <Icon name={c.icon} size={12} aria-hidden="true" />
                      {c.label}
                      <span className="apps-mkt-chip-count">{c.count}</span>
                    </button>
                  );
                })}
              </div>
              {useCase !== "all" && (
                <p className="apps-mkt-blurb" role="note">
                  {useCaseGroup(useCase)?.blurb}
                </p>
              )}
            </>
          )}

          {/* 市场首页:一级分类入口卡(图片/视频/音频) */}
          {cat === "" && !searching && heroCats.length > 0 && (
            <div className="apps-mkt-hero" role="navigation" aria-label="应用分类">
              {heroCats.map((h) => (
                <button
                  key={h.key}
                  type="button"
                  className="apps-mkt-hero-card"
                  onClick={() => openCat(h.key)}
                >
                  <span
                    className="apps-mkt-hero-covers"
                    aria-hidden="true"
                    style={
                      h.covers[0]
                        ? { backgroundImage: `url(${h.covers[0]})` }
                        : undefined
                    }
                  />
                  <span className="apps-mkt-hero-body">
                    <span className="apps-mkt-hero-title">
                      <Icon name={h.icon} size={16} aria-hidden="true" />
                      {h.label}
                    </span>
                    <span className="apps-mkt-hero-desc">{h.desc}</span>
                    <span className="apps-mkt-hero-count">{h.count} 个应用</span>
                  </span>
                </button>
              ))}
            </div>
          )}

          {(searching || cat) && (
            <p className="apps-mkt-search-hint" role="status">
              {searching ? `找到 ${filtered.length} 个应用` : `${catPage?.label ?? ""} · 共 ${catPage?.total ?? 0} 个应用`}
            </p>
          )}

          {cat === "" && !searching ? (
            <>
              {curatedRails.featured.length > 0 && (
                <section className="apps-mkt-section" aria-label="精选应用">
                  <h2 className="apps-mkt-section-title">
                    <Icon name="sparkles" size={13} strokeWidth={1.8} />
                    精选
                    <span className="apps-mkt-section-count">
                      {curatedRails.featured.length}
                    </span>
                  </h2>
                  <div className="apps-mkt-rail" role="list">
                    {curatedRails.featured.map((a) => (
                      <MiniAppCard key={a.id} app={a} onOpen={() => setOpenId(a.id)} />
                    ))}
                  </div>
                </section>
              )}
              {curatedRails.hot.length > 0 && (
                <section className="apps-mkt-section" aria-label="热门应用">
                  <h2 className="apps-mkt-section-title">
                    <Icon name="zap" size={13} strokeWidth={1.8} />
                    热门
                    <span className="apps-mkt-section-count">
                      {curatedRails.hot.length}
                    </span>
                  </h2>
                  <div className="apps-mkt-rail" role="list">
                    {curatedRails.hot.map((a) => (
                      <MiniAppCard key={a.id} app={a} onOpen={() => setOpenId(a.id)} />
                    ))}
                  </div>
                </section>
              )}
            </>
          ) : filtered.length === 0 ? (
            searching || useCase !== "all" ? (
              <Empty size="inline" title="没有匹配的应用——换个关键词或分类" />
            ) : (
              <Empty
                size="inline"
                title="应用市场暂无应用"
                desc="应用由后端注册表提供"
                action={
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Icon name="refresh" size={13} />}
                    onClick={() => void refresh()}
                  >
                    重试
                  </Button>
                }
              />
            )
          ) : (
            <>
              <div className="apps-masonry" role="list" aria-label="应用列表">
                {masonryItems.map((a, i) => (
                  <AppCard
                    key={a.id}
                    app={a}
                    appended={enterFrom != null && i >= enterFrom}
                    showFork={!a.is_builtin && !a.is_mine}
                    forking={forkingId === a.id}
                    onOpen={() => setOpenId(a.id)}
                    onFork={() => void fork(a)}
                  />
                ))}
              </div>
              {streamSlice.hasMore && (
                <div className="apps-community-more">
                  <div
                    ref={sentinelRef}
                    className="apps-load-sentinel"
                    aria-hidden="true"
                  />
                  {loadingMore && (
                    <div
                      className="apps-load-more"
                      role="status"
                      aria-label="加载更多"
                      aria-busy="true"
                    >
                      <span className="apps-load-more-bar" aria-hidden="true" />
                    </div>
                  )}
                </div>
              )}
              {streamSlice.truncated && (
                <p className="apps-truncated">结果已截断,请再缩小关键词</p>
              )}
            </>
          )}
        </>
      )}

      <AppImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => void refresh()}
      />
    </div>
  );
}

/** 主题感知瀑布骨架:CSS 原生多列占位卡(motion tokens shimmer)。 */
function MarketSkeleton({ count }: { count: number }) {
  const ars = ["1 / 1", "4 / 5", "3 / 4", "5 / 4"] as const;
  return (
    <div className="apps-masonry" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="apps-skeleton-card skeleton-shimmer"
          style={{ aspectRatio: ars[i % ars.length] }}
        />
      ))}
    </div>
  );
}



function MiniAppCard({ app: a, onOpen }: { app: AppItem; onOpen: () => void }) {
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = !!a.cover_url && !imgFailed;
  return (
    <article
      className="apps-mkt-mini"
      role="listitem"
      tabIndex={0}
      aria-label={`打开应用 ${a.name}`}
      title={a.guide_purpose || a.description || a.name}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button, a")) return;
        if (window.getSelection()?.toString()) return;
        onOpen();
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="apps-mkt-mini-cover" data-category={a.category}>
        {showImg ? (
          <LazyCoverImg
            src={imageUrl(a.cover_url ?? "")}
            alt={a.name}
            onError={() => setImgFailed(true)}
          />
        ) : (
          <span className="rh-card-placeholder-icon" aria-hidden="true">
            <Icon name={iconOf(a)} size={22} strokeWidth={1.4} />
          </span>
        )}
      </div>
      <div className="apps-mkt-mini-body">
        <span className="apps-mkt-mini-name">{a.name}</span>
        <span className="apps-mkt-mini-meta" title="运行次数">
          <Icon name="play" size={9} />
          {a.usage_count}
        </span>
      </div>
    </article>
  );
}

/**
 * 封面懒加载:进入视口(rootMargin 240px)才设 src,避免离屏拉取;
 * 无 IntersectionObserver 时立刻激活;loading=lazy 作双保险。
 */
function LazyCoverImg({
  src,
  alt,
  onError,
  onLoad,
}: {
  src: string;
  alt: string;
  onError: () => void;
  onLoad?: () => void;
}) {
  const ref = useRef<HTMLImageElement | null>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setActive(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setActive(true);
          io.disconnect();
        }
      },
      { rootMargin: "240px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={ref}
      className="rh-card-img"
      src={active ? src : undefined}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={onError}
      onLoad={onLoad}
    />
  );
}

function AppCard({
  app: a,
  appended = false,
  showFork,
  forking,
  onOpen,
  onFork,
}: {
  app: AppItem;
  /** 本轮无限滚动新追加:仅这些卡短 fade-in */
  appended?: boolean;
  showFork: boolean;
  forking: boolean;
  onOpen: () => void;
  onFork: () => void;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const showImg = !!a.cover_url && !imgFailed;
  const ar = placeholderAspect(a.id);
  return (
    <article
      className={`apps-card rh-card${appended ? " is-appended" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={`打开应用 ${a.name}`}
      title={a.description || a.name}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button, a")) return;
        if (window.getSelection()?.toString()) return;
        onOpen();
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div
        className="rh-card-cover"
        data-category={a.category}
        style={{ aspectRatio: showImg && imgLoaded ? undefined : ar }}
      >
        {showImg ? (
          <>
            {!imgLoaded && (
              <span className="rh-card-img-skel skeleton-shimmer" aria-hidden="true" />
            )}
            <LazyCoverImg
              src={imageUrl(a.cover_url ?? "")}
              alt={a.name}
              onError={() => setImgFailed(true)}
              onLoad={() => setImgLoaded(true)}
            />
          </>
        ) : (
          <span className="rh-card-placeholder-icon" aria-hidden="true">
            <Icon name={iconOf(a)} size={32} strokeWidth={1.4} />
          </span>
        )}
        {(() => {
          const dual =
            !!a.content_modes?.includes("sfw") && !!a.content_modes?.includes("nsfw");
          const nsfwOnly =
            !dual && (!!a.content_modes?.includes("nsfw") || (!a.content_modes?.length && a.is_nsfw));
          if (!dual && !nsfwOnly && !a.is_mine) return null;
          return (
            <span className="rh-card-badges">
              {dual && <span className="apps-tag is-sfw">SFW</span>}
              {dual && <span className="apps-tag is-nsfw">NSFW</span>}
              {nsfwOnly && <span className="apps-tag is-nsfw">NSFW</span>}
              {a.is_mine && <span className="apps-tag">我的</span>}
            </span>
          );
        })()}
        {showFork && (
          <button
            type="button"
            className="apps-card-act rh-card-fork"
            title="Fork 为我的副本"
            aria-label={`Fork ${a.name} 为我的副本`}
            disabled={forking}
            onClick={onFork}
          >
            <Icon name={forking ? "loading" : "plus"} size={13} />
          </button>
        )}
        <span className="rh-card-run" aria-hidden="true">
          <Icon name="play" size={13} /> 运行
        </span>
        {a.smoke_status === "pass" && (
          <span className="apps-smoke-badge apps-smoke-pass" title="自动烟测通过(导入即测)">
            <Icon name="check" size={11} /> 实测可用
          </span>
        )}
        {a.smoke_status && a.smoke_status !== "pass" && a.smoke_status !== "running" && (
          <span className="apps-smoke-badge apps-smoke-fail" title={`自动烟测未通过(${a.smoke_cls || "未知"})`}>
            待修
          </span>
        )}
        <div className="rh-card-scrim">
          <span className="rh-card-name">{a.name}</span>
          {a.guide_purpose && (
            <span className="apps-guide-card-purpose">{a.guide_purpose}</span>
          )}
          <span className="rh-card-meta">
            <span className="rh-card-author">
              <span className="rh-card-avatar" aria-hidden="true">
                {appAuthorInitial(a)}
              </span>
              {appAuthorOf(a)}
            </span>
            <span className="apps-usage rh-card-usage" title="运行次数">
              <Icon name="play" size={10} />
              {a.usage_count}
            </span>
          </span>
        </div>
      </div>
    </article>
  );
}
