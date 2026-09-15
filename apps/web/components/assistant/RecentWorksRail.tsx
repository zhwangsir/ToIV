"use client";

import { useEffect, useState } from "react";

import { fetchJobsPage, imageUrl } from "@/lib/api";
import type { JobItem } from "@/lib/types";

/**
 * 融合首页「最近作品」横条(2026-09-16 打磨)。
 * 加载策略:JS Image() 预加载成功后才渲染缩略(规避父级轮询重挂载导致的
 * img 请求中断竞态);视频产物用渐变占位+▶ 角标;点击进作品库。
 */
export function RecentWorksRail({ onOpenLibrary }: { onOpenLibrary: () => void }) {
  const [thumbs, setThumbs] = useState<{ key: string; url: string; kind: string; video: boolean }[]>([]);

  useEffect(() => {
    let alive = true;
    fetchJobsPage(0, 14)
      .then(async (rows) => {
        const done = rows.filter((j) => j.status === "done" && j.results?.length);
        const picked: { key: string; url: string; kind: string; video: boolean }[] = [];
        await Promise.all(
          done.slice(0, 12).map(
            (j) =>
              new Promise<void>((resolve) => {
                const url = j.results[0];
                const isVideo =
                  /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url) || /video/i.test(j.kind);
                const kindLabel = /video|t2v|i2v|h3|animate|lipsync/i.test(j.kind) || isVideo ? "视频" : "图";
                if (isVideo) {
                  picked.push({ key: j.id, url, kind: kindLabel, video: true });
                  resolve();
                  return;
                }
                const im = new Image();
                im.onload = () => {
                  if (alive) picked.push({ key: j.id, url, kind: kindLabel, video: false });
                  resolve();
                };
                im.onerror = () => resolve();
                im.src = imageUrl(url);
              }),
          ),
        );
        if (alive) setThumbs(picked.slice(0, 12));
      })
      .catch(() => {
        /* 静默:装饰性横条 */
      });
    return () => {
      alive = false;
    };
  }, []);

  if (thumbs.length === 0) return null;

  return (
    <section className="av-recent" aria-label="最近作品">
      <div className="av-recent-head">
        <span className="av-recent-title">最近作品</span>
        <button type="button" className="av-recent-more" onClick={onOpenLibrary}>
          作品库 ›
        </button>
      </div>
      <div className="av-recent-rail" role="list">
        {thumbs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="listitem"
            className="av-recent-thumb"
            title="打开作品库查看"
            onClick={onOpenLibrary}
          >
            {t.video ? (
              <span className="av-recent-thumb-video" aria-hidden="true">
                ▶
              </span>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={t.url} alt="" decoding="async" />
            )}
            <span className="av-recent-kind">{t.kind}</span>
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
        .av-recent-thumb-video {
          position: absolute;
          inset: 0;
          display: grid;
          place-items: center;
          color: rgba(255, 255, 255, 0.85);
          font-size: 18px;
          background: linear-gradient(135deg, rgb(30 34 44), rgb(18 20 28));
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
