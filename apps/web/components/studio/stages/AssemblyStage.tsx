"use client";

import { imageUrl } from "@/lib/api";
import { Icon } from "@/components/ui/Icon";
import { Empty } from "@/components/ui/Empty";
import type { useStudioProject } from "@/hooks/useStudioProject";

/**
 * ④ 合成阶段:分镜片段时间轴 + 合成成片 + Batch3 验收条。
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
  const totalSec = d.shots.reduce((n, s) => n + (s.duration_sec || 0), 0);
  const voiced = d.shots.filter((s) =>
    ["voiced", "lipsynced", "done"].includes(s.status),
  ).length;
  const lipsynced = d.shots.filter((s) =>
    ["lipsynced", "done"].includes(s.status),
  ).length;
  const withRefs = d.characters.filter(
    (c) => (c.reference_images || []).filter(Boolean).length >= 1,
  ).length;
  const sceneN = (d.scene_images || []).length;

  return (
    <section className="studio-stage studio-stage-assembly">
      <div className="studio-accept-bar" data-testid="studio-accept-bar">
        <span title="分镜总时长">
          <Icon name="clock" size={12} /> {totalSec}s
        </span>
        <span title="就绪片段">
          <Icon name="film" size={12} /> {ready.length}/{d.shots.length}
        </span>
        <span title="配音">
          <Icon name="mic" size={12} /> {voiced}
        </span>
        <span title="对口型">
          <Icon name="sparkles" size={12} /> {lipsynced}
        </span>
        <span title="定妆角色 / 场景绑定">
          <Icon name="user" size={12} /> {withRefs}/{d.characters.length}
          {sceneN > 0 ? ` · 景${sceneN}` : ""}
        </span>
      </div>

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

      {d.shots.length === 0 ? (
        <Empty
          size="section"
          icon="film"
          title="还没有分镜可合成"
          desc="先到「剧本」拆解或「分镜」新增"
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
