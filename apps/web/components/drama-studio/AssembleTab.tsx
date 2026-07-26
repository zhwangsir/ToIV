"use client";

import { imageUrl } from "@/lib/api";
import { Icon } from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toast";
import type { UseDramaProjectReturn } from "@/hooks/useDramaProject";

interface AssembleTabProps {
  project: UseDramaProjectReturn;
  onGoToShot?: () => void;
}

/**
 * 一键合成 Tab。
 * - 将已完成(done)分镜视频按顺序拼接,自动配音 + 字幕
 * - 展示合成结果(成片名/时长/下载/内嵌播放器)
 */
export function AssembleTab({ project, onGoToShot }: AssembleTabProps) {
  const {
    doneCount,
    shots,
    assemble,
    assembling,
    assembleResult,
    assembleError,
    clearAssembleResult,
  } = project;
  const { show: showToast } = useToast();

  const hasReady = doneCount > 0;

  // M3.2:合成前提示 ETA(ffmpeg 拼接 + 配音,预计 30-60 秒)
  const handleAssemble = () => {
    if (assembling) return;
    showToast("info", `开始合成 ${doneCount} 个分镜,预计 30-60 秒`);
    assemble();
  };

  return (
    <section className="ds-section ds-assemble card">
      <div className="ds-section-head">
        <Icon name="playing" size={14} />
        <span className="ds-section-title">一键合成</span>
      </div>
      {!hasReady ? (
        <div className="empty-state">
          <div className="empty-state-icon">
            <Icon name="playing" size={36} strokeWidth={1.3} />
          </div>
          <div className="empty-state-title">暂无可合成的视频</div>
          <div className="empty-state-desc">
            {shots.length === 0
              ? "先去剧本 Tab 拆分镜,再为每个分镜生成视频"
              : `共 ${shots.length} 个分镜,已出片 0 个,先去分镜板生成视频`}
          </div>
          {onGoToShot && (
            <button type="button" className="btn btn-primary btn-sm" onClick={onGoToShot}>
              <Icon name="film" size={13} />
              {shots.length === 0 ? "去剧本 Tab" : "去分镜板"}
            </button>
          )}
        </div>
      ) : (
      <div className="ds-assemble-row">
        <span className="ds-assemble-hint">
          将 {doneCount} 个已完成分镜视频按顺序拼接 · 自动配音 + 字幕
        </span>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={handleAssemble}
          disabled={assembling}
          title="ffmpeg 拼接 + 自动配音 + 字幕,预计 30-60 秒"
        >
          {assembling ? (
            <>
              <Icon name="loading" size={13} className="ds-spin" />
              合成中…
            </>
          ) : (
            <>
              <Icon name="playing" size={13} />
              合成成片
            </>
          )}
        </button>
      </div>
      )}
      {assembleError && (
        <div className="ds-error-inline">{assembleError}</div>
      )}
      {assembleResult && (
        <div className="ds-assemble-result">
          <div className="ds-assemble-result-head">
            <Icon name="success" size={14} />
            <span>成片已合成 · {assembleResult.name}</span>
            <span className="ds-assemble-dur">
              {assembleResult.duration_sec.toFixed(1)}s
            </span>
            <a
              className="btn btn-sm btn-primary"
              href={imageUrl(assembleResult.url)}
              target="_blank"
              rel="noreferrer"
            >
              <Icon name="download" size={12} />
              下载
            </a>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={clearAssembleResult}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
          <video
            src={imageUrl(assembleResult.url)}
            controls
            playsInline
            preload="metadata"
            className="ds-assemble-video"
          />
        </div>
      )}
    </section>
  );
}
