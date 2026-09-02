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
  filterApps,
  forkApp,
  listApps,
  splitAppSections,
  type AppCategory,
  type AppItem,
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
 * 应用市场(M3,2026-08-30):内置/公共/我的三区卡片网格 + 分类 chips + 搜索
 * + NSFW 客户端过滤(r18 off 时 is_nsfw 整卡隐藏,三区共用同一过滤条件)。
 * 卡片 = 图标 + 名称 + 描述 + 类别徽标 + 用量计数 +「打开」;
 * fork 按钮仅非内置且非本人应用显示。
 * 「打开」进入运行页(AppRunnerView,视图内切换,不占路由)。
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

export function AppMarketView() {
  const toast = useToast();
  const [apps, setApps] = useState<AppItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ── 检索:搜索词 + 分类 chips,三区共用(客户端即时过滤) ──
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
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

  const filtered = useMemo(
    () => filterApps(apps, { q: query, category, r18 }),
    [apps, query, category, r18],
  );
  const { builtin, pub, mine } = useMemo(() => splitAppSections(filtered), [filtered]);
  const filtering = query.trim() !== "" || category !== "all";

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
    return <AppRunnerView appId={openId} onBack={() => setOpenId(null)} />;
  }

  const renderCard = (a: AppItem, showFork: boolean) => (
    <article key={a.id} className="apps-card">
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

          {!filtering && builtin.length + pub.length + mine.length === 0 ? (
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
              {filtering && mine.length + builtin.length + pub.length === 0 && (
                <p className="apps-filter-empty">
                  没有匹配的应用——换个关键词,或清除筛选条件
                </p>
              )}

              <Section title="内置应用" count={builtin.length} empty="">
                {builtin.map((a) => renderCard(a, false))}
              </Section>

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
