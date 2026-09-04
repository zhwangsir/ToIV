"use client";

import { useState } from "react";
import type { StudioRenderMode, StudioShot, StudioShotInput } from "@/lib/api";
import { Icon } from "@/components/ui/Icon";
import { Empty } from "@/components/ui/Empty";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import type { useStudioProject } from "@/hooks/useStudioProject";
import { usePoll } from "@/hooks/usePoll";
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
  // 删除分镜确认门(2026-08-30 UX 批 C):直接删改全量列表不可逆,先 Modal 确认
  const [confirmDeleteShot, setConfirmDeleteShot] = useState<StudioShot | null>(null);

  // 批量生成是长任务:期间 5s 轮询刷新(页面隐藏暂停,失败指数退避),分镜状态/媒体实时可见
  usePoll(() => project.refresh(), {
    intervalMs: 5000,
    enabled: renderingAll,
    backoff: true,
    immediate: false,
  });

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
            className={renderingAll ? "btn btn-danger btn-sm" : "btn btn-primary btn-sm"}
            disabled={!renderingAll && shots.length === 0}
            title={renderingAll ? "中止批量渲染(断开请求并尝试中断当前镜 GPU)" : undefined}
            onClick={() => {
              if (renderingAll) {
                project.cancelRenderAll();
                return;
              }
              void project.renderAll().catch(() => {
                /* 错误已由 hook error 提示条透出 */
              });
            }}
          >
            <Icon name={renderingAll ? "close" : "playing"} size={13} />
            {renderingAll ? "中止批量" : "全部生成"}
          </button>
        </div>
      </div>

      {shots.length === 0 ? (
        /* 空态升 section 档(2026-09-04 美化 W3):共享 at-empty 语言替代自写 empty-state 块 */
        <Empty
          size="section"
          icon="film"
          title="还没有分镜"
          desc="回「剧本」阶段 AI 拆解,或点「新增分镜」手动创建。"
        />
      ) : (
        <div className="studio-shot-grid">
          {shots.map((s) => (
            <ShotCard
              key={s.id}
              shot={s}
              projectId={d.id}
              characters={d.characters}
              busyRender={Boolean(project.busy[`render:${s.id}`]) || renderingAll}
              busyVoice={Boolean(project.busy[`voice:${s.id}`])}
              busyLipsync={Boolean(project.busy[`lipsync:${s.id}`])}
              saveState={project.saveState}
              savedAt={project.savedAt}
              onModeChange={(mode: StudioRenderMode) => patchShot(s.id, { render_mode: mode })}
              onPatch={(fields) => patchShot(s.id, fields)}
              onRender={() =>
                void project.renderShot(s.id).catch(() => {
                  /* 错误已由 hook error 提示条透出 */
                })
              }
              onCancelRender={() => project.cancelRenderShot(s.id)}
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
              onDelete={() => setConfirmDeleteShot(s)}
            />
          ))}
        </div>
      )}

      {/* 删除分镜确认(ui/Modal,替代零确认直接删) */}
      <Modal
        open={!!confirmDeleteShot}
        onClose={() => setConfirmDeleteShot(null)}
        title="删除分镜"
        danger
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDeleteShot(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              icon={<Icon name="delete" size={14} />}
              onClick={() => {
                if (!confirmDeleteShot) return;
                deleteShot(confirmDeleteShot.id);
                setConfirmDeleteShot(null);
              }}
            >
              确认删除
            </Button>
          </>
        }
      >
        <p style={{ margin: 0, color: "var(--text-secondary)", lineHeight: 1.6 }}>
          删除分镜 #{confirmDeleteShot ? confirmDeleteShot.idx + 1 : ""}
          {confirmDeleteShot?.scene ? `「${confirmDeleteShot.scene}」` : ""}
          ?其已生成的媒体与配音将一并移除,此操作不可撤销。
        </p>
      </Modal>
    </section>
  );
}
