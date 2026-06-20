"use client";

import { useCallback, useEffect, useState } from "react";

import { listLocalModels, searchMarketplace } from "@/lib/api";
import type { LocalModels, MarketItem } from "@/lib/types";

type Tab = "local" | "civitai" | "huggingface";

const CIVITAI_TYPES = [
  { k: "", l: "全部" },
  { k: "Checkpoint", l: "大模型" },
  { k: "LORA", l: "LoRA" },
  { k: "VAE", l: "VAE" },
  { k: "Controlnet", l: "ControlNet" },
];

const LOCAL_LABELS: Record<string, string> = {
  checkpoints: "大模型 Checkpoints",
  loras: "LoRA",
  vae: "VAE",
  controlnet: "ControlNet",
  upscale: "放大模型",
};

function fmt(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

export function ModelLibrary() {
  const [tab, setTab] = useState<Tab>("local");
  const [local, setLocal] = useState<LocalModels | null>(null);
  const [query, setQuery] = useState("");
  const [ctype, setCtype] = useState("");
  const [items, setItems] = useState<MarketItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listLocalModels()
      .then(setLocal)
      .catch((e: Error) => setError(e.message));
  }, []);

  const runSearch = useCallback(
    async (source: Tab, q: string, type?: string) => {
      if (source === "local") return;
      setLoading(true);
      setError(null);
      try {
        const r = await searchMarketplace(source, q, type);
        setItems(r.items);
      } catch (e) {
        setError((e as Error).message);
        setItems([]);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (tab !== "local") runSearch(tab, query, tab === "civitai" ? ctype : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  return (
    <div className="modlib">
      <div className="stage-head">
        <h1>
          模型 <span className="grad">库</span>
        </h1>
      </div>

      <div className="modlib-tabs">
        {(["local", "civitai", "huggingface"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            className={tab === t ? "active" : ""}
            onClick={() => setTab(t)}
          >
            {t === "local" ? "本地已装" : t === "civitai" ? "Civitai" : "HuggingFace"}
          </button>
        ))}
      </div>

      {tab !== "local" && (
        <form
          className="modlib-search"
          onSubmit={(e) => {
            e.preventDefault();
            runSearch(tab, query, tab === "civitai" ? ctype : undefined);
          }}
        >
          <input
            type="text"
            placeholder={`搜索 ${tab === "civitai" ? "Civitai" : "HuggingFace"} 模型…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit" className="btn-ghost">
            搜索
          </button>
        </form>
      )}

      {tab === "civitai" && (
        <div className="type-chips">
          {CIVITAI_TYPES.map((t) => (
            <button
              key={t.k}
              type="button"
              className={ctype === t.k ? "active" : ""}
              onClick={() => {
                setCtype(t.k);
                runSearch("civitai", query, t.k);
              }}
            >
              {t.l}
            </button>
          ))}
        </div>
      )}

      {error && <div className="alert">⚠ {error}</div>}

      {tab === "local" ? (
        !local ? (
          <p className="muted">加载中…</p>
        ) : (
          Object.entries(local).map(([key, names]) => (
            <section key={key} className="local-section">
              <h3>
                {LOCAL_LABELS[key] ?? key} <span>{names.length}</span>
              </h3>
              {names.length === 0 ? (
                <p className="muted">暂无</p>
              ) : (
                <div className="pill-wrap">
                  {names.map((n) => (
                    <span key={n} className="model-pill" title={n}>
                      {n.replace(/\.(safetensors|ckpt|pt|pth)$/, "")}
                    </span>
                  ))}
                </div>
              )}
            </section>
          ))
        )
      ) : loading ? (
        <p className="muted">搜索中…</p>
      ) : (
        <div className="model-grid">
          {items.map((m) => (
            <article className="model-card" key={`${m.source}-${m.id}`}>
              <div className="model-thumb">
                {m.thumbnail ? (
                  <img src={m.thumbnail} alt={m.name} loading="lazy" />
                ) : (
                  <span className="thumb-fallback">{m.type ?? "model"}</span>
                )}
                {m.type && <span className="model-type">{m.type}</span>}
              </div>
              <div className="model-info">
                <p className="model-name" title={m.name}>
                  {m.name}
                </p>
                <p className="model-sub">
                  {m.creator ?? "—"} · ↓ {fmt(m.downloads)}
                </p>
                <div className="model-actions">
                  <a className="btn-ghost sm" href={m.url} target="_blank" rel="noreferrer">
                    查看
                  </a>
                  <button
                    type="button"
                    className="btn-ghost sm"
                    disabled
                    title="一键下载落地开发中（需 worker 文件系统访问）"
                  >
                    下载
                  </button>
                </div>
              </div>
            </article>
          ))}
          {items.length === 0 && <p className="muted">没有结果，换个关键词试试。</p>}
        </div>
      )}
    </div>
  );
}
