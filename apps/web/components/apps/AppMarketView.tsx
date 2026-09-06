"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Empty } from "@/components/ui/Empty";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { Icon, type IconName } from "@/components/ui/Icon";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { useToast } from "@/components/ui/Toast";
import {
  APP_CATEGORY_LABEL,
  appAuthorInitial,
  appAuthorOf,
  COMMUNITY_PAGE_SIZE,
  filterApps,
  forkApp,
  listApps,
  placeholderAspect,
  rhFamilyChips,
  sliceCommunityApps,
  sortFeaturedApps,
  splitAppSections,
  type AppCategory,
  type AppItem,
  type AppOutputKind,
} from "@/lib/apps";
import { getToken, imageUrl, TOKEN_KEY } from "@/lib/api";
import { useCrossTabSync } from "@/lib/crossTab";
import { useR18Mode } from "@/lib/r18";
import { AppImportModal } from "./AppImportModal";
import { AppRunnerView } from "./AppRunnerView";
/* 样式在 app/styles/apps.css(文件级):Section 子组件元素不被 styled-jsx
   注入哈希类,作用域样式会静默失效(skills.css 同款教训),故迁文件样式同范式 */
import "@/app/styles/apps.css";

/**
 * 应用市场(M3,2026-09-06 RunningHub 化重做):深黑底(.rh-dark 作用域,只在市场/详情
 * 覆盖暗色令牌,不影响全站亮/暗主题)+ 瀑布流封面大卡(CSS columns,5/4/3/2 响应式)。
 * 卡片 = 封面充满整卡(cover_url,空则按 category 暗色渐变+大图标占位,占位高度按 id
 * 散列 4 档以成瀑布流)+ 底部渐变压黑 scrim 上白字标题 + 作者行(首字母头像+名字,
 * author 空兜底「ToIV」)+ mono 运行数据(▶ usage_count,唯一真实数据,不造点赞/收藏);
 * fork/R18/我的 徽标收进角落小标,hover 封面微放大 + 荧光绿描边 +「运行」荧光 pill。
 *
 * 分区保留四区(内置 / RunningHub 社区 / 公共 / 我的)与检索工具栏(搜索+分类 chips);
 * 社区区空查询先 24 张+「显示更多」,搜索/family 匹配上限 120。
 * 卡片点击 = 打开详情(AppRunnerView,视图内切换,不占路由;详情 GET /api/apps/{id} 拉完整 schema)。
 *
 * 页头省略(同 SkillMarketView):灵动岛/BottomNav 已明确指示当前板块,
 * 检索工具栏即首行,符合 UI_STANDARD §5 例外条款。
 */

const CATEGORY_CHIPS: { value: string; label: string }[] = [
  { value: "all", label: "全部" },
  ...(Object.entries(APP_CATEGORY_LABEL) as [AppCategory, string][]).map(([value, label]) => ({
    value,
    label,
  })),
];

