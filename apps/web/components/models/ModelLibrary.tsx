"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { useNsfw } from "@/components/nav/NsfwContext";
import { listLocalModels, searchMarketplace } from "@/lib/api";
import { navPillSpring } from "@/lib/motion";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import type { LocalModels, MarketItem } from "@/lib/types";
import { MarketCard } from "./MarketCard";
import "./models.css";

type Tab = "local" | "civitai" | "huggingface";

const TABS: { k: Tab; l: string }[] = [
  { k: "local", l: "本地已装" },
  { k: "civitai", l: "Civitai" },
  { k: "huggingface", l: "HuggingFace" },
];

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

export function ModelLibrary() {
  const [tab, setTab] = useState<Tab>("local");
  const [local, setLocal] = useState<LocalModels | null>(null);
  const [query, setQuery] = useState("");
  const [ctype, setCtype] = useState("");
  const [items, setItems] = useState<MarketItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reduced = useReducedMotion();
  // R18 软开关:切换后(revision 变化)重拉本地模型,反映后端服务端过滤。
  const { revision: nsfwRevision } = useNsfw();

  useEffect(() => {
    let alive = true;
    listLocalModels()
      .then((m) => {
        if (alive) setLocal(m);
      })
      .catch((e: Error) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [nsfwRevision]);

  const runSearch = useCallback(async (source: Tab, q: string, type?: string) => {
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
  }, []);

  useEffect(() => {
    if (tab !== "local") runSearch(tab, query, tab === "civitai" ? ctype : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const localCount = useMemo(
    () => (local ? Object.values(local).reduce((s, n) => s + n.length, 0) : 0),
    [local],
  );

  return (
    <div className="view">
      <header className="view-header">
        <span className="view-eyebrow">Atelier · 模型工坊</span>
        <h1 className="view-title">
          模型 <em>库</em>
        </h1>
        <p className="view-lede">
          浏览本地已装权重,或在 Civitai / HuggingFace 上搜罗大模型、LoRA、ControlNet。
        </p>
        <div className="view-tally">
          <span className="n">{tab === "local" ? localCount : items.length}</span>
          <span className="l">{tab === "local" ? "件已装" : "条结果"}</span>
        </div>
      </header>

      <div className="seg-rail" role="tablist" aria-label="模型来源">
        {TABS.map((t) => {
          const on = tab === t.k;
          return (
            <button
              key={t.k}
              type="button"
              role="tab"
              aria-selected={on}
              className={on ? "is-on" : ""}
              onClick={() => setTab(t.k)}
            >
              {on && (
                <motion.span
                  className="seg-pill"
                  layoutId="modlib-pill"
                  transition={navPillSpring}
                  aria-hidden="true"
                />
              )}
              {t.l}
            </button>
          );
        })}
      </div>

      {tab !== "local" && (
        <div className="view-toolbar">
          <form
            className="search-field"
            onSubmit={(e) => {
              e.preventDefault();
              runSearch(tab, query, tab === "civitai" ? ctype : undefined);
            }}
          >
            <svg className="ti-ico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4.3-4.3" />
            </svg>
            <input
              type="text"
              placeholder={`搜索 ${tab === "civitai" ? "Civitai" : "HuggingFace"} 模型…`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </form>
          {tab === "civitai" && (
            <div className="filter-chips" role="group" aria-label="模型类型">
              {CIVITAI_TYPES.map((t) => (
                <button
                  key={t.k}
                  type="button"
                  className={`filter-chip${ctype === t.k ? " is-on" : ""}`}
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
        </div>
      )}

      {error && <div className="alert">⚠ {error}</div>}

      {tab === "local" ? (
        !local ? (
          <div className="modset">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skel-card" style={{ height: "70px", margin: 0 }} />
            ))}
          </div>
        ) : (
          <div className="modset">
            {Object.entries(local).map(([key, names]) => (
              <section key={key} className="local-group">
                <div className="local-group-head">
                  <span className="t">{LOCAL_LABELS[key] ?? key}</span>
                  <span className="c">{names.length} 件</span>
                </div>
                {names.length === 0 ? (
                  <span className="local-empty">暂无 —— 可去市场搜索安装</span>
                ) : (
                  <div className="local-pills">
                    {names.map((n) => (
                      <span key={n} className="local-pill" title={n}>
                        {n.replace(/\.(safetensors|ckpt|pt|pth)$/, "")}
                      </span>
                    ))}
                  </div>
                )}
              </section>
            ))}
          </div>
        )
      ) : loading ? (
        <div className="skel-grid" aria-hidden="true">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="skel-card" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="editorial-empty">
          <span className="ee-orb" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4.3-4.3" />
            </svg>
          </span>
          <h2>没有匹配的模型</h2>
          <p>换个关键词,或切换到另一个模型市场再试试。</p>
        </div>
      ) : (
        <motion.div
          className="market-grid"
          initial="initial"
          animate="enter"
          variants={{ enter: { transition: { staggerChildren: reduced ? 0 : 0.03 } } }}
        >
          <AnimatePresence>
            {items.map((m) => (
              <MarketCard key={`${m.source}-${m.id}`} item={m} reduced={reduced} />
            ))}
          </AnimatePresence>
        </motion.div>
      )}
    </div>
  );
}
