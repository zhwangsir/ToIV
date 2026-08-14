"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getNasDownloadStatus,
  installModel,
  listLocalModels,
  searchMarketplace,
  type InstallModelParams,
  type InstallModelResult,
} from "@/lib/api";
import type { LocalModels, MarketItem } from "@/lib/types";
import { Icon } from "@/components/ui/Icon";
import { Tabs } from "@/components/ui/Tabs";
import { NsfwRecsPanel } from "@/components/models/NsfwRecsPanel";
import { useR18Mode } from "@/lib/r18";
import { usePoll } from "@/hooks/usePoll";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { LoadingBlock } from "@/components/ui/LoadingBlock";

type Tab = "local" | "market" | "r18";

/** 单个市场模型的安装状态(下载走 NAS 作业,jobId 轮询进度)。 */
type InstallState = {
  status: "installing" | "success" | "error";
  message?: string;
  jobId?: string;
  progress?: number;
};

/** 本地模型目录键 → 中文标签(后端目录名通常为复数小写)。 */
const TYPE_LABELS: Record<string, string> = {
  checkpoints: "底模",
  checkpoint: "底模",
  loras: "LoRA",
  lora: "LoRA",
  vae: "VAE",
  vaes: "VAE",
  embeddings: "嵌入向量",
  embedding: "嵌入向量",
  textual_inversions: "嵌入向量",
  controlnet: "ControlNet",
  controlnets: "ControlNet",
  upscale_models: "放大模型",
  upscale: "放大模型",
  upscalers: "放大模型",
  clip: "CLIP",
  clips: "CLIP",
  clip_vision: "CLIP Vision",
  unet: "UNet",
  unets: "UNet",
  gligen: "GLIGEN",
  style_models: "风格模型",
  hypernetworks: "Hypernetwork",
  hypernetwork: "Hypernetwork",
  detectors: "检测器",
  sam: "SAM",
  vibe: "Vibe",
};

function typeLabel(key: string): string {
  return TYPE_LABELS[key] ?? key;
}

function fileExt(name: string): string {
  // 防御:后端 LocalModels 含 checkpoints_tagged 等非字符串字段,统一转字符串
  const s = typeof name === "string" ? name : String(name ?? "");
  const i = s.lastIndexOf(".");
  return i >= 0 ? s.slice(i + 1).toLowerCase() : "";
}