function iconOf(a: AppItem): IconName {
  // 未知名由 Icon 内部兜底占位(console.warn + 空位),不崩卡片
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

  // ── 检索:搜索词 + 分类 chips,三区共用(客户端即时过滤) ──
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  /** RunningHub 社区 family chip;空串 = 未选 */
  const [family, setFamily] = useState("");
  /** 空查询社区卡已展示数量(「显示更多」+24) */
  const [communityShown, setCommunityShown] = useState(COMMUNITY_PAGE_SIZE);
  // NSFW 客户端过滤:R18 模式 off 时隐藏 is_nsfw 应用
  const [r18] = useR18Mode();

  // 「打开」进入运行页(视图内切换;返回市场 = 清空 openId)
  const [openId, setOpenId] = useState<string | null>(null);
  // fork 进行中的应用 id(按钮 loading/防重)
  const [forkingId, setForkingId] = useState<string | null>(null);

  // ── M5 智能导入:仅登录态可见(市场页整体在登录壳内,此处防会话过期残留 + 跨页退出同步) ──
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

  const filtered = useMemo(() => {
    const list = filterApps(apps, { q: query, category, r18, outputKind });
    return sortFeaturedApps(list, featuredIds);
  }, [apps, query, category, r18, outputKind, featuredIds]);
  const { builtin, community, pub, mine } = useMemo(() => splitAppSections(filtered), [filtered]);
  const families = useMemo(() => rhFamilyChips(community), [community]);
  const communitySlice = useMemo(
    () => sliceCommunityApps(community, { q: query, family, shown: communityShown }),
    [community, query, family, communityShown],
  );
  const filtering = query.trim() !== "" || category !== "all";
  const visibleCount = builtin.length + community.length + pub.length + mine.length;

  useEffect(() => {
    setCommunityShown(COMMUNITY_PAGE_SIZE);
  }, [query, family, category, outputKind]);

  useEffect(() => {
    if (family && !families.includes(family)) setFamily("");
  }, [family, families]);

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
        onBack={() => setOpenId(null)}
        backLabel={runnerBackLabel}
      />
    );
  }

  const renderCard = (a: AppItem, showFork: boolean) => (
    <AppCard
      key={a.id}
      app={a}
      showFork={showFork}
      forking={forkingId === a.id}
      onOpen={() => setOpenId(a.id)}
      onFork={() => void fork(a)}
    />
  );

  return (
    <div className="single-view apps-market rh-dark">
      {loading ? (
        <LoadingBlock variant="grid" count={6} />
      ) : loadError ? (
        /* 加载失败:ErrorBar + 条外重试,不静默显示空市场 */
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
          {/* 检索工具栏:搜索 + 分类 chips(客户端即时过滤,三区共用) */}
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
            {!outputKind && (
              <div className="apps-toolbar-chips" role="group" aria-label="按分类筛选">
                {CATEGORY_CHIPS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    className={`apps-chip${category === c.value ? " is-on" : ""}`}
                    aria-pressed={category === c.value}
                    onClick={() => setCategory(c.value)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            )}
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

          {!filtering && visibleCount === 0 ? (
            /* 整库空态(2026-09-04 美化 W4):单行 muted 提示 → 共享三档空态 inline 档 + 行内重试 */
            <Empty
              size="inline"
              title="应用市场暂无应用"
              desc="内置应用由后端注册表提供"
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
          ) : (
            <>
              {filtering && visibleCount === 0 && (
                <Empty size="inline" title="没有匹配的应用——换个关键词,或清除筛选条件" />
              )}

              <Section title="内置应用" count={builtin.length} empty="">
                {builtin.map((a) => renderCard(a, false))}
              </Section>

              {community.length > 0 && (
                <section className="apps-section">
                  <div className="apps-section-head">
                    <h2 className="apps-section-title">RunningHub 社区</h2>
                    <span className="apps-section-count" aria-label={`${communitySlice.matched} 个`}>
                      {communitySlice.matched}
                    </span>
                  </div>
                  {families.length > 0 && (
                    <div className="apps-family-chips" role="group" aria-label="按 RunningHub 类型筛选">
                      {families.map((f) => (
                        <button
                          key={f}
                          type="button"
                          className={`apps-chip${family === f ? " is-on" : ""}`}
                          aria-pressed={family === f}
                          onClick={() => setFamily((cur) => (cur === f ? "" : f))}
                        >
                          {f}
                        </button>
                      ))}
                    </div>
                  )}
                  {communitySlice.items.length === 0 ? (
                    <Empty size="inline" title="没有匹配的社区应用" />
                  ) : (
                    <div className="apps-grid rh-grid">
                      {communitySlice.items.map((a) => renderCard(a, !a.is_builtin && !a.is_mine))}
                    </div>
                  )}
                  {communitySlice.hasMore && (
                    <div className="apps-community-more">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setCommunityShown((n) => n + COMMUNITY_PAGE_SIZE)}
                      >
                        显示更多
                      </Button>
                    </div>
                  )}
                  {communitySlice.truncated && (
                    <p className="apps-truncated">结果已截断,请再缩小关键词</p>
                  )}
                </section>
              )}

              <Section title="公共应用" count={pub.length} empty="暂无公共应用">
                {pub.map((a) => renderCard(a, !a.is_builtin && !a.is_mine))}
              </Section>

              <Section
                title="我的应用"
                count={mine.length}
                empty="还没有我的应用——在公共应用卡片上点 + 即可 Fork 一份"
              >
                {mine.map((a) => renderCard(a, false))}
              </Section>
            </>
          )}
        </>
      )}

      {/* M5 智能导入:上架成功后整体刷新列表(「我的应用」区随之更新) */}
      <AppImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => void refresh()}
      />
    </div>
  );
}

