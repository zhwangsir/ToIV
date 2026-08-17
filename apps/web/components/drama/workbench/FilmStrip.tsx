"use client";

/**
 * LibTV 式短剧工作台 —— 底部镜头胶片条(Team C)。
 *
 * 横向可滑缩略条:完成=故事板缩略图,无故事板图时回落视频首帧 poster
 * (video preload="metadata"),再无图时状态色块+镜号(完成=ok 底色/生成中=
 * 呼吸边框+accent 底色/排队=灰/失败=err 底色+红色角标,四态可区分);
 * 当前镜高亮描边,点击 onPick;右端仅「合成成片」按钮(onAssemble)。
 * 由 WorkbenchShell 底部插槽渲染(仅短片阶段),容器 .wb-filmstrip 已有。
 *
 * 进度双显去重(2026-08-16 批 2):原右端汇总 `n/N 已完成 · 总时长` 与顶栏
 * .wb-progress 完全重复,择顶栏保留,本组件不再渲染汇总文案。
 */
import { imageUrl } from "@/lib/api";
import { Icon } from "@/components/ui/Icon";
import type { FilmStripProps } from "./types";
import { shotTone, SHOT_TONE_LABEL } from "./ShotTableRow";

export function FilmStrip({ shots, currentSid, onPick, onAssemble }: FilmStripProps) {
  const doneCount = shots.filter((s) => shotTone(s.video_status) === "done").length;

  return (
    <>
      <div className="wb-film-track" role="listbox" aria-label="镜头胶片条">
        {shots.map((s) => {
          const tone = shotTone(s.video_status);
          const videoSrc =
            s.continue_concat_url || s.lipsync_video_url || s.video_url || "";
          return (
            <button
              key={s.id}
              type="button"
              role="option"
              aria-selected={s.id === currentSid}
              className={`wb-film is-${tone}${s.id === currentSid ? " is-current" : ""}`}
              title={`#${s.idx} · ${SHOT_TONE_LABEL[tone]}${s.error ? ` · ${s.error}` : ""}`}
              onClick={() => onPick(s.id)}
            >
              {tone === "done" && s.keyframe_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={imageUrl(s.keyframe_url)}
                  alt={`镜头 ${s.idx}`}
                  width={72}
                  height={40}
                />
              ) : tone === "done" && videoSrc ? (
                <video
                  src={imageUrl(videoSrc)}
                  preload="metadata"
                  muted
                  playsInline
                  width={72}
                  height={40}
                  aria-label={`镜头 ${s.idx} 视频首帧`}
                />
              ) : (
                <span className="wb-film-idx">#{s.idx}</span>
              )}
              {tone === "error" && <span className="wb-film-errdot" aria-hidden="true" />}
            </button>
          );
        })}
        {shots.length === 0 && <span className="wb-dim">暂无镜头</span>}
      </div>
      <button
        type="button"
        className="btn btn-primary btn-sm"
        disabled={doneCount === 0}
        title={doneCount === 0 ? "需至少 1 个已完成镜头" : "合成全部已完成镜头为成片"}
        onClick={onAssemble}
      >
        <Icon name="film" size={14} />
        合成成片
      </button>
    </>
  );
}
