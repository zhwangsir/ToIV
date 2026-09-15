"use client";

import { useEffect, useState } from "react";

import { fetchJobsPage, imageUrl } from "@/lib/api";
import type { JobItem } from "@/lib/types";

/**
 * 融合首页「最近作品」横条(2026-09-16 打磨):拉最近 12 件完成作品缩略,
 * 点击进作品库;空库/加载失败整条隐藏(不占位)。
 */
export function RecentWorksRail({ onOpenLibrary }: { onOpenLibrary: () => void }) {
  const [jobs, setJobs] = useState<JobItem[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetchJobsPage(0, 12)
      .then((rows) => {
        if (!alive) return;
        setJobs(rows.filter((j) => j.status === "done" && j.results?.length));
      })
      .catch(() => {
        /* 静默:装饰性横条 */
      });
    return () => {
      alive = false;
    };
  }, []);

  const visible = jobs ?? [];
  if (visible.length === 0) return null;

  return (
    <section className="av-recent" aria-label="最近作品">
      <div className="av-recent-head">
        <span className="av-recent-title">最近作品</span>
        <button type="button" className="av-recent-more" onClick={onOpenLibrary}>
          作品库 ›
        </button>
      </div>
      <div className="av-recent-rail" role="list">
        {visible.map((j) => (
          <button
            key={j.id}
            type="button"
            role="listitem"
            className="av-recent-thumb"
            title={(j.prompt || "作品").slice(0, 60)}
            onClick={onOpenLibrary}
          >
            {j.results[0] && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={imageUrl(j.results[0])}
                alt=""
                loading="lazy"
                decoding="async"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
                }}
              />
            )}
            <span className="av-recent-kind">{j.kind === "app_video" || j.kind.includes("video") || j.kind.includes("h3") || j.kind.includes("t2v") || j.kind.includes("i2v") ? "视频" : "图"}</span>
          </button>
        ))}
      </div>
      <style jsx>{`
        .av-recent {
          margin-top: 18px;
          max-width: 720px;
          width: 100%;
        }
        .av-recent-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 8px;
        }
        .av-recent-title {
          font-size: 13px;
          font-weight: 600;
          color: var(--text-primary);
        }
        .av-recent-more {
          background: none;
          border: 0;
          color: var(--text-muted);
          font-size: 12px;
          cursor: pointer;
          padding: 0;
        }
        .av-recent-more:hover {
          color: var(--text-primary);
        }
        .av-recent-rail {
          display: flex;
          gap: 10px;
          overflow-x: auto;
          padding-bottom: 4px;
          scrollbar-width: thin;
        }
        .av-recent-thumb {
          position: relative;
          flex: 0 0 auto;
          width: 128px;
          height: 76px;
          border-radius: 10px;
          overflow: hidden;
          border: 1px solid var(--border-subtle);
          background: var(--bg-surface-2);
          padding: 0;
          cursor: pointer;
        }
        .av-recent-thumb img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
          transition: transform 0.15s ease;
        }
        .av-recent-thumb:hover img {
          transform: scale(1.05);
        }
        .av-recent-kind {
          position: absolute;
          left: 6px;
          bottom: 4px;
          font-size: 10px;
          color: rgba(255, 255, 255, 0.9);
          background: rgba(0, 0, 0, 0.45);
          border-radius: 999px;
          padding: 0 6px;
          line-height: 16px;
        }
      `}</style>
    </section>
  );
}
