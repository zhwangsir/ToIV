"use client";

import { useEffect } from "react";
import type { StudioRenderMode, StudioShot, StudioShotInput } from "@/lib/api";
import { Icon } from "@/components/ui/Icon";
import type { useStudioProject } from "@/hooks/useStudioProject";
import { ShotCard } from "../ShotCard";

/** StudioShot → 保存输入(全量替换语义:每次提交完整列表)。 */
function toInput(s: StudioShot): StudioShotInput {
  return {
    id: s.id,
    scene: s.scene,
    prompt: s.prompt,
    negative: s.negative,
    camera: s.camera,
    dialogue: s.dialogue,
    speaker: s.speaker,
    duration_sec: s.duration_sec,
    characters: s.characters,
    render_mode: s.render_mode,
  };
}

/**
 * ③ 分镜阶段:分镜网格 + 分镜级混合生成。
 * 所有编辑走全量 saveShots(未包含即删除);批量生成期间每 5s 轮询进度。
 */
export function StoryboardStage({
  project,
}: {
  project: ReturnType<typeof useStudioProject>;
}) {
  const d = project.detail;
  const renderingAll = Boolean(project.busy["render:all"]);

  // 批量生成是长任务:期间轮询刷新,分镜状态/媒体实时可见
  useEffect(() => {
    if (!renderingAll) return;
    const t = setInterval(() => void project.refresh(), 5000);
    return () => clearInterval(t);
  }, [renderingAll, project]);

  if (!d) return null;

  const shots = d.shots;

  /** 全量保存:以 shots 为基线应用变更。失败由 hook error 提示条透出,此处吞掉重抛防 unhandled rejection。 */
  const commit = (next: StudioShotInput[]) =>
    void project.saveShots(next).catch(() => {
      /* 错误已由 hook error 提示条透出 */
    });

  const patchShot = (sid: string, fields: Partial<StudioShotInput>) =>
    commit(shots.map((s) => (s.id === sid ? { ...toInput(s), ...fields } : toInput(s))));

  const deleteShot = (sid: string) =>
    commit(shots.filter((s) => s.id !== sid).map(toInput));

  const addShot = () =>
    commit([
      ...shots.map(toInput),
      { scene: "", prompt: "", render_mode: d.render_mode_default },
    ]);

  const renderedCount = shots.filter((s) =>
    ["rendered", "voiced", "lipsynced", "done"].includes(s.status),
  ).length;

  return (
    <section className="studio-stage studio-stage-board">
      <div className="studio-board-toolbar">
        <span className="studio-board-stat">
          {shots.length} 镜 · 已生成 {renderedCount}
        </span>
        <div className="studio-board-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={addShot}>
            <Icon name="plus" size={13} /> 新增分镜
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={renderingAll || shots.length === 0}
            onClick={() =>
              void project.renderAll().catch(() => {
                /* 错误已由 hook error 提示条透出 */
              })
            }
          >
            <Icon name={renderingAll ? "loading" : "playing"} size={13} />
            {renderingAll ? `批量生成中 ${renderedCount}/${shots.length}` : "全部生成"}
          </button>
        </div>
      </div>

      {shots.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">
            <Icon name="film" size={40} />
          </div>
          <h3 className="empty-state-title">还没有分镜</h3>
          <p className="empty-state-desc">回「剧本」阶段 AI 拆解,或点「新增分镜」手动创建。</p>
        </div>
      ) : (
        <div className="studio-shot-grid">
          {shots.map((s) => (
            <ShotCard
              key={s.id}
              shot={s}
              characters={d.characters}
              busyRender={Boolean(project.busy[`render:${s.id}`]) || renderingAll}
              busyVoice={Boolean(project.busy[`voice:${s.id}`])}
              busyLipsync={Boolean(project.busy[`lipsync:${s.id}`])}
              onModeChange={(mode: StudioRenderMode) => patchShot(s.id, { render_mode: mode })}
              onPatch={(fields) => patchShot(s.id, fields)}
              onRender={() =>
                void project.renderShot(s.id).catch(() => {
                  /* 错误已由 hook error 提示条透出 */
                })
              }
              onVoice={() =>
                void project.voiceShot(s.id).catch(() => {
                  /* 错误已由 hook error 提示条透出 */
                })
              }
              onLipsync={() =>
                void project.lipsyncShot(s.id).catch(() => {
                  /* 错误已由 hook error 提示条透出 */
                })
              }
              onDelete={() => deleteShot(s.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