/** 应用分区:标题行(小写铭牌 + 计数)+ 卡片网格;空文案为空串时不渲染占位。 */
function Section({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section className="apps-section">
      <div className="apps-section-head">
        <h2 className="apps-section-title">{title}</h2>
        <span className="apps-section-count" aria-label={`${count} 个`}>
          {count}
        </span>
      </div>
      {count === 0 ? (
        /* 空态升级(2026-09-04 美化 W4):共享三档空态 inline 档,grid 内占满整行 */
        empty ? (
          <Empty size="inline" title={empty} />
        ) : null
      ) : (
        /* 瀑布流(2026-09-06 RH 化):CSS columns;卡片 break-inside:avoid 防跨列截断 */
        <div className="apps-grid rh-grid">{children}</div>
      )}
    </section>
  );
}

/**
 * 瀑布流封面大卡(2026-09-06 RunningHub 化):封面充满整卡(cover_url 经 imageUrl 带 token;
 * 空/加载失败降级为按 category 色相的暗色渐变 + 居中大图标占位,占位高度按 id 散列 4 档),
 * 底部 scrim 渐变压黑上白字标题(600)+ 作者行(首字母圆头像 + 名字,空兜底 ToIV)
 * + mono ▶ usage_count;fork/R18/我的 为角落小标,hover 出「运行」荧光 pill。
 * 整卡点击 = 打开详情(内嵌按钮点击/文本划选除外),键盘 Enter/Space 同效。
 */
function AppCard({
  app: a,
  showFork,
  forking,
  onOpen,
  onFork,
}: {
  app: AppItem;
  showFork: boolean;
  forking: boolean;
  onOpen: () => void;
  onFork: () => void;
}) {
  /** 封面加载失败(404/鉴权过期等)降级占位渐变,不挂破图 */
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = !!a.cover_url && !imgFailed;
  return (
    <article
      className="apps-card rh-card"
      role="button"
      tabIndex={0}
      aria-label={`打开应用 ${a.name}`}
      title={a.description || a.name}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button, a")) return;
        if (window.getSelection()?.toString()) return; /* 划选文本不触发打开 */
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
        style={showImg ? undefined : { aspectRatio: placeholderAspect(a.id) }}
      >
        {showImg ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="rh-card-img"
            src={imageUrl(a.cover_url ?? "")}
            alt={a.name}
            loading="lazy"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <span className="rh-card-placeholder-icon" aria-hidden="true">
            <Icon name={iconOf(a)} size={32} strokeWidth={1.4} />
          </span>
        )}
        {/* 角落小标:R18 / 我的(不挤标题区) */}
        {(a.is_nsfw || a.is_mine) && (
          <span className="rh-card-badges">
            {a.is_nsfw && <span className="apps-tag is-nsfw">R18</span>}
            {a.is_mine && <span className="apps-tag">我的</span>}
          </span>
        )}
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
        {/* hover 荧光 pill:点击 = 直接进详情(运行页) */}
        <span className="rh-card-run" aria-hidden="true">
          <Icon name="play" size={13} /> 运行
        </span>
        {/* 底部 scrim:渐变压黑 + 标题/作者/用量 */}
        <div className="rh-card-scrim">
          <span className="rh-card-name">{a.name}</span>
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
