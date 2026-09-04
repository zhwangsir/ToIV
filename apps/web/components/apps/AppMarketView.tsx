"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { Icon, type IconName } from "@/components/ui/Icon";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { useToast } from "@/components/ui/Toast";
import {
  APP_CATEGORY_LABEL,
  appCategoryLabel,
  COMMUNITY_PAGE_SIZE,
  filterApps,
  forkApp,
  listApps,
  rhFamilyChips,
  sliceCommunityApps,
  sortFeaturedApps,
  splitAppSections,
  type AppCategory,
  type AppItem,
  type AppOutputKind,
} from "@/lib/apps";
import { getToken, TOKEN_KEY } from "@/lib/api";
import { useCrossTabSync } from "@/lib/crossTab";
import { useR18Mode } from "@/lib/r18";
import { AppImportModal } from "./AppImportModal";
import { AppRunnerView } from "./AppRunnerView";
/* 样式在 app/styles/apps.css(文件级):Section 子组件元素不被 styled-jsx
   注入哈希类,作用域样式会静默失效(skills.css 同款教训),故迁文件样式同范式 */
import "@/app/styles/apps.css";

/**
 * 应用市场(M3,2026-08-30):核心内置 / RunningHub 社区 / 公共 / 我的 四区卡片网格
 * + 分类 chips + 搜索 + NSFW 客户端过滤(r18 off 时 is_nsfw 整卡隐藏)。
 * 内置区 = id 不以 rh- 开头的 is_builtin(featuredIds 仍置顶 H3 四件套/15s/voice);
 * 社区区 = rh-* ,空查询先 24 张+「显示更多」,搜索/family 匹配上限 120。
 * 卡片 = 图标 + 名称 + 描述 + 类别徽标 + 用量计数 +「打开」;
 * fork 按钮仅非内置且非本人应用显示。
 * 「打开」进入运行页(AppRunnerView,视图内切换,不占路由;运行页 GET /api/apps/{id} 拉完整 schema)。
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
    /* 可交互卡(2026-09-04 美化 W2A):整卡点击 = 打开应用(内嵌按钮/链接点击与
       文本划选除外),共享类 .at-card--interactive 承载 hover 配方,
       键盘聚焦态为琥珀描边 1.5px + soft 底(apps.css .apps-card:focus-visible) */
    <article
      key={a.id}
      className="apps-card at-card--interactive"
      role="button"
      tabIndex={0}
      aria-label={`打开应用 ${a.name}`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button, a")) return;
        if (window.getSelection()?.toString()) return; /* 划选描述文本不触发打开 */
        setOpenId(a.id);
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setOpenId(a.id);
        }
      }}
    >
      <div className="apps-card-head">
        <Icon name={iconOf(a)} size={15} />
        <span className="apps-card-name" title={a.name}>
          {a.name}
        </span>
        {showFork && (
          <button
            type="button"
            className="apps-card-act"
            title="Fork 为我的副本"
            aria-label={`Fork ${a.name} 为我的副本`}
            disabled={forkingId === a.id}
            onClick={() => void fork(a)}
          >
            <Icon name={forkingId === a.id ? "loading" : "plus"} size={13} />
          </button>
        )}
      </div>
      <p className="apps-card-desc">{a.description}</p>
      <div className="apps-card-foot">
        <span className="apps-tag">{appCategoryLabel(a.category)}</span>
        {a.is_mine && <span className="apps-tag">我的</span>}
        {a.is_nsfw && <span className="apps-tag is-nsfw">R18</span>}
        <span className="apps-usage" title="使用次数">
          {a.usage_count} 次
        </span>
        <span className="apps-card-open">
          <Button variant="primary" size="sm" onClick={() => setOpenId(a.id)}>
            打开
          </Button>
        </span>
      </div>
    </article>
  );

  return (
    <div className="single-view apps-market">
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
            /* 整库空态(2026-09-02 W3):大图标 Empty → 单行 muted 提示 + 行内重试 */
            <p className="apps-filter-empty apps-empty-all">
              应用市场暂无应用——内置应用由后端注册表提供
              <Button
                variant="ghost"
                size="sm"
                icon={<Icon name="refresh" size={13} />}
                onClick={() => void refresh()}
              >
                重试
              </Button>
            </p>
          ) : (
            <>
              {filtering && visibleCount === 0 && (
                <p className="apps-filter-empty">
                  没有匹配的应用——换个关键词,或清除筛选条件
                </p>
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
                    <p className="apps-empty">没有匹配的社区应用</p>
                  ) : (
                    <div className="apps-grid">
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
        empty ? (
          <p className="apps-empty">{empty}</p>
        ) : null
      ) : (
        <div className="apps-grid">{children}</div>
      )}
    </section>
  );
}
