"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { assetFromJob, fetchJobsPage, imageUrl } from "@/lib/api";
import type { JobItem } from "@/lib/types";

/**
 * 资产互通选择器(2026-08-18):作品库产物 → 参考输入。
 * 列出已完成 Job 的产物,点击后经 /api/assets/from-job 把 output 文件转运到
 * 目标 worker 的 input 目录,返回与上传句柄同构的 {filename, worker}。
 */

export type AssetType = "image" | "video" | "audio";

export interface PickedAsset {
  filename: string;
  worker: string;
  /** 产物预览 URL(签名产物 URL,仅预览用) */
  previewUrl: string;
  name: string;
}

const TYPE_EXTS: Record<AssetType, string[]> = {
  image: ["jpg", "jpeg", "png", "webp"],
  video: ["mp4", "mov", "webm"],
  audio: ["wav", "mp3", "m4a", "ogg", "flac"],
};

const TYPE_LABEL: Record<AssetType, string> = { image: "图片", video: "视频", audio: "音频" };

/** 从产物 URL(/api/images?filename=…&type=output&worker=…)解析 filename。 */
function filenameOfResult(url: string): string | null {
  try {
    const q = url.split("?", 2)[1] ?? "";
    const params = new URLSearchParams(q);
    const f = params.get("filename");
    return f && f.length > 0 ? f : null;
  } catch {
    return null;
  }
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

interface AssetPickerProps {
  open: boolean;
  onClose: () => void;
  assetType: AssetType;
  /** 目标任务 kind(与 /api/upload 同款,caps 门控选 worker) */
  kind: string;
  /** 钉定目标 worker(与已选参考图/音频同机;省略自动选) */
  pinWorker?: string | null;
  /** 转运完成回调:句柄与本地/直传上传完全同构,直接灌入引擎表单 */
  onPick: (a: PickedAsset) => void;
}

export function AssetPicker({ open, onClose, assetType, kind, pinWorker, onPick }: AssetPickerProps) {
  const toast = useToast();
  const [jobs, setJobs] = useState<JobItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transferring, setTransferring] = useState<string | null>(null); // 正在转运的 "jobId:filename"

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await fetchJobsPage(0, 120);
      setJobs(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载作品库失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  /** 展示项:done Job × 产物扩展名过滤,取每 Job 首个匹配产物。 */
  const items = useMemo(() => {
    const exts = TYPE_EXTS[assetType];
    const out: { job: JobItem; filename: string; url: string }[] = [];
    for (const j of jobs) {
      if (j.status !== "done" || !j.results?.length) continue;
      const hit = j.results.find((u) => {
        const f = filenameOfResult(u) ?? "";
        return exts.includes(extOf(f));
      });
      if (hit) {
        const f = filenameOfResult(hit);
        if (f) out.push({ job: j, filename: f, url: hit });
      }
    }
    return out;
  }, [jobs, assetType]);

  async function pick(item: { job: JobItem; filename: string; url: string }) {
    const key = `${item.job.id}:${item.filename}`;
    if (transferring) return;
    setTransferring(key);
    setError(null);
    try {
      const r = await assetFromJob({
        job_id: item.job.id,
        filename: item.filename,
        kind,
        ...(pinWorker ? { worker: pinWorker } : {}),
      });
      onPick({
        filename: r.filename,
        worker: r.worker,
        previewUrl: imageUrl(item.url),
        name: item.filename,
      });
      toast.success(`已引用${TYPE_LABEL[assetType]}产物`);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "转运失败");
    } finally {
      setTransferring(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`从作品库选择${TYPE_LABEL[assetType]}`} width={640}>
      {loading ? (
        <p className="asset-picker-empty">加载中…</p>
      ) : items.length === 0 ? (
        <p className="asset-picker-empty">作品库中还没有可用的{TYPE_LABEL[assetType]}产物</p>
      ) : (
        <div className="asset-picker-grid">
          {items.map((it) => {
            const busy = transferring === `${it.job.id}:${it.filename}`;
            return (
              <button
                type="button"
                key={`${it.job.id}:${it.filename}`}
                className="asset-picker-item"
                disabled={Boolean(transferring)}
                title={it.filename}
                onClick={() => void pick(it)}
              >
                {assetType === "image" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={imageUrl(it.url)} alt={it.filename} loading="lazy" decoding="async" width={128} height={128} />
                ) : (
                  <span className="asset-picker-icon">
                    <Icon name={assetType === "video" ? "video" : "audio"} size={22} />
                  </span>
                )}
                <span className="asset-picker-name">{it.filename}</span>
                {busy && (
                  <span className="asset-picker-busy">
                    <Icon name="loading" size={16} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
      {error && <p className="asset-picker-error">{error}</p>}
      <style jsx>{`
        .asset-picker-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
          gap: var(--space-2, 8px);
          max-height: 56vh;
          overflow: auto;
        }
        .asset-picker-item {
          position: relative;
          display: flex;
          flex-direction: column;
          gap: 4px;
          padding: 4px;
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control, 8px);
          background: var(--bg-surface-3, transparent);
          cursor: pointer;
        }
        .asset-picker-item:hover:not(:disabled) {
          border-color: var(--accent);
        }
        .asset-picker-item :global(img) {
          width: 100%;
          aspect-ratio: 1;
          object-fit: cover;
          border-radius: 6px;
          display: block;
        }
        .asset-picker-icon {
          width: 100%;
          aspect-ratio: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--text-muted);
        }
        .asset-picker-name {
          font-size: 10px;
          color: var(--text-muted);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .asset-picker-busy {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          background: var(--scrim, rgba(0, 0, 0, 0.35));
          border-radius: var(--radius-control, 8px);
          color: var(--text-on-accent);
        }
        .asset-picker-empty {
          margin: 0;
          padding: 28px 0;
          text-align: center;
          color: var(--text-muted);
          font-size: 13px;
        }
        .asset-picker-error {
          margin: var(--space-2, 8px) 0 0;
          font-size: 12px;
          color: var(--err);
        }
      `}</style>
    </Modal>
  );
}
