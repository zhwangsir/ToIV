"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  installModel,
  listLocalModels,
  searchMarketplace,
  type InstallModelParams,
  type InstallModelResult,
} from "@/lib/api";
import type { LocalModels, MarketItem } from "@/lib/types";
import { Icon } from "@/components/ui/Icon";

type Tab = "local" | "market";

/** 单个市场模型的安装状态。 */
type InstallState = {
  status: "installing" | "success" | "error";
  message?: string;
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

  // 安装市场模型到本地 ComfyUI 集群
  const installOne = useCallback(
    async (m: MarketItem) => {
      setInstallState((prev) => ({
        ...prev,
        [m.id]: { status: "installing" },
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
            status: "success",
            message: res.message ?? "安装请求已受理",
          },
        }));
        // 安装成功后刷新本地模型列表
        void loadLocal();
      } catch (e) {
        setInstallState((prev) => ({
          ...prev,
          [m.id]: {
            status: "error",
            message: e instanceof Error ? e.message : "安装失败",
          },
        }));
      }
    },
    [loadLocal],
  );

  return (
    <div className="single-view models-view">
      <header className="mv-header">
        <div className="mv-title-wrap">
          <h1 className="mv-title">模型库</h1>
          <p className="mv-subtitle">管理本地已安装模型 · 探索 Civitai 在线市场</p>
        </div>
        <div className="mv-tabs" role="tablist" aria-label="模型库视图切换">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "local"}
            className={`mv-tab${tab === "local" ? " is-active" : ""}`}
            onClick={() => setTab("local")}
          >
            <Icon name="models" size={15} strokeWidth={1.9} />
            本地模型
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "market"}
            className={`mv-tab${tab === "market" ? " is-active" : ""}`}
            onClick={() => setTab("market")}
          >
            <Icon name="search" size={15} strokeWidth={1.9} />
            在线市场
          </button>
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
              {totalCount > 0 && <span className="mv-stat">{totalCount} 个模型</span>}
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
            <div className="mv-center">
              <span className="loading-spinner">
                <Icon name="loading" size={16} />
                正在加载本地模型…
              </span>
            </div>
          ) : localError ? (
            <div className="mv-center mv-error-box">
              <Icon name="error" size={20} />
              <p>{localError}</p>
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
      ) : (
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
            <div className="mv-center">
              <span className="loading-spinner">
                <Icon name="loading" size={16} />
                正在搜索 Civitai…
              </span>
            </div>
          ) : marketError ? (
            <div className="mv-center mv-error-box">
              <Icon name="error" size={20} />
              <p>{marketError}</p>
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
                              ? "安装中"
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
      )}

      <style jsx>{`
        .models-view {
          padding-top: var(--space-4);
        }

        .mv-header {
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          gap: var(--space-4);
          flex-wrap: wrap;
          margin-bottom: var(--space-5);
        }

        .mv-title-wrap {
          display: flex;
          flex-direction: column;
          gap: 0.15rem;
        }

        .mv-title {
          margin: 0;
          font-family: var(--font-display);
          font-size: 1.6rem;
          font-weight: 500;
          letter-spacing: -0.02em;
          color: var(--ink);
          line-height: 1.15;
        }

        .mv-subtitle {
          margin: 0;
          font-size: 0.82rem;
          color: var(--ink-faint);
        }

        .mv-tabs {
          display: inline-flex;
          gap: 2px;
          padding: 3px;
          background: var(--bg-1);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-full);
        }

        .mv-tab {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          padding: 0.4rem 0.95rem;
          background: transparent;
          border: none;
          border-radius: var(--radius-full);
          color: var(--ink-faint);
          font-size: 0.82rem;
          font-weight: 500;
          cursor: pointer;
          transition: color var(--dur) var(--ease), background-color var(--dur) var(--ease);
        }
        .mv-tab:hover {
          color: var(--ink-soft);
        }
        .mv-tab.is-active {
          background: var(--accent);
          color: var(--accent-ink);
        }
        .mv-tab:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: 2px;
        }

        .mv-panel {
          display: flex;
          flex-direction: column;
          gap: var(--space-4);
        }

        .mv-toolbar {
          display: flex;
          align-items: center;
          gap: var(--space-3);
          flex-wrap: wrap;
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
          left: 0.7rem;
          top: 50%;
          transform: translateY(-50%);
          color: var(--ink-faint);
          pointer-events: none;
          display: inline-flex;
        }

        .mv-search-input {
          padding-left: 2.2rem;
        }

        .mv-toolbar-right {
          display: inline-flex;
          align-items: center;
          gap: var(--space-3);
          margin-left: auto;
        }

        .mv-stat {
          font-size: 0.78rem;
          color: var(--ink-faint);
          font-family: var(--font-mono);
        }

        .mv-type-select {
          width: auto;
          min-width: 130px;
          cursor: pointer;
          padding-right: 1.6rem;
        }

        .mv-center {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: var(--space-3);
          padding: var(--space-6) var(--space-4);
          text-align: center;
        }

        .mv-error-box {
          color: var(--danger);
        }
        .mv-error-box p {
          margin: 0;
          font-size: 0.85rem;
        }

        .mv-groups {
          display: flex;
          flex-direction: column;
          gap: var(--space-4);
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
          padding: 0.7rem 1rem;
          background: var(--bg-2);
          border-bottom: 1px solid var(--hairline);
        }

        .mv-group-title-wrap {
          display: flex;
          align-items: baseline;
          gap: 0.5rem;
          min-width: 0;
        }

        .mv-group-title {
          font-size: 0.9rem;
          font-weight: 600;
          color: var(--ink);
          letter-spacing: -0.01em;
        }

        .mv-group-key {
          font-family: var(--font-mono);
          font-size: 0.72rem;
          color: var(--ink-faint);
        }

        .mv-model-list {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
        }

        .mv-model-row {
          display: flex;
          align-items: center;
          gap: var(--space-3);
          padding: 0.55rem 1rem;
          border-bottom: 1px solid var(--hairline);
          transition: background-color var(--dur) var(--ease);
        }
        .mv-model-row:last-child {
          border-bottom: none;
        }
        .mv-model-row:hover {
          background: var(--bg-2);
        }

        .mv-model-file-icon {
          display: inline-flex;
          color: var(--ink-faint);
          flex-shrink: 0;
        }

        .mv-model-name {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 0.85rem;
          color: var(--ink);
          font-family: var(--font-mono);
          letter-spacing: -0.01em;
        }

        .mv-model-ext {
          font-family: var(--font-mono);
          font-size: 0.68rem;
          color: var(--ink-faint);
          text-transform: uppercase;
          padding: 0.1rem 0.4rem;
          background: var(--bg-2);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-xs);
          flex-shrink: 0;
        }

        .mv-model-type {
          flex-shrink: 0;
        }

        .mv-result-meta {
          font-size: 0.78rem;
          color: var(--ink-faint);
          font-family: var(--font-mono);
        }

        .mv-market-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
          gap: var(--space-4);
        }

        .mv-card {
          padding: 0;
          overflow: hidden;
          text-decoration: none;
          display: flex;
          flex-direction: column;
          transition: border-color var(--dur-2) var(--ease), transform var(--dur-2) var(--ease),
            box-shadow var(--dur-2) var(--ease);
        }
        .mv-card:hover {
          border-color: var(--accent-line);
          transform: translateY(-2px);
          box-shadow: 0 0 0 1px var(--accent-line), var(--shadow-lg);
        }
        .mv-card:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: 2px;
        }

        .mv-card-thumb {
          position: relative;
          aspect-ratio: 3 / 4;
          background: var(--bg-2);
          overflow: hidden;
        }
        .mv-card-thumb img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
          transition: transform 0.4s var(--ease);
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
          color: var(--ink-faint);
          opacity: 0.45;
          background: linear-gradient(135deg, var(--bg-2), var(--bg-3));
        }

        .mv-card-type {
          position: absolute;
          top: 0.5rem;
          left: 0.5rem;
          padding: 0.2rem 0.55rem;
          background: oklch(7% 0.006 265 / 0.72);
          backdrop-filter: blur(6px);
          border: 1px solid var(--hairline-2);
          border-radius: var(--radius-xs);
          font-size: 0.68rem;
          font-weight: 500;
          color: var(--ink);
          letter-spacing: 0.02em;
        }

        .mv-card-open {
          position: absolute;
          top: 0.5rem;
          right: 0.5rem;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 26px;
          height: 26px;
          border-radius: var(--radius-full);
          background: oklch(7% 0.006 265 / 0.72);
          backdrop-filter: blur(6px);
          border: 1px solid var(--hairline-2);
          color: var(--ink-soft);
          opacity: 0;
          transform: translateY(-4px);
          transition: opacity var(--dur-2) var(--ease), transform var(--dur-2) var(--ease);
        }
        .mv-card:hover .mv-card-open {
          opacity: 1;
          transform: translateY(0);
        }

        .mv-card-body {
          padding: 0.7rem 0.8rem 0.8rem;
          display: flex;
          flex-direction: column;
          gap: 0.45rem;
        }

        .mv-card-name {
          margin: 0;
          font-size: 0.84rem;
          font-weight: 600;
          color: var(--ink);
          line-height: 1.35;
          letter-spacing: -0.01em;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
          min-height: 2.2em;
        }

        .mv-card-meta {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.5rem;
        }

        .mv-card-creator {
          font-size: 0.74rem;
          color: var(--ink-faint);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          min-width: 0;
        }

        .mv-card-dl {
          display: inline-flex;
          align-items: center;
          gap: 0.25rem;
          font-size: 0.74rem;
          color: var(--ink-soft);
          font-family: var(--font-mono);
          flex-shrink: 0;
        }

        /* 卡片操作区:外链 + 安装 */
        .mv-card-thumb {
          display: block;
          text-decoration: none;
          color: inherit;
        }

        .mv-card-actions {
          display: flex;
          gap: 0.4rem;
          margin-top: 0.15rem;
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
          margin-top: 0.4rem;
          padding: 0.4rem 0.55rem;
          border-radius: var(--radius-xs);
          font-size: 0.74rem;
          line-height: 1.4;
          border: 1px solid var(--hairline-2);
          word-break: break-word;
        }

        .mv-card-msg.is-success {
          color: var(--success);
          background: var(--success-quiet);
          border-color: var(--success);
        }

        .mv-card-msg.is-error {
          color: var(--danger);
          background: var(--danger-quiet);
          border-color: var(--danger);
        }

        @media (max-width: 640px) {
          .mv-header {
            align-items: flex-start;
          }
          .mv-market-grid {
            grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
          }
          .mv-type-select {
            flex: 1;
          }
        }
      `}</style>
    </div>
  );
}