function formatDownloads(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

const MARKET_TYPES: { value: string; label: string }[] = [
  { value: "", label: "全部类型" },
  { value: "Checkpoint", label: "底模" },
  { value: "LORA", label: "LoRA" },
  { value: "LoCon", label: "LyCORIS" },
  { value: "Controlnet", label: "ControlNet" },
  { value: "Upscaler", label: "放大模型" },
  { value: "VAE", label: "VAE" },
  { value: "TextualInversion", label: "嵌入向量" },
  { value: "Hypernetwork", label: "Hypernetwork" },
];

export function ModelsView() {
  const [tab, setTab] = useState<Tab>("local");
  // M9:R18 全局内容模式,仅开启时显示「R18 推荐」tab
  const [r18] = useR18Mode();

  // 防御:R18 关闭时若仍停留在 r18 tab,回退到第一个 tab
  useEffect(() => {
    if (!r18 && tab === "r18") setTab("local");
  }, [r18, tab]);

  // ---- 本地模型 ----
  const [localModels, setLocalModels] = useState<LocalModels | null>(null);
  const [localLoading, setLocalLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [localQuery, setLocalQuery] = useState("");

  const loadLocal = useCallback(async () => {
    setLocalLoading(true);
    setLocalError(null);
    try {
      const data = await listLocalModels();
      setLocalModels(data);
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "加载本地模型失败");
    } finally {
      setLocalLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLocal();
  }, [loadLocal]);

  const filteredGroups = useMemo(() => {
    if (!localModels) return [];
    const q = localQuery.trim().toLowerCase();
    // 过滤掉非字符串数组的字段(如 checkpoints_tagged 是对象数组,不在本地模型列表展示)
    const MODEL_GROUP_KEYS = ["checkpoints", "loras", "vae", "controlnet", "upscale"];
    return Object.entries(localModels)
      .filter(([type, files]) => MODEL_GROUP_KEYS.includes(type) && Array.isArray(files) && files.every((f) => typeof f === "string"))
      .map(([type, files]) => {
        const typedFiles = files as string[];
        const filtered = q ? typedFiles.filter((f) => f.toLowerCase().includes(q)) : typedFiles;
        return { type, files: filtered, total: typedFiles.length };
      })
      .filter((g) => g.files.length > 0)
      .sort((a, b) => a.type.localeCompare(b.type));
  }, [localModels, localQuery]);

  const totalCount = useMemo(() => {
    if (!localModels) return 0;
    // 仅统计字符串数组字段,排除对象数组(checkpoints_tagged 等)
    const MODEL_GROUP_KEYS = ["checkpoints", "loras", "vae", "controlnet", "upscale"];
    return MODEL_GROUP_KEYS.reduce((s, k) => {
      const arr = localModels[k];
      return s + (Array.isArray(arr) ? arr.length : 0);
    }, 0);
  }, [localModels]);

  // ---- 在线市场 ----
  const [marketQuery, setMarketQuery] = useState("");
  const [marketType, setMarketType] = useState("");
  const [marketItems, setMarketItems] = useState<MarketItem[]>([]);
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [failedThumbs, setFailedThumbs] = useState<Set<string>>(new Set());
  // 市场模型安装状态:id → 状态
  const [installState, setInstallState] = useState<Record<string, InstallState>>({});

  const runSearch = useCallback(async () => {
    const q = marketQuery.trim();
    if (!q) return;
    setMarketLoading(true);
    setMarketError(null);
    try {
      const res = await searchMarketplace("civitai", q, marketType || undefined);
      setMarketItems(res.items);
      setFailedThumbs(new Set());
      setHasSearched(true);
    } catch (e) {
      setMarketError(e instanceof Error ? e.message : "搜索失败");
      setMarketItems([]);
      setHasSearched(true);
    } finally {
      setMarketLoading(false);
    }
  }, [marketQuery, marketType]);

  const onMarketKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void runSearch();
    }
  };

  const markThumbFailed = (id: string) =>
    setFailedThumbs((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });

  // 安装市场模型:创建 NAS 下载作业 → 返回 job_id,进度由下方 usePoll 统一跟踪
  const installOne = useCallback(async (m: MarketItem) => {
    setInstallState((prev) => ({
      ...prev,
      [m.id]: { status: "installing", message: "正在创建下载任务…" },
    }));
    try {
      const params: InstallModelParams = {
        type: m.type ?? "",
        source: m.source,
        id: m.id,
        url: m.url,
        name: m.name,
      };
      const res: InstallModelResult = await installModel(params);
      setInstallState((prev) => ({
        ...prev,
        [m.id]: {
          status: "installing",
          jobId: res.job_id,
          progress: 0,
          message: res.message ?? "下载已开始",
        },
      }));
    } catch (e) {
      setInstallState((prev) => ({
        ...prev,
        [m.id]: {
          status: "error",
          message: e instanceof Error ? e.message : "安装失败",
        },
      }));
    }
  }, []);

  // 轮询所有进行中的 NAS 下载作业;有完成项时刷新本地模型列表
  const hasInstalling = useMemo(
    () =>
      Object.values(installState).some(
        (s) => s.status === "installing" && s.jobId,
      ),
    [installState],
  );

  usePoll(
    useCallback(async () => {
      const pending = Object.entries(installState).filter(
        ([, s]) => s.status === "installing" && s.jobId,
      );
      if (pending.length === 0) return;
      const results = await Promise.allSettled(
        pending.map(([, s]) => getNasDownloadStatus(s.jobId as string)),
      );
      const updates: Record<string, InstallState> = {};
      let anyDone = false;
      pending.forEach(([id], i) => {
        const r = results[i];
        if (r.status !== "fulfilled") return; // 单次查询失败等下轮(backoff 由 usePoll 负责)
        const st = r.value;
        if (st.status === "done") {
          anyDone = true;
          updates[id] = {
            status: "success",
            progress: 100,
            message: `已下载到 NAS:${st.filename}(${st.downloaded_mb}MB)`,
          };
        } else if (st.status === "error") {
          updates[id] = {
            status: "error",
            message: st.error ?? "下载失败",
          };
        } else {
          updates[id] = {
            status: "installing",
            jobId: st.id,
            progress: st.progress,
            message: `${st.stage} ${st.progress}%`,
          };
        }
      });
      if (Object.keys(updates).length > 0) {
        setInstallState((prev) => ({ ...prev, ...updates }));
      }
      if (anyDone) void loadLocal();
    }, [installState, loadLocal]),
    { intervalMs: 2000, enabled: hasInstalling, backoff: true },
  );

  return (
    <div className="single-view models-view">
      <header className="page-header">
        <div>
          <h1 className="page-header-title">模型库</h1>
          <p className="page-header-desc">管理本地已安装模型 · 探索 Civitai 在线市场</p>
        </div>
        <div className="page-header-actions">
          <Tabs
            items={[
              { key: "local", label: "本地模型", icon: <Icon name="models" size={14} /> },
              { key: "market", label: "在线市场", icon: <Icon name="search" size={14} /> },
              // M9:R18 推荐 tab 仅 R18 模式渲染;SFW 模式连 tab 头都不出现
              ...(r18
                ? [
                    {
                      key: "r18",
                      label: (
                        <>
                          R18 推荐
                          <span className="mv-tab-r18-badge">18+</span>
                        </>
                      ),
                      icon: <Icon name="lock" size={14} />,
                    },
                  ]
                : []),
            ]}
            current={tab}
            onChange={(k) => setTab(k as Tab)}
            ariaLabel="模型库视图切换"
          />
        </div>
      </header>

      {tab === "local" ? (
        <section className="mv-panel">
          <div className="mv-toolbar">
            <div className="mv-search">
              <span className="mv-search-icon">
                <Icon name="search" size={15} />
              </span>
              <input
                className="input mv-search-input"
                placeholder="过滤本地模型文件名…"
                value={localQuery}
                onChange={(e) => setLocalQuery(e.target.value)}
                aria-label="过滤本地模型"
              />
            </div>
            <div className="mv-toolbar-right">
              {/* 始终渲染以预留宽度,避免加载完成后插入导致工具栏位移(CLS) */}
              <span
                className="mv-stat"
                style={{ visibility: totalCount > 0 ? "visible" : "hidden" }}
                aria-hidden={totalCount === 0}
              >
                {totalCount > 0 ? `${totalCount} 个模型` : "0 个模型"}
              </span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void loadLocal()}
                disabled={localLoading}
              >
                <Icon name="refresh" size={14} />
                刷新
              </button>
            </div>
          </div>

          {localLoading && !localModels ? (
            /* 加载态(UI-A LoadingBlock):行骨架微光;mv-center 预留高度防 CLS */
            <div className="mv-center">
              <LoadingBlock variant="line" count={5} />
            </div>
          ) : localError ? (
            <div className="mv-center mv-error-box">
              {/* 错误态(UI-A ErrorBar):role=alert + 可关闭;重试保留在条外 */}
              <ErrorBar message={localError} onClose={() => setLocalError(null)} />
              <button type="button" className="btn btn-sm" onClick={() => void loadLocal()}>
                重试
              </button>
            </div>
          ) : filteredGroups.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">
                <Icon name="models" size={44} strokeWidth={1.2} />
              </div>
              <div className="empty-state-title">
                {localQuery ? "未匹配到本地模型" : "本地暂无已安装模型"}
              </div>
              <div className="empty-state-desc">
                {localQuery
                  ? "尝试更换关键词，或清空过滤查看全部"
                  : "前往「在线市场」搜索并安装模型"}
              </div>
            </div>
          ) : (
            <div className="mv-groups">
              {filteredGroups.map((g) => (
                <div className="card mv-group" key={g.type}>
                  <div className="mv-group-header">
                    <div className="mv-group-title-wrap">
                      <span className="mv-group-title">{typeLabel(g.type)}</span>
                      <span className="mv-group-key">{g.type}</span>
                    </div>
                    <span className="badge badge-accent">
                      {g.files.length}
                      {g.total !== g.files.length ? ` / ${g.total}` : ""}
                    </span>
                  </div>
                  <ul className="mv-model-list">
                    {g.files.map((f) => {
                      const ext = fileExt(f);
                      return (
                        <li className="mv-model-row" key={`${g.type}/${f}`}>
                          <span className="mv-model-file-icon">
                            <Icon name="file" size={14} />
                          </span>
                          <span className="mv-model-name" title={f}>
                            {f}
                          </span>
                          {ext && <span className="mv-model-ext">{ext}</span>}
                          <span className="badge mv-model-type">{typeLabel(g.type)}</span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>
      ) : tab === "market" ? (
        <section className="mv-panel">
          <div className="mv-toolbar">
            <div className="mv-search mv-search-lg">
              <span className="mv-search-icon">
                <Icon name="search" size={16} />
              </span>
              <input
                className="input mv-search-input"
                placeholder="搜索 Civitai：如 anime pastel mix、controlnet depth…"
                value={marketQuery}
                onChange={(e) => setMarketQuery(e.target.value)}
                onKeyDown={onMarketKey}
                aria-label="搜索 Civitai 市场"
              />
            </div>
            <select
              className="input mv-type-select"
              value={marketType}
              onChange={(e) => setMarketType(e.target.value)}
              aria-label="模型类型筛选"
            >
              {MARKET_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void runSearch()}
              disabled={marketLoading || !marketQuery.trim()}
            >
              <Icon name="search" size={14} />
              搜索
            </button>
          </div>

          {marketLoading ? (
            /* 加载态(UI-A LoadingBlock grid):3:4 卡片骨架,版式与真实市场卡对齐 */
            <div className="mv-center">
              <LoadingBlock variant="grid" count={6} className="mv-market-loading" />
            </div>
          ) : marketError ? (
            <div className="mv-center mv-error-box">
              {/* 错误态(UI-A ErrorBar):role=alert + 可关闭;重试保留在条外 */}
              <ErrorBar message={marketError} onClose={() => setMarketError(null)} />
              <button type="button" className="btn btn-sm" onClick={() => void runSearch()}>
                重试
              </button>
            </div>
          ) : marketItems.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">
                <Icon name="search" size={44} strokeWidth={1.2} />
              </div>
              <div className="empty-state-title">
                {hasSearched ? "未找到匹配的模型" : "搜索 Civitai 在线市场"}
              </div>
              <div className="empty-state-desc">
                {hasSearched
                  ? "换个关键词或调整类型筛选再试试"
                  : "输入模型名称、风格或关键词，发现社区精选模型"}
              </div>
            </div>
          ) : (
            <>
              <div className="mv-result-meta">
                共 {marketItems.length} 个结果 · 来源 Civitai
              </div>
              <div className="mv-market-grid">
                {marketItems.map((m) => {
                  const thumbOk = m.thumbnail && !failedThumbs.has(m.id);
                  const inst = installState[m.id];
                  return (
                    <div className="card mv-card" key={`${m.source}/${m.id}`}>
                      <a
                        className="mv-card-thumb"
                        href={m.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`在 Civitai 查看 ${m.name}`}
                      >
                        {thumbOk ? (
                          <img
                            src={m.thumbnail as string}
                            alt={m.name}
                            loading="lazy"
                            onError={() => markThumbFailed(m.id)}
                          />
                        ) : (
                          <div className="mv-card-thumb-placeholder">
                            <Icon name="image" size={26} strokeWidth={1.4} />
                          </div>
                        )}
                        {m.type && <span className="mv-card-type">{m.type}</span>}
                        <span className="mv-card-open">
                          <Icon name="link" size={14} />
                        </span>
                      </a>
                      <div className="mv-card-body">
                        <h3 className="mv-card-name" title={m.name}>
                          {m.name}
                        </h3>
                        <div className="mv-card-meta">
                          <span className="mv-card-creator">
                            {m.creator ?? "未知作者"}
                          </span>
                          <span className="mv-card-dl">
                            <Icon name="download" size={12} />
                            {formatDownloads(m.downloads)}
                          </span>
                        </div>
                        <div className="mv-card-actions">
                          <a
                            className="btn btn-sm mv-card-link"
                            href={m.url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <Icon name="link" size={12} strokeWidth={1.9} />
                            在 Civitai 查看
                          </a>
                          <button
                            type="button"
                            className="btn btn-sm btn-primary mv-card-install"
                            onClick={() => void installOne(m)}
                            disabled={
                              inst?.status === "installing" ||
                              inst?.status === "success"
                            }
                          >
                            <Icon
                              name={
                                inst?.status === "installing"
                                  ? "loading"
                                  : inst?.status === "success"
                                  ? "success"
                                  : inst?.status === "error"
                                  ? "error"
                                  : "download"
                              }
                              size={12}
                              strokeWidth={1.9}
                            />
                            {inst?.status === "installing"
                              ? inst.progress
                                ? `下载中 ${inst.progress}%`
                                : "下载中"
                              : inst?.status === "success"
                              ? "已安装"
                              : inst?.status === "error"
                              ? "重试"
                              : "安装到本地"}
                          </button>
                        </div>
                        {inst?.message && (
                          <div className={`mv-card-msg is-${inst.status}`}>
                            {inst.message}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </section>
      ) : r18 ? (
        /* M9:R18 推荐面板(自 /nsfw 专区迁移,自包含加载/下载/轮询/样式) */
        <NsfwRecsPanel />
      ) : null}

      <style jsx>{`
        .models-view {
          padding-top: var(--space-4);
        }

        /* R18 推荐 tab 的 18+ 徽标:红底白字圆角胶囊 */
        .mv-tab-r18-badge {
          margin-left: var(--space-1);
          padding: 1px var(--space-1);
          background: var(--err);
          color: var(--text-on-accent);
          border-radius: var(--radius-full);
          font-size: var(--text-aux);
          font-weight: var(--font-semibold);
          line-height: 1.2;
        }

        /* 页头由全局 .page-header / .page-header-title / .page-header-desc /
           .page-header-actions 统一提供(globals.css),含桌面端 CornerNav 避让 */

        .mv-panel {
          display: flex;
          flex-direction: column;
          gap: var(--space-5);
        }

        /* 工具栏面板化:搜索/筛选/统计聚合为一条独立面板,与下方内容拉开层级 */
        .mv-toolbar {
          display: flex;
          align-items: center;
          gap: var(--space-3);
          flex-wrap: wrap;
          background: var(--bg-surface-1);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-panel);
          padding: var(--space-3) var(--space-4);
        }

        .mv-search {
          position: relative;
          flex: 1;
          min-width: 220px;
        }
        .mv-search-lg {
          min-width: 280px;
        }

        .mv-search-icon {
          position: absolute;
          left: var(--space-3);
          top: 50%;
          transform: translateY(-50%);
          color: var(--text-muted);
          pointer-events: none;
          display: inline-flex;
        }

        .mv-search-input {
          /* 图标 12px 左距 + 16px 图标位 + 8px 呼吸 */
          padding-left: calc(var(--space-3) + 16px + var(--space-2));
        }

        .mv-toolbar-right {
          display: inline-flex;
          align-items: center;
          gap: var(--space-3);
          margin-left: auto;
        }

        .mv-stat {
          font-size: var(--text-aux);
          color: var(--text-muted);
          font-family: var(--font-mono);
        }

        .mv-type-select {
          width: auto;
          min-width: 132px;
          cursor: pointer;
          padding-right: var(--space-6);
        }

        .mv-center {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: var(--space-3);
          padding: var(--space-6) var(--space-4);
          /* 加载/错误态预留稳定高度,降低内容到达时的布局偏移(CLS) */
          min-height: 256px;
          text-align: center;
        }

        /* 错误态面板化:独立卡片承载 UI-A ErrorBar(role=alert + 可关闭),不再裸文本悬浮 */
        .mv-error-box {
          color: var(--err);
          background: var(--bg-surface-1);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-panel);
        }
        /* ErrorBar 在居中卡片内限宽、左对齐(长错误文案不撑爆面板) */
        .mv-error-box :global(.ui-error-bar) {
          width: 100%;
          max-width: 560px;
          text-align: left;
        }
        /* 市场加载骨架(UI-A LoadingBlock grid):列宽/宽高比对齐真实市场卡(3:4),
           骨架 → 真实卡片替换时栅格不跳动 */
        .mv-panel :global(.ui-loading--grid.mv-market-loading) {
          grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
          gap: var(--space-5);
          width: 100%;
        }
        .mv-panel :global(.mv-market-loading .ui-loading-block) {
          aspect-ratio: 3 / 4;
          border-radius: var(--radius-panel);
        }

        .mv-groups {
          display: flex;
          flex-direction: column;
          gap: var(--space-6);
        }

        .mv-group {
          padding: 0;
          overflow: hidden;
        }

        .mv-group-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-3);
          padding: var(--space-4) var(--space-5);
          background: var(--bg-surface-2);
          border-bottom: 1px solid var(--border-subtle);
        }

        .mv-group-title-wrap {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          min-width: 0;
        }
        /* 组标题左侧 accent 竖条,强化分组锚点 */
        .mv-group-title-wrap::before {
          content: "";
          width: 3px;
          height: 14px;
          border-radius: var(--radius-full);
          background: var(--accent);
          flex-shrink: 0;
        }

        .mv-group-title {
          font-size: var(--text-section);
          font-weight: var(--font-semibold);
          color: var(--text-primary);
          letter-spacing: -0.01em;
        }

        .mv-group-key {
          font-family: var(--font-mono);
          font-size: var(--text-aux);
          color: var(--text-muted);
        }

        .mv-model-list {
          list-style: none;
          margin: 0;
          /* 列表四周留白,行 hover 高亮块不贴卡片边缘 */
          padding: var(--space-2);
          display: flex;
          flex-direction: column;
        }

        /* 行样式:去掉通栏分隔线,改为无分隔 + 圆角 hover 高亮块(Finder 式列表) */
        .mv-model-row {
          display: flex;
          align-items: center;
          gap: var(--space-3);
          padding: var(--space-2) var(--space-3);
          border-radius: var(--radius-control);
          transition: background-color var(--duration-fast) var(--ease-standard);
        }
        .mv-model-row:hover {
          background: var(--bg-surface-2);
        }

        .mv-model-file-icon {
          display: inline-flex;
          color: var(--text-muted);
          flex-shrink: 0;
        }

        .mv-model-name {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: var(--text-body);
          color: var(--text-primary);
          font-family: var(--font-mono);
          letter-spacing: -0.01em;
        }

        .mv-model-ext {
          font-family: var(--font-mono);
          font-size: var(--text-label);
          color: var(--text-muted);
          text-transform: uppercase;
          padding: 2px var(--space-2);
          background: var(--bg-surface-2);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-badge);
          flex-shrink: 0;
        }

        .mv-model-type {
          flex-shrink: 0;
        }

        .mv-result-meta {
          font-size: var(--text-aux);
          color: var(--text-muted);
          font-family: var(--font-mono);
        }

        .mv-market-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
          gap: var(--space-5);
        }

        .mv-card {
          padding: 0;
          overflow: hidden;
          text-decoration: none;
          display: flex;
          flex-direction: column;
          transition: border-color var(--duration-fast) var(--ease-standard),
                      box-shadow var(--duration-fast) var(--ease-standard),
                      transform var(--duration-fast) var(--ease-standard);
        }
        /* hover 升浮反馈:边框加深 + 上移 + 投影 */
        .mv-card:hover {
          border-color: var(--border-strong);
          box-shadow: var(--shadow-lift);
          transform: translateY(-3px);
        }

        .mv-card-thumb {
          position: relative;
          display: block;
          aspect-ratio: 3 / 4;
          background: var(--bg-surface-2);
          overflow: hidden;
          text-decoration: none;
          color: inherit;
        }
        .mv-card-thumb img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
          transition: transform var(--duration-base) var(--ease-standard);
        }
        .mv-card:hover .mv-card-thumb img {
          transform: scale(1.04);
        }

        .mv-card-thumb-placeholder {
          width: 100%;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--text-muted);
          opacity: 0.45;
          background: linear-gradient(135deg, var(--bg-surface-2), var(--bg-surface-3));
        }

        .mv-card-type {
          position: absolute;
          top: var(--space-2);
          left: var(--space-2);
          padding: 2px var(--space-2);
          background: var(--overlay-strong);
          backdrop-filter: blur(6px);
          border: 1px solid var(--border-strong);
          border-radius: var(--radius-badge);
          font-size: var(--text-label);
          font-weight: var(--font-medium);
          color: var(--text-primary);
          letter-spacing: 0.02em;
        }

        .mv-card-open {
          position: absolute;
          top: var(--space-2);
          right: var(--space-2);
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          border-radius: var(--radius-full);
          background: var(--overlay-strong);
          backdrop-filter: blur(6px);
          border: 1px solid var(--border-strong);
          color: var(--text-secondary);
          opacity: 0;
          transform: translateY(-4px);
          transition: opacity var(--duration-base) var(--ease-standard), transform var(--duration-base) var(--ease-standard);
        }
        .mv-card:hover .mv-card-open,
        .mv-card-thumb:focus-visible .mv-card-open {
          opacity: 1;
          transform: translateY(0);
        }

        .mv-card-body {
          padding: var(--space-4);
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
        }

        .mv-card-name {
          margin: 0;
          font-size: var(--text-body);
          font-weight: var(--font-semibold);
          color: var(--text-primary);
          line-height: 1.35;
          letter-spacing: -0.01em;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
          /* 恰好预留两行高度,卡片标题长短不一时网格行对齐 */
          min-height: 2.7em;
        }

        .mv-card-meta {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-2);
        }

        .mv-card-creator {
          font-size: var(--text-aux);
          color: var(--text-muted);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          min-width: 0;
        }

        .mv-card-dl {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          font-size: var(--text-aux);
          color: var(--text-secondary);
          font-family: var(--font-mono);
          flex-shrink: 0;
        }

        /* 卡片操作区:外链 + 安装 */
        .mv-card-actions {
          display: flex;
          gap: var(--space-2);
          margin-top: var(--space-1);
        }

        .mv-card-link,
        .mv-card-install {
          flex: 1;
          justify-content: center;
        }

        .mv-card-link {
          text-decoration: none;
        }

        .mv-card-msg {
          margin-top: var(--space-2);
          padding: var(--space-2) var(--space-3);
          border-radius: var(--radius-control);
          font-size: var(--text-aux);
          line-height: 1.5;
          border: 1px solid var(--border-strong);
          word-break: break-word;
        }

        .mv-card-msg.is-success {
          color: var(--ok);
          background: var(--ok-soft);
          border-color: var(--ok);
        }

        .mv-card-msg.is-error {
          color: var(--err);
          background: var(--err-soft);
          border-color: var(--err);
        }

        /* ── 响应式(UI-B 补齐两档,对齐全站断点令牌 1023/767) ── */
        /* 平板 ≤1023px:市场卡栅格降级(列宽收紧),加载骨架列宽同步 */
        @media (max-width: 1023px) {
          .mv-market-grid,
          .mv-panel :global(.ui-loading--grid.mv-market-loading) {
            grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
            gap: var(--space-4);
          }
        }

        /* 移动 ≤767px:触控目标 44px;分组列表行元信息折行(单列化);市场栅格再降级 */
        @media (max-width: 767px) {
          .models-view :global(.ui-tab),
          .mv-toolbar .btn,
          .mv-toolbar .input,
          .mv-card-actions .btn {
            min-height: var(--touch-target);
          }
          /* 分组列表单列化:扩展名/类型徽标折到文件名之下,长文件名不再挤压溢出
             (26px = 14px 文件图标 + var(--space-3) 行内距) */
          .mv-model-row {
            flex-wrap: wrap;
            row-gap: 2px;
          }
          .mv-model-name {
            flex: 1 1 calc(100% - 26px);
          }
          .mv-market-grid,
          .mv-panel :global(.ui-loading--grid.mv-market-loading) {
            grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
          }
          .mv-toolbar {
            padding: var(--space-3);
          }
          .mv-type-select {
            flex: 1;
          }
          /* 窄卡片内两个按钮并排会溢出文案,改为纵向堆叠 */
          .mv-card-actions {
            flex-direction: column;
          }
        }
      `}</style>
    </div>
  );
}
