"use client";

import { useCallback, useState } from "react";
import { motion } from "framer-motion";

import { installModel } from "@/lib/api";
import { springSoft } from "@/lib/motion";
import type { InstallModelParams } from "@/lib/api";
import type { MarketItem } from "@/lib/types";

/** 每张市场卡的安装状态机:idle → installing → done | error。 */
type InstallState =
  | { kind: "idle" }
  | { kind: "installing" }
  | { kind: "done"; message: string; fromCatalog: boolean }
  | { kind: "error"; detail: string };

/** Civitai / HuggingFace 原始 type → 后端安装枚举(checkpoint/lora/vae/controlnet/ipadapter…)。 */
const TYPE_MAP: Record<string, string> = {
  checkpoint: "checkpoint",
  checkpoints: "checkpoint",
  ckpt: "checkpoint",
  model: "checkpoint",
  textualinversion: "embedding",
  embedding: "embedding",
  embeddings: "embedding",
  lora: "lora",
  loras: "lora",
  locon: "lora",
  lycoris: "lora",
  dora: "lora",
  vae: "vae",
  controlnet: "controlnet",
  control_net: "controlnet",
  ipadapter: "ipadapter",
  ip_adapter: "ipadapter",
  upscaler: "upscale",
  upscale: "upscale",
};

/** 把市场 item 的 type 归一到后端枚举;无法识别时回退到 checkpoint(最常见权重类型)。 */
function normalizeType(raw: string | null): string {
  if (!raw) return "checkpoint";
  const key = raw.toLowerCase().replace(/[\s-]+/g, "");
  return TYPE_MAP[key] ?? "checkpoint";
}

/** 从市场 item 推断 installModel 入参:
 *  - HuggingFace:source + id(repo)+ filename(从 url 末段尽力解析)。
 *  - Civitai:url 直链(后端按 url 下载 / 匹配策展目录)。 */
function toInstallParams(item: MarketItem): InstallModelParams {
  const type = normalizeType(item.type);
  if (item.source === "huggingface") {
    return {
      type,
      source: "huggingface",
      id: item.id,
      filename: deriveFilename(item.url),
      name: item.name,
    };
  }
  // 默认走 Civitai / 直链路径
  return {
    type,
    source: item.source,
    id: item.id,
    url: item.url,
    name: item.name,
  };
}

/** 从 url 末段尽力解析权重文件名;无 .safetensors/.ckpt 等后缀则返回 undefined,交后端推断。 */
function deriveFilename(url: string): string | undefined {
  try {
    const path = new URL(url).pathname;
    const last = path.split("/").filter(Boolean).pop();
    if (last && /\.(safetensors|ckpt|pt|pth|bin)$/i.test(last)) {
      return decodeURIComponent(last);
    }
  } catch {
    // url 非法 → 交后端用 source+id 推断
  }
  return undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "安装请求失败,请稍后重试。";
}

/** detail 看起来像「不在策展目录」时,补一句可操作的人话提示。 */
function catalogHint(detail: string): string | null {
  if (/目录|catalog|策展|未匹配|not in/i.test(detail)) {
    return "ComfyUI-Manager 仅安装其策展目录内的模型,该模型可能需手动下载到 worker。";
  }
  return null;
}

function fmt(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

interface MarketCardProps {
  item: MarketItem;
  reduced: boolean;
}

export function MarketCard({ item, reduced }: MarketCardProps) {
  const [state, setState] = useState<InstallState>({ kind: "idle" });

  const handleInstall = useCallback(async () => {
    setState({ kind: "installing" });
    try {
      const result = await installModel(toInstallParams(item));
      if (result.accepted) {
        setState({
          kind: "done",
          message: result.message ?? "已加入安装队列",
          fromCatalog: result.from_catalog ?? false,
        });
      } else {
        // accepted=false:后端未拒绝但也没接收,把 message 当作需用户知晓的提示展示,不假装成功
        setState({
          kind: "error",
          detail: result.message ?? "集群未接收该安装请求。",
        });
      }
    } catch (error: unknown) {
      setState({ kind: "error", detail: getErrorMessage(error) });
    }
  }, [item]);

  const installing = state.kind === "installing";
  const done = state.kind === "done";

  return (
    <motion.article
      className="mcard"
      variants={{
        initial: { opacity: 0, y: reduced ? 0 : 14 },
        enter: { opacity: 1, y: 0, transition: springSoft },
      }}
    >
      <div className="mcard-thumb">
        {item.thumbnail ? (
          <img src={item.thumbnail} alt={item.name} loading="lazy" />
        ) : (
          <span className="fallback">{(item.type ?? "M").slice(0, 1)}</span>
        )}
        {item.type && <span className="mcard-type">{item.type}</span>}
      </div>
      <div className="mcard-body">
        <p className="mcard-name" title={item.name}>
          {item.name}
        </p>
        <p className="mcard-sub">
          {item.creator ?? "—"} · ↓ {fmt(item.downloads)}
        </p>
        <div className="mcard-actions">
          <a className="btn-ghost sm" href={item.url} target="_blank" rel="noreferrer">
            查看
          </a>
          <button
            type="button"
            className={`install-btn${installing ? " is-installing" : ""}${done ? " is-done" : ""}`}
            onClick={handleInstall}
            disabled={installing || done}
            aria-busy={installing}
            aria-label={done ? `${item.name} 已加入安装队列` : `安装 ${item.name} 到集群`}
          >
            {installing ? (
              <>
                <span className="install-spinner" aria-hidden="true" />
                安装中…
              </>
            ) : done ? (
              <>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                已入队
              </>
            ) : (
              "安装到集群"
            )}
          </button>
        </div>

        {(state.kind === "done" || state.kind === "error") && (
          <div
            className={`install-status ${state.kind === "done" ? "is-ok" : "is-error"}`}
            role="status"
            aria-live="polite"
          >
            {state.kind === "done" ? (
              <>
                <span className="ist-head">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                  {state.message}
                </span>
                {state.fromCatalog && (
                  <p className="ist-detail">已在 ComfyUI-Manager 策展目录中匹配,worker 将自动拉取。</p>
                )}
              </>
            ) : (
              <>
                <span className="ist-head">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
                  </svg>
                  安装未完成
                </span>
                <p className="ist-detail">{state.detail}</p>
                {catalogHint(state.detail) && <p className="ist-hint">{catalogHint(state.detail)}</p>}
                <button type="button" className="btn-ghost sm" onClick={handleInstall} style={{ marginTop: "0.4rem" }}>
                  重试
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </motion.article>
  );
}
