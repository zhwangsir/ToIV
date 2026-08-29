"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { assetFromJob, fetchJobsPage, imageUrl, resolveEntityRefs } from "@/lib/api";
import { entityKindLabel, entityThumbUrl, useEntities, type EntityInfo } from "@/lib/entities";
import type { JobItem } from "@/lib/types";

/**
 * 资产互通选择器(2026-08-18):作品库产物 → 参考输入。
 * 列出已完成 Job 的产物,点击后经 /api/assets/from-job 把 output 文件转运到
 * 目标 worker 的 input 目录,返回与上传句柄同构的 {filename, worker}。
 * 分页(2026-08-22):首页满页可「加载更多」,offset=已加载条数,按 Job id 去重
 * (拉取间隙新作业插入顶部会导致页间位置漂移重叠,与作品库同一去重口径)。
 * 主体库合并(2026-08-29):assetType=image 时提供「作品库 | 主体库」双源 Tab,
 * 主体图经 /api/entities/resolve-refs 钉定转运,返回同构句柄(图片类输入
 * 从此两库通吃;视频/音频仅作品库——主体库暂无视频资产,ref_audio 为裸 URL
 * 无转运链,后续有消费方再补)。
 */

export type AssetType = "image" | "video" | "audio";

/** 每页大小(后端单页上限 200;选择器场景 120 足够首屏)。 */
const PAGE_LIMIT = 120;

/** 分页合并:按 Job id 去重后追加(页间重叠兜底,防同一产物条目重复出现)。 */
export function mergeJobsPage(prev: JobItem[], page: JobItem[]): JobItem[] {
  const seen = new Set(prev.map((j) => j.id));
  return [...prev, ...page.filter((j) => !seen.has(j.id))];
}

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
  const [loadingMore, setLoadingMore] = useState(false);
  // 首页满页 = 服务端可能还有更早的作品(老作品资产也可选,不再被首页截断)
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transferring, setTransferring] = useState<string | null>(null); // 正在转运的 "jobId:filename" 或 entity id
  // 双源(2026-08-29):作品库 | 主体库(仅图片类有主体库 Tab)
  const [source, setSource] = useState<"jobs" | "entities">("jobs");
  const entities = useEntities();
  const entityItems = useMemo(
    () => entities.filter((e) => e.thumbUrl), // 无图主体无可选资产,不展示
    [entities],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await fetchJobsPage(0, PAGE_LIMIT);
      setJobs(list);
      setHasMore(list.length >= PAGE_LIMIT);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载作品库失败");
    } finally {
      setLoading(false);
    }
  }, []);

  /** 服务端下一页:offset=已加载条数;按 Job id 去重(页间漂移重叠兜底)。 */
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await fetchJobsPage(jobs.length, PAGE_LIMIT);
      setHasMore(page.length >= PAGE_LIMIT);
      if (page.length > 0) setJobs((prev) => mergeJobsPage(prev, page));
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载更多失败");
    } finally {
      setLoadingMore(false);
    }
  }, [jobs.length, loadingMore, hasMore]);

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

  /** 主体库选取:resolve-refs 把主体最优图钉定/转运到目标 worker,返回同构句柄。 */
  async function pickEntity(e: EntityInfo) {
    if (transferring) return;
    setTransferring(`entity:${e.id}`);
    setError(null);
    try {
      const r = await resolveEntityRefs({
        entity_ids: [e.id],
        kind,
        ...(pinWorker ? { worker: pinWorker } : {}),
      });
      const ref = r.refs[0];
      if (!ref) {
        throw new Error(r.skipped[0]?.reason ?? "该主体暂无可用参考图");
      }
      onPick({
        filename: ref.filename,
        worker: ref.worker,
        previewUrl: entityThumbUrl(e),
        name: e.name,
      });
      toast.success(`已引用主体「${e.name}」`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "主体图转运失败");
    } finally {
      setTransferring(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`选择${TYPE_LABEL[assetType]}资产`} width={640}>
      {assetType === "image" && (
        <div className="asset-picker-tabs" role="tablist" aria-label="资产来源">
          {(["jobs", "entities"] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={source === s}
              className={`asset-picker-tab${source === s ? " is-active" : ""}`}
              onClick={() => setSource(s)}
            >
              {s === "jobs" ? "作品库" : "主体库"}
            </button>
          ))}
        </div>
      )}
      {assetType === "image" && source === "entities" ? (
        entityItems.length === 0 ? (
          <p className="asset-picker-empty">主体库中还没有带图的主体(先去主体库建主体或生成三视图)</p>
        ) : (
          <div className="asset-picker-grid">
            {entityItems.map((e) => {
              const busy = transferring === `entity:${e.id}`;
              return (
                <button
                  type="button"
                  key={e.id}
                  className="asset-picker-item"
                  disabled={Boolean(transferring)}
                  title={`${e.name}(${entityKindLabel(e.kind)})`}
                  onClick={() => void pickEntity(e)}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={entityThumbUrl(e)} alt={e.name} loading="lazy" decoding="async" width={128} height={128} />
                  <span className="asset-picker-name">{e.name}</span>
                  {busy && (
                    <span className="asset-picker-busy">
                      <Icon name="loading" size={16} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )
      ) : loading ? (
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
      {!loading && hasMore && (
        <button
          type="button"
          className="asset-picker-more"
          disabled={loadingMore}
          onClick={() => void loadMore()}
        >
          {loadingMore ? "加载中…" : "加载更多"}
        </button>
      )}
      {error && <p className="asset-picker-error">{error}</p>}
      <style jsx>{`
        .asset-picker-tabs {
          display: flex;
          gap: 4px;
          margin-bottom: var(--space-2, 8px);
          padding: 3px;
          border-radius: var(--radius-full, 999px);
          background: var(--bg-surface-3, rgba(127, 127, 127, 0.12));
        }
        .asset-picker-tab {
          flex: 1;
          padding: 5px 0;
          border: none;
          border-radius: var(--radius-full, 999px);
          background: transparent;
          color: var(--text-muted);
          font-size: 12px;
          cursor: pointer;
        }
        .asset-picker-tab.is-active {
          background: var(--bg-surface-1, #fff);
          color: var(--text-primary);
          font-weight: 600;
          box-shadow: var(--shadow-sm, 0 1px 2px rgba(0, 0, 0, 0.08));
        }
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
        .asset-picker-more {
          display: block;
          margin: var(--space-2, 8px) auto 0;
          padding: 6px 16px;
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control, 8px);
          background: var(--bg-surface-3, transparent);
          color: var(--text-secondary);
          font-size: 12px;
          cursor: pointer;
        }
        .asset-picker-more:hover:not(:disabled) {
          border-color: var(--accent);
        }
        .asset-picker-more:disabled {
          opacity: 0.6;
          cursor: default;
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
