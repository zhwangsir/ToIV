"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  enrichModelWiki,
  fetchEngines,
  fetchModelSources,
  listLocalModels,
  listModelWiki,
  refreshEngines,
  type EnginesResponse,
  type ModelSourceItem,
  type ModelSourcesResponse,
  type ModelWikiCard,
} from "@/lib/api";
import type { LocalModels } from "@/lib/types";
import { Badge } from "@/components/ui/Badge";
import { Empty } from "@/components/ui/Empty";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { Icon } from "@/components/ui/Icon";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { Modal } from "@/components/ui/Modal";
import { PageHeader } from "@/components/ui/PageHeader";
import { Switch } from "@/components/ui/Switch";
import { Tabs } from "@/components/ui/Tabs";

type MaSection = "local" | "wiki" | "engines" | "sources";

const TOAST_MS = 3600;
/** 出处清单默认截断行数(813 行全量渲染过重;「显示全部」展开)。 */
const SOURCES_DEFAULT_ROWS = 200;

interface Toast {
  msg: string;
  tone: "ok" | "err";
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 相对时间格式化(与 AdminView 同口径:刚刚 / N 分钟前 / … / 日期)。 */
function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const diff = Date.now() - d.getTime();
    const min = 60_000;
    const hr = 60 * min;
    const day = 24 * hr;
    if (diff < min) return "刚刚";
    if (diff < hr) return `${Math.floor(diff / min)} 分钟前`;
    if (diff < day) return `${Math.floor(diff / hr)} 小时前`;
    if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
    return d.toLocaleDateString("zh-CN");
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// a. 本地模型清单
// ---------------------------------------------------------------------------

const LOCAL_CATS: { key: string; label: string }[] = [
  { key: "checkpoints", label: "底模" },
  { key: "loras", label: "LoRA" },
  { key: "vae", label: "VAE" },
  { key: "controlnet", label: "ControlNet" },
  { key: "upscale", label: "超分" },
];

const LOCAL_CAT_LABEL: Record<string, string> = Object.fromEntries(
  LOCAL_CATS.map((c) => [c.key, c.label]),
);

/** 仅取字符串条目(checkpoints_tagged 是对象数组,不作类目展示)。 */
function catFiles(models: LocalModels | null, key: string): string[] {
  const v = models?.[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && !!x);
}

function LocalModelsSection() {
  const [models, setModels] = useState<LocalModels | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cat, setCat] = useState("");
  const [q, setQ] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    listLocalModels()
      .then(setModels)
      .catch((err) =>
        setError(err instanceof Error ? err.message : "加载本地模型失败"),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of LOCAL_CATS) m.set(c.key, catFiles(models, c.key).length);
    return m;
  }, [models]);

  const nsfwSet = useMemo(
    () => new Set(catFiles(models, "nsfw_models")),
    [models],
  );
  const vpredSet = useMemo(
    () => new Set(catFiles(models, "vpred_models")),
    [models],
  );

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const cats = cat ? LOCAL_CATS.filter((c) => c.key === cat) : LOCAL_CATS;
    const out: { cat: string; file: string }[] = [];
    for (const c of cats) {
      for (const f of catFiles(models, c.key).sort((a, b) => a.localeCompare(b))) {
        if (needle && !f.toLowerCase().includes(needle)) continue;
        out.push({ cat: c.key, file: f });
      }
    }
    return out;
  }, [models, cat, q]);

  const total = [...counts.values()].reduce((s, n) => s + n, 0);

  return (
    <div className="ma-section">
      <div className="ma-filters at-card">
        <div className="ma-chips" role="group" aria-label="类目筛选">
          <button
            type="button"
            className={`ma-chip${cat === "" ? " is-active" : ""}`}
            onClick={() => setCat("")}
          >
            全部 <span className="ma-chip-n">{total}</span>
          </button>
          {LOCAL_CATS.map((c) => (
            <button
              key={c.key}
              type="button"
              className={`ma-chip${cat === c.key ? " is-active" : ""}`}
              onClick={() => setCat(c.key)}
            >
              {c.label} <span className="ma-chip-n">{counts.get(c.key) ?? 0}</span>
            </button>
          ))}
        </div>
        <input
          type="search"
          className="input ma-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索文件名…"
          aria-label="搜索本地模型文件名"
        />
      </div>

      <div className="at-card ma-card">
        {error && !loading && (
          <div className="ma-error-row">
            <ErrorBar message={error} onClose={() => setError(null)} />
            <button type="button" className="at-btn at-btn--ghost" onClick={load}>
              <Icon name="refresh" size={14} />
              重试
            </button>
          </div>
        )}

        {!error && loading && (
          <LoadingBlock variant="line" count={4} className="ma-loading" />
        )}

        {!error && !loading && rows.length === 0 && (
          <Empty
            size="section"
            icon="models"
            title={q ? "无匹配模型" : "本地模型为空"}
            desc={q ? "换个关键词试试" : "worker 尚未上报本地模型清单"}
          />
        )}

        {!error && !loading && rows.length > 0 && (
          <div className="ma-table-wrap">
            <table className="ma-table">
              <thead>
                <tr>
                  <th>文件名</th>
                  <th className="ma-col-cat">类目</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.cat}:${r.file}`}>
                    <td>
                      <span className="ma-file" title={r.file}>
                        {r.file}
                      </span>
                      {nsfwSet.has(r.file) && (
                        <span className="ma-flag ma-flag--nsfw" title="NSFW 模型">
                          18+
                        </span>
                      )}
                      {vpredSet.has(r.file) && (
                        <span className="ma-flag" title="V-Prediction 模型">
                          V-Pred
                        </span>
                      )}
                    </td>
                    <td className="ma-col-cat">
                      <span className="ma-dim">{LOCAL_CAT_LABEL[r.cat] ?? r.cat}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// b. 模型百科(wiki 卡 + Civitai 富化)
// ---------------------------------------------------------------------------

const WIKI_TYPES: { value: string; label: string }[] = [
  { value: "", label: "全部" },
  { value: "checkpoints", label: "底模" },
  { value: "loras", label: "LoRA" },
  { value: "vae", label: "VAE" },
  { value: "controlnet", label: "ControlNet" },
  { value: "upscale", label: "超分" },
];

function WikiSection({ showToast }: { showToast: (msg: string, tone?: "ok" | "err") => void }) {
  const [cards, setCards] = useState<ModelWikiCard[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [type, setType] = useState("");
  const [q, setQ] = useState("");
  const [qApplied, setQApplied] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null);

  const [enrichOpen, setEnrichOpen] = useState(false);
  const [enrichMax, setEnrichMax] = useState("40");
  const [enrichForce, setEnrichForce] = useState(false);
  const [enrichBusy, setEnrichBusy] = useState(false);

  // q 服务端模糊匹配:400ms 防抖,避免逐键发请求
  useEffect(() => {
    const t = setTimeout(() => setQApplied(q.trim()), 400);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    listModelWiki({ type: type || undefined, q: qApplied || undefined })
      .then(setCards)
      .catch((err) =>
        setError(err instanceof Error ? err.message : "加载模型百科失败"),
      )
      .finally(() => setLoading(false));
  }, [type, qApplied]);

  useEffect(() => {
    load();
  }, [load]);

  const runEnrich = async () => {
    const max = Math.max(1, Math.min(200, Number.parseInt(enrichMax, 10) || 40));
    setEnrichBusy(true);
    try {
      const r = await enrichModelWiki({ force: enrichForce, max });
      setEnrichOpen(false);
      showToast(`富化完成:成功 ${r.enriched} · 跳过 ${r.skipped} · 失败 ${r.failed}`);
      load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "富化失败", "err");
    } finally {
      setEnrichBusy(false);
    }
  };

  return (
    <div className="ma-section">
      <div className="ma-filters at-card">
        <div className="ma-chips" role="group" aria-label="类型筛选">
          {WIKI_TYPES.map((t) => (
            <button
              key={t.value}
              type="button"
              className={`ma-chip${type === t.value ? " is-active" : ""}`}
              onClick={() => setType(t.value)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <input
          type="search"
          className="input ma-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索文件名 / 名称 / 标签…"
          aria-label="搜索模型百科"
        />
        <button
          type="button"
          className="at-btn at-btn--primary ma-action"
          onClick={() => setEnrichOpen(true)}
        >
          <Icon name="sparkles" size={14} />
          Civitai 富化
        </button>
      </div>

      <div className="at-card ma-card">
        {error && !loading && (
          <div className="ma-error-row">
            <ErrorBar message={error} onClose={() => setError(null)} />
            <button type="button" className="at-btn at-btn--ghost" onClick={load}>
              <Icon name="refresh" size={14} />
              重试
            </button>
          </div>
        )}

        {!error && loading && (
          <LoadingBlock variant="line" count={4} className="ma-loading" />
        )}

        {!error && !loading && (cards?.length ?? 0) === 0 && (
          <Empty
            size="section"
            icon="library"
            title="无匹配卡片"
            desc={qApplied ? "换个关键词试试" : "模型百科暂无数据"}
          />
        )}

        {!error && !loading && (cards?.length ?? 0) > 0 && (
          <div className="ma-table-wrap">
            <table className="ma-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>文件名</th>
                  <th className="ma-col-base">基模</th>
                  <th className="ma-col-status">富化</th>
                  <th>触发词</th>
                  <th className="ma-col-creator">作者</th>
                </tr>
              </thead>
              <tbody>
                {(cards ?? []).map((c) => {
                  const key = `${c.filename}:${c.model_type}`;
                  const open = openKey === key;
                  return [
                    <tr
                      key={key}
                      className={c.has_detail ? "ma-row-click" : ""}
                      onClick={() => {
                        if (!c.has_detail) return;
                        setOpenKey(open ? null : key);
                      }}
                      title={c.has_detail ? (open ? "点击收起详情" : "点击展开详情") : "未富化,暂无详情"}
                    >
                      <td>
                        <span className="ma-name">
                          {c.has_detail && (
                            <Icon
                              name={open ? "chevron-down" : "chevron-right"}
                              size={12}
                            />
                          )}
                          {c.label || c.filename}
                        </span>
                        {c.nsfw && (
                          <span className="ma-flag ma-flag--nsfw">18+</span>
                        )}
                      </td>
                      <td>
                        <span className="ma-file" title={c.filename}>
                          {c.filename}
                        </span>
                      </td>
                      <td className="ma-col-base">
                        <span className="ma-dim">{c.base_model || "—"}</span>
                      </td>
                      <td className="ma-col-status">
                        <Badge tone={c.enriched ? "accent" : "neutral"} dot={false}>
                          {c.enriched ? "已富化" : "未富化"}
                        </Badge>
                      </td>
                      <td>
                        <span
                          className="ma-mono ma-dim"
                          title={c.trigger_words.join(", ")}
                        >
                          {c.trigger_words.length > 0
                            ? truncate(c.trigger_words.slice(0, 3).join(", "), 42)
                            : "—"}
                        </span>
                      </td>
                      <td className="ma-col-creator">
                        <span className="ma-dim" title={c.creator}>
                          {c.creator ? truncate(c.creator, 16) : "—"}
                        </span>
                      </td>
                    </tr>,
                    open ? (
                      <tr key={`${key}:detail`} className="ma-detail-row">
                        <td colSpan={6}>
                          <div className="ma-detail">
                            {c.description && (
                              <p className="ma-detail-p">
                                <span className="ma-detail-k">简介</span>
                                {c.description}
                              </p>
                            )}
                            {c.usage && (
                              <p className="ma-detail-p">
                                <span className="ma-detail-k">用法</span>
                                {c.usage}
                              </p>
                            )}
                            <p className="ma-detail-p ma-detail-meta">
                              {c.license && <span>许可 {c.license}</span>}
                              {c.tags.length > 0 && (
                                <span>标签 {c.tags.slice(0, 6).join(" / ")}</span>
                              )}
                              {c.civitai_url && (
                                <a
                                  href={c.civitai_url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="ma-link"
                                >
                                  <Icon name="link" size={12} />
                                  Civitai
                                </a>
                              )}
                            </p>
                          </div>
                        </td>
                      </tr>
                    ) : null,
                  ];
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Civitai 富化确认(max/force;结果经 toast 汇总并刷新列表) */}
      <Modal
        open={enrichOpen}
        onClose={() => setEnrichOpen(false)}
        title="Civitai 富化"
        preventClose={enrichBusy}
        width={420}
        footer={
          <>
            <button
              type="button"
              className="at-btn at-btn--ghost"
              disabled={enrichBusy}
              onClick={() => setEnrichOpen(false)}
            >
              取消
            </button>
            <button
              type="button"
              className="at-btn at-btn--primary"
              disabled={enrichBusy}
              onClick={() => void runEnrich()}
            >
              <Icon name={enrichBusy ? "loading" : "sparkles"} size={14} />
              {enrichBusy ? "富化中…" : "开始富化"}
            </button>
          </>
        }
      >
        <div className="ma-enrich-form">
          <label className="ma-field">
            <span className="ma-label">本次上限(1-200)</span>
            <input
              type="number"
              className="input"
              min={1}
              max={200}
              value={enrichMax}
              onChange={(e) => setEnrichMax(e.target.value)}
              disabled={enrichBusy}
            />
          </label>
          <Switch
            checked={enrichForce}
            onChange={setEnrichForce}
            disabled={enrichBusy}
            label="强制重查(忽略已富化缓存)"
            ariaLabel="强制重查"
          />
          <p className="ma-hint">
            按文件名序取未富化模型逐条查 Civitai(限速 1.2s/条),结果落库缓存;
            富化中请保持页面开启。
          </p>
        </div>
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// c. 引擎注册表(只读 + 手动重探测)
// ---------------------------------------------------------------------------

function EnginesSection({ showToast }: { showToast: (msg: string, tone?: "ok" | "err") => void }) {
  const [data, setData] = useState<EnginesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchEngines()
      .then(setData)
      .catch((err) =>
        setError(err instanceof Error ? err.message : "加载引擎注册表失败"),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      const r = await refreshEngines();
      setData(r);
      const ok = r.engines.filter((e) => e.available).length;
      showToast(`重探测完成:${r.count} 个引擎,${ok} 可用`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "引擎重探测失败", "err");
    } finally {
      setRefreshing(false);
    }
  };

  const okCount = data?.engines.filter((e) => e.available).length ?? 0;

  return (
    <div className="ma-section">
      <div className="ma-filters at-card">
        <span className="ma-section-note">
          {loading
            ? "加载中…"
            : `共 ${data?.count ?? 0} 个引擎 · ${okCount} 可用`}
        </span>
        <button
          type="button"
          className="at-btn at-btn--ghost ma-action"
          disabled={refreshing}
          onClick={() => void onRefresh()}
        >
          <Icon name={refreshing ? "loading" : "refresh"} size={14} />
          {refreshing ? "重探测中…" : "手动重探测"}
        </button>
      </div>

      <div className="at-card ma-card">
        {error && !loading && (
          <div className="ma-error-row">
            <ErrorBar message={error} onClose={() => setError(null)} />
            <button type="button" className="at-btn at-btn--ghost" onClick={load}>
              <Icon name="refresh" size={14} />
              重试
            </button>
          </div>
        )}

        {!error && loading && (
          <LoadingBlock variant="line" count={4} className="ma-loading" />
        )}

        {!error && !loading && (data?.engines.length ?? 0) === 0 && (
          <Empty
            size="section"
            icon="cpu"
            title="引擎注册表为空"
            desc="后端尚未注册任何生成引擎"
          />
        )}

        {!error && !loading && (data?.engines.length ?? 0) > 0 && (
          <div className="ma-table-wrap">
            <table className="ma-table">
              <thead>
                <tr>
                  <th className="ma-col-id">ID</th>
                  <th>名称</th>
                  <th className="ma-col-cat">类型</th>
                  <th className="ma-col-status">可用性</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {(data?.engines ?? []).map((e) => (
                  <tr key={e.id}>
                    <td className="ma-col-id">
                      <span className="ma-mono">{e.id}</span>
                    </td>
                    <td>
                      <span className="ma-name">{e.label}</span>
                      {e.nsfw && <span className="ma-flag ma-flag--nsfw">18+</span>}
                    </td>
                    <td className="ma-col-cat">
                      <span className="ma-dim">{e.kind}</span>
                    </td>
                    <td className="ma-col-status">
                      <Badge
                        tone={e.available ? "ok" : "err"}
                        title={e.available ? undefined : (e.unavailable_reason ?? "不可用")}
                      >
                        {e.available ? "可用" : "不可用"}
                      </Badge>
                      {!e.available && e.unavailable_reason && (
                        <span className="ma-reason" title={e.unavailable_reason}>
                          {truncate(e.unavailable_reason, 36)}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className="ma-dim" title={e.description ?? ""}>
                        {e.description ? truncate(e.description, 48) : "—"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// d. MODEL_SOURCES 只读视图
// ---------------------------------------------------------------------------

type SourceStatusFilter = "" | "ok" | "blocked";

function SourcesSection() {
  const [data, setData] = useState<ModelSourcesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SourceStatusFilter>("");
  const [q, setQ] = useState("");
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchModelSources()
      .then(setData)
      .catch((err) =>
        setError(err instanceof Error ? err.message : "加载模型出处清单失败"),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 筛选变化回到截断态,避免「显示全部」残留误导计数
  useEffect(() => {
    setShowAll(false);
  }, [status, q]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.items ?? []).filter((it) => {
      if (status && it.status !== status) return false;
      if (needle && !it.basename.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [data, status, q]);

  const visible = showAll ? filtered : filtered.slice(0, SOURCES_DEFAULT_ROWS);
  const totals = data?.totals ?? {};

  return (
    <div className="ma-section">
      <div className="ma-stats">
        <div className="ma-stat at-card">
          <span className="ma-stat-label">已入库</span>
          <span className="ma-stat-value ma-stat-ok">{totals.ok ?? "—"}</span>
          <span className="ma-stat-hint">status = ok</span>
        </div>
        <div className="ma-stat at-card">
          <span className="ma-stat-label">受阻</span>
          <span className="ma-stat-value ma-stat-err">{totals.blocked ?? "—"}</span>
          <span className="ma-stat-hint">status = blocked</span>
        </div>
        <div className="ma-stat at-card">
          <span className="ma-stat-label">总计</span>
          <span className="ma-stat-value">{totals.total ?? "—"}</span>
          <span className="ma-stat-hint">
            {data ? `更新于 ${formatTime(data.updated_at)}` : "模型出处条目"}
          </span>
        </div>
      </div>

      <div className="ma-filters at-card">
        <div className="ma-chips" role="group" aria-label="状态筛选">
          {(
            [
              { value: "", label: "全部" },
              { value: "ok", label: "ok" },
              { value: "blocked", label: "blocked" },
            ] as { value: SourceStatusFilter; label: string }[]
          ).map((o) => (
            <button
              key={o.value}
              type="button"
              className={`ma-chip${status === o.value ? " is-active" : ""}`}
              onClick={() => setStatus(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
        <input
          type="search"
          className="input ma-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索文件名(basename)…"
          aria-label="搜索出处文件名"
        />
        <span className="ma-section-note">
          {loading ? "" : `${filtered.length} / ${data?.items.length ?? 0} 条`}
        </span>
      </div>

      <div className="at-card ma-card">
        {error && !loading && (
          <div className="ma-error-row">
            <ErrorBar message={error} onClose={() => setError(null)} />
            <button type="button" className="at-btn at-btn--ghost" onClick={load}>
              <Icon name="refresh" size={14} />
              重试
            </button>
          </div>
        )}

        {!error && loading && (
          <LoadingBlock variant="line" count={4} className="ma-loading" />
        )}

        {!error && !loading && filtered.length === 0 && (
          <Empty
            size="section"
            icon="filejson"
            title="无匹配条目"
            desc={q || status ? "试试放宽筛选条件" : "出处清单为空"}
          />
        )}

        {!error && !loading && filtered.length > 0 && (
          <>
            <div className="ma-table-wrap">
              <table className="ma-table">
                <thead>
                  <tr>
                    <th>文件名</th>
                    <th className="ma-col-status">状态</th>
                    <th>来源</th>
                    <th>仓库</th>
                    <th className="ma-col-time">下载时间</th>
                    <th>备注</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((it: ModelSourceItem, i) => (
                    <tr key={`${it.basename}:${i}`}>
                      <td>
                        <span className="ma-file" title={it.rel_path ?? it.basename}>
                          {it.basename}
                        </span>
                      </td>
                      <td className="ma-col-status">
                        <Badge
                          tone={it.status === "ok" ? "ok" : it.status === "blocked" ? "err" : "neutral"}
                          dot={false}
                        >
                          {it.status ?? "—"}
                        </Badge>
                      </td>
                      <td>
                        {it.source_url ? (
                          <a
                            href={it.source_url}
                            target="_blank"
                            rel="noreferrer"
                            className="ma-link"
                            title={it.source_url}
                          >
                            <Icon name="link" size={12} />
                            {truncate(it.source_url.replace(/^https?:\/\//, ""), 32)}
                          </a>
                        ) : (
                          <span className="ma-dim">—</span>
                        )}
                      </td>
                      <td>
                        <span className="ma-mono ma-dim" title={it.repo ?? ""}>
                          {it.repo ? truncate(it.repo, 28) : "—"}
                        </span>
                      </td>
                      <td className="ma-col-time">
                        <span className="ma-dim ma-nowrap" title={it.downloaded_at ?? ""}>
                          {formatTime(it.downloaded_at)}
                        </span>
                      </td>
                      <td>
                        <span className="ma-dim" title={it.notes ?? ""}>
                          {it.notes ? truncate(it.notes, 60) : "—"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!showAll && filtered.length > SOURCES_DEFAULT_ROWS && (
              <div className="ma-more-row">
                <button
                  type="button"
                  className="at-btn at-btn--ghost"
                  onClick={() => setShowAll(true)}
                >
                  <Icon name="plus" size={14} />
                  显示全部 {filtered.length} 条(当前 {SOURCES_DEFAULT_ROWS})
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// D2 模型资产域(2026-09-22):四区块 tab 化(信息密度优先)
// ---------------------------------------------------------------------------

export function ModelAssetsAdminView() {
  const [section, setSection] = useState<MaSection>("local");
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string, tone: "ok" | "err" = "ok") => {
    setToast({ msg, tone });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  return (
    <div className="ma-view">
      <PageHeader
        title="模型资产"
        desc="本地模型清单 · 模型百科 · 引擎注册表 · MODEL_SOURCES 出处"
      />
      <div className="ma-tabs">
        <Tabs
          items={[
            { key: "local", label: "本地清单", icon: <Icon name="database" size={14} /> },
            { key: "wiki", label: "模型百科", icon: <Icon name="library" size={14} /> },
            { key: "engines", label: "引擎注册表", icon: <Icon name="cpu" size={14} /> },
            { key: "sources", label: "出处清单", icon: <Icon name="filejson" size={14} /> },
          ]}
          current={section}
          onChange={(k) => setSection(k as MaSection)}
          ariaLabel="模型资产分区"
        />
      </div>

      {section === "local" && <LocalModelsSection />}
      {section === "wiki" && <WikiSection showToast={showToast} />}
      {section === "engines" && <EnginesSection showToast={showToast} />}
      {section === "sources" && <SourcesSection />}

      {toast && <div className={`ma-toast ${toast.tone}`}>{toast.msg}</div>}

      <style jsx global>{`
        .ma-view {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
        }
        .ma-tabs {
          align-self: flex-start;
        }
        .ma-section {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
        }

        .ma-filters {
          display: flex;
          align-items: center;
          gap: var(--space-3);
          padding: var(--space-3);
          flex-wrap: wrap;
        }
        .ma-chips {
          display: inline-flex;
          align-items: center;
          flex-wrap: wrap;
          gap: var(--space-2);
        }
        .ma-chip {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          min-height: 26px;
          padding: 0 var(--space-3);
          border-radius: var(--radius-full);
          border: 1px solid var(--border-subtle);
          background: transparent;
          color: var(--text-secondary);
          font-size: var(--text-aux);
          font-weight: var(--font-medium);
          cursor: pointer;
          white-space: nowrap;
          transition: border-color var(--duration-fast) var(--ease-standard),
            color var(--duration-fast) var(--ease-standard),
            background-color var(--duration-fast) var(--ease-standard);
        }
        .ma-chip:hover {
          border-color: var(--border-strong);
          color: var(--text-primary);
        }
        .ma-chip.is-active {
          background: var(--accent-soft);
          border-color: var(--accent);
          color: var(--text-primary);
        }
        .ma-chip-n {
          font-family: var(--font-mono);
          font-size: var(--text-label);
          color: var(--text-muted);
          font-variant-numeric: tabular-nums;
        }
        .ma-search {
          flex: 1 1 220px;
          min-width: 160px;
        }
        .ma-action {
          margin-left: auto;
          flex-shrink: 0;
        }
        .ma-section-note {
          margin-left: auto;
          font-size: var(--text-aux);
          color: var(--text-muted);
          font-family: var(--font-mono);
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
        }
        .ma-action ~ .ma-section-note,
        .ma-section-note:first-child {
          margin-left: 0;
        }

        .ma-stats {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
          gap: var(--space-3);
        }
        .ma-stat {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
          padding: var(--space-4);
        }
        .ma-stat-label {
          font-size: var(--text-label);
          font-weight: var(--font-medium);
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--text-muted);
        }
        .ma-stat-value {
          font-size: var(--text-display-md);
          font-weight: var(--font-bold);
          font-family: var(--font-mono);
          letter-spacing: -0.02em;
          line-height: 1.2;
          color: var(--text-primary);
          font-variant-numeric: tabular-nums;
        }
        .ma-stat-value.ma-stat-ok {
          color: var(--ok);
        }
        .ma-stat-value.ma-stat-err {
          color: var(--err);
        }
        .ma-stat-hint {
          font-size: var(--text-aux);
          color: var(--text-muted);
        }

        .ma-card {
          padding: 0;
          overflow: hidden;
        }
        .ma-loading {
          padding: var(--space-4);
        }
        .ma-error-row {
          display: flex;
          align-items: center;
          gap: var(--space-3);
          padding: var(--space-4) var(--space-5);
        }
        .ma-error-row .ui-error-bar {
          flex: 1;
          min-width: 0;
        }

        .ma-table-wrap {
          overflow-x: auto;
        }
        @media (max-width: 767px) {
          .ma-table-wrap {
            -webkit-mask-image: linear-gradient(to right, black calc(100% - 32px), transparent);
            mask-image: linear-gradient(to right, black calc(100% - 32px), transparent);
          }
          .ma-table {
            min-width: 760px;
          }
        }
        .ma-table {
          width: 100%;
          border-collapse: collapse;
          font-size: var(--text-body);
        }
        .ma-table thead th {
          text-align: left;
          padding: var(--space-3) var(--space-4);
          font-size: var(--text-label);
          font-weight: var(--font-medium);
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--text-muted);
          background: var(--bg-surface-2);
          border-bottom: 1px solid var(--border-strong);
          white-space: nowrap;
        }
        .ma-table tbody td {
          padding: var(--space-3) var(--space-4);
          border-bottom: 1px solid var(--border-subtle);
          vertical-align: middle;
          color: var(--text-secondary);
        }
        .ma-table tbody tr {
          transition: background-color var(--duration-fast) var(--ease-standard);
        }
        .ma-table tbody tr:nth-child(even) {
          background: var(--bg-surface-2);
        }
        .ma-table tbody tr:hover {
          background: var(--accent-soft);
        }
        .ma-table tbody tr:last-child td {
          border-bottom: none;
        }
        .ma-table tbody tr.ma-row-click {
          cursor: pointer;
        }
        .ma-table tbody tr.ma-detail-row,
        .ma-table tbody tr.ma-detail-row:hover {
          background: var(--bg-surface-1);
          cursor: default;
        }

        .ma-col-cat {
          width: 110px;
          white-space: nowrap;
        }
        .ma-col-base {
          width: 120px;
        }
        .ma-col-status {
          width: 120px;
          white-space: nowrap;
        }
        .ma-col-creator {
          width: 120px;
        }
        .ma-col-id {
          width: 170px;
        }
        .ma-col-time {
          width: 110px;
          white-space: nowrap;
        }

        .ma-name {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          color: var(--text-primary);
          font-weight: var(--font-medium);
        }
        .ma-file {
          font-family: var(--font-mono);
          font-size: var(--text-aux);
          color: var(--text-primary);
          word-break: break-all;
        }
        .ma-mono {
          font-family: var(--font-mono);
          font-size: var(--text-aux);
        }
        .ma-dim {
          color: var(--text-muted);
          font-size: var(--text-aux);
        }
        .ma-nowrap {
          white-space: nowrap;
        }
        .ma-reason {
          display: block;
          margin-top: 2px;
          font-size: var(--text-label);
          color: var(--err);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          max-width: 220px;
        }
        .ma-flag {
          display: inline-flex;
          align-items: center;
          margin-left: var(--space-2);
          padding: 0 var(--space-2);
          border-radius: var(--radius-badge);
          border: 1px solid var(--border-strong);
          color: var(--text-secondary);
          font-size: var(--text-label);
          font-weight: var(--font-medium);
          letter-spacing: 0.04em;
          white-space: nowrap;
          vertical-align: middle;
        }
        .ma-flag--nsfw {
          border-color: var(--err);
          color: var(--err);
        }
        .ma-link {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          color: var(--accent);
          font-size: var(--text-aux);
          text-decoration: none;
          white-space: nowrap;
        }
        .ma-link:hover {
          text-decoration: underline;
        }

        .ma-detail {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
          padding: var(--space-2) var(--space-2) var(--space-3);
        }
        .ma-detail-p {
          margin: 0;
          font-size: var(--text-aux);
          color: var(--text-secondary);
          line-height: 1.6;
        }
        .ma-detail-k {
          display: inline-block;
          margin-right: var(--space-2);
          color: var(--text-muted);
          font-weight: var(--font-medium);
        }
        .ma-detail-meta {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: var(--space-3);
          color: var(--text-muted);
        }

        .ma-more-row {
          display: flex;
          justify-content: center;
          padding: var(--space-3);
          border-top: 1px solid var(--border-subtle);
        }

        .ma-enrich-form {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
          padding: var(--space-4);
        }
        .ma-field {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
        }
        .ma-label {
          font-size: var(--text-aux);
          color: var(--text-secondary);
          font-weight: var(--font-medium);
        }
        .ma-hint {
          margin: 0;
          font-size: var(--text-aux);
          color: var(--text-muted);
          line-height: 1.55;
        }

        .ma-toast {
          position: fixed;
          right: 20px;
          bottom: 20px;
          z-index: var(--z-toast);
          max-width: 420px;
          padding: 10px 16px;
          border-radius: var(--radius-panel);
          background: var(--bg-surface-1);
          border: 1px solid var(--border-subtle);
          color: var(--text-primary);
          font-size: var(--text-aux);
          box-shadow: var(--shadow-pop);
        }
        .ma-toast.ok {
          border-color: var(--ok);
        }
        .ma-toast.err {
          border-color: var(--err);
          color: var(--err);
        }
      `}</style>
    </div>
  );
}
