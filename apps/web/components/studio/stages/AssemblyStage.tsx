"use client";

import { imageUrl } from "@/lib/api";
import { Icon } from "@/components/ui/Icon";
import { Empty } from "@/components/ui/Empty";
import type { useStudioProject } from "@/hooks/useStudioProject";

/**
 * ④ 合成阶段:分镜片段时间轴 + 合成成片。
 * 就绪判定:final_clip_url 非空(渲染链产出);合成后展示成片播放器与下载。
 */
export function AssemblyStage({
  project,
}: {
  project: ReturnType<typeof useStudioProject>;
}) {
  const d = project.detail;
  if (!d) return null;

  const ready = d.shots.filter((s) => s.final_clip_url);
  const assembling = Boolean(project.busy["assemble"]);

  return (
    <section className="studio-stage studio-stage-assembly">
      <div className="studio-board-toolbar">
        <span className="studio-board-stat">
          就绪 {ready.length}/{d.shots.length} 镜
        </span>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={assembling || ready.length === 0}
          title={ready.length < d.shots.length ? "存在未就绪分镜,将仅拼接就绪片段" : ""}
          onClick={() =>
            void project.assemble().catch(() => {
              /* 错误已由 hook error 提示条透出 */
            })
          }
        >
          <Icon name={assembling ? "loading" : "film"} size={13} />
          {assembling ? "合成中…" : "合成成片"}
        </button>
      </div>

      {/* 分镜片段时间轴;无分镜时给引导空态(2026-08-30 UX 批 C),不再渲染空列表 */}
      {d.shots.length === 0 ? (
        <Empty
          icon="film"
          title="还没有分镜可合成"
          desc="先到「剧本」阶段 AI 拆解剧情生成分镜,或在「分镜」阶段点「新增分镜」手动创建;生成完毕后再回来合成成片"
        />
      ) : (
        <ol className="studio-timeline">
          {d.shots.map((s) => (
            <li key={s.id} className="studio-timeline-item" data-ready={Boolean(s.final_clip_url)}>
              <span className="studio-timeline-idx">#{s.idx + 1}</span>
              <div className="studio-timeline-media">
                {s.final_clip_url ? (
                  <video src={imageUrl(s.final_clip_url)} controls playsInline preload="metadata" />
                ) : (
                  <div className="studio-shot-empty">
                    <Icon name="image" size={18} />
                    <span>未就绪</span>
                  </div>
                )}
              </div>
              <span className="studio-timeline-scene">{s.scene || s.prompt || "—"}</span>
            </li>
          ))}
        </ol>
      )}

      {/* 成片 */}
      {d.final_url && (
        <div className="studio-final">
          <h3 className="studio-final-title">
            <Icon name="clapperboard" size={16} /> 成片
          </h3>
          <video
            className="studio-final-player"
            src={imageUrl(d.final_url)}
            controls
            playsInline
          />
          <a className="btn btn-ghost btn-sm" href={imageUrl(d.final_url)} download>
            <Icon name="download" size={13} /> 下载成片
          </a>
        </div>
      )}
    </section>
  );
}
