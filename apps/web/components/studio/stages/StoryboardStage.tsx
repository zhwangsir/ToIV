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

const FOCUS_LABEL: Record<"video" | "voice" | "lipsync", string> = {
  video: "视频",
  voice: "配音",
  lipsync: "对口型",
};

/**
 * ③ 分镜阶段:分镜网格 + 分镜级混合生成 + Batch2 督导条。
 * 所有编辑走全量 saveShots(未包含即删除);批量生成期间每 5s 轮询进度。
 * focus=视频/配音/对口型 时复用本组件(步骤条薄过滤)。
 */
export function StoryboardStage({
  project,
  focus,
}: {
  project: ReturnType<typeof useStudioProject>;
  /** Batch2:从步骤条「视频/配音/对口型」进入时的工作焦点 */
  focus?: "video" | "voice" | "lipsync";
}) {
  const d = project.detail;
  const renderingAll = Boolean(project.busy["render:all"]);
  // 删除分镜确认门(2026-08-30 UX 批 C):直接删改全量列表不可逆,先 Modal 确认
  const [confirmDeleteShot, setConfirmDeleteShot] = useState<StudioShot | null>(null);
  const [rerunningFailed, setRerunningFailed] = useState(false);
  const [stepRerunning, setStepRerunning] = useState(false);
  // Batch2 视频步默认:H3 + 每镜 2 候选
  const [videoModel, setVideoModel] = useState<"h3" | "ltx">("h3");
  const [numCandidates, setNumCandidates] = useState(2);

  // 批量生成是长任务:期间 5s 轮询刷新(页面隐藏暂停,失败指数退避),分镜状态/媒体实时可见
  usePoll(() => project.refresh(), {
    intervalMs: 5000,
    enabled: renderingAll || rerunningFailed || stepRerunning,
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

  const errored = shots.filter((s) => s.status === "error");
  const rendering = shots.filter((s) => s.status === "rendering" || s.status === "queued");
  const doneCount = shots.filter((s) =>
    ["rendered", "voiced", "lipsynced", "done"].includes(s.status),
  ).length;

  const rerunFailed = async () => {
    const targets = shots.filter((s) => s.status === "error");
    if (targets.length === 0 || rerunningFailed) return;
    setRerunningFailed(true);
    try {
      // 顺序重跑失败镜(复用 renderShot;不走 renderAll 以免误伤进行中任务)
      for (const s of targets) {
        try {
          await project.renderShot(s.id);
        } catch {
          /* 单镜失败继续下一镜;错误条由 hook 透出 */
        }
      }
    } finally {
      setRerunningFailed(false);
    }
  };

  /** Batch5:当前步整组重跑(未完成/失败镜);错误经 hook 透出 */
  const rerunStepGroup = async () => {
    if (stepRerunning) return;
    const step =
      focus === "voice" ? "voice" : focus === "lipsync" ? "lipsync" : focus === "video" ? "video" : "storyboard";
    setStepRerunning(true);
    try {
      await project.rerunStep(step);
    } catch {
      /* 错误已由 hook error 提示条透出 */
    } finally {
      setStepRerunning(false);
    }
  };

  // focus 薄过滤:视频看未渲/失败;配音看已渲未配;对口型看已配未对口
  let visible = shots;
  if (focus === "video") {
    visible = shots.filter(
      (s) => !["rendered", "voiced", "lipsynced", "done"].includes(s.status) || s.status === "error",
    );
    if (visible.length === 0) visible = shots;
  } else if (focus === "voice") {
    const need = shots.filter(
      (s) => ["rendered"].includes(s.status) || (s.dialogue && !["voiced", "lipsynced", "done"].includes(s.status)),
    );
    if (need.length > 0) visible = need;
  } else if (focus === "lipsync") {
    const need = shots.filter((s) => s.status === "voiced");
    if (need.length > 0) visible = need;
  }

  return (
    <section className="studio-stage studio-stage-board">
      {focus && (
        <p className="studio-focus-banner" data-focus={focus}>
          <Icon name={focus === "voice" ? "mic" : focus === "lipsync" ? "sparkles" : "video"} size={12} />
          {FOCUS_LABEL[focus]}
        </p>
      )}

      {focus === "voice" && (
        <div className="studio-voice-toolbar" data-testid="studio-voice-toolbar">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={
              shots.filter((s) => s.dialogue && !["voiced", "lipsynced", "done"].includes(s.status)).length === 0 ||
              Object.keys(project.busy).some((k) => k.startsWith("voice:"))
            }
            title="对有台词且未配音的分镜一键配音"
            onClick={() => {
              const targets = shots.filter(
                (s) => s.dialogue && !["voiced", "lipsynced", "done"].includes(s.status),
              );
              void (async () => {
                for (const s of targets) {
                  try {
                    await project.voiceShot(s.id);
                  } catch {
                    /* 单镜失败继续;错误条由 hook 透出 */
                  }
                }
              })();
            }}
          >
            <Icon name="mic" size={13} />
            一键配音
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            data-testid="studio-step-rerun"
            disabled={stepRerunning || Object.keys(project.busy).some((k) => k.startsWith("voice:") || k.startsWith("rerun:"))}
            title="整组重跑未完成/失败镜"
            onClick={() => void rerunStepGroup()}
          >
            <Icon name={stepRerunning ? "loading" : "refresh"} size={13} />
            整组重跑
          </button>
        </div>
      )}

      {focus === "lipsync" && (
        <div className="studio-lipsync-toolbar" data-testid="studio-lipsync-toolbar">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={
              shots.filter((s) => s.status === "voiced" || (s.video_url && s.voice_url)).length === 0 ||
              Object.keys(project.busy).some((k) => k.startsWith("lipsync:"))
            }
            title="对已配音分镜一键对口型"
            onClick={() => {
              const targets = shots.filter(
                (s) => s.status === "voiced" || (Boolean(s.video_url) && Boolean(s.voice_url)),
              );
              void (async () => {
                for (const s of targets) {
                  try {
                    await project.lipsyncShot(s.id);
                  } catch {
                    /* 单镜失败继续 */
                  }
                }
              })();
            }}
          >
            <Icon name="sparkles" size={13} />
            一键对口型
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            data-testid="studio-step-rerun"
            disabled={stepRerunning || Object.keys(project.busy).some((k) => k.startsWith("lipsync:") || k.startsWith("rerun:"))}
            title="整组重跑未完成/失败镜"
            onClick={() => void rerunStepGroup()}
          >
            <Icon name={stepRerunning ? "loading" : "refresh"} size={13} />
            整组重跑
          </button>
        </div>
      )}

      {focus === "video" && (
        <div className="studio-video-toolbar" data-testid="studio-video-toolbar">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            data-testid="studio-step-rerun"
            disabled={stepRerunning || renderingAll || rerunningFailed}
            title="整组重跑未完成/失败镜"
            onClick={() => void rerunStepGroup()}
          >
            <Icon name={stepRerunning ? "loading" : "refresh"} size={13} />
            整组重跑
          </button>
          <label>
            <Icon name="zap" size={12} />
            <select
              value={videoModel}
              aria-label="默认引擎"
              onChange={(e) => setVideoModel(e.target.value === "ltx" ? "ltx" : "h3")}
            >
              <option value="h3">H3</option>
              <option value="ltx">LTX</option>
            </select>
          </label>
          <label>
            候选
            <select
              value={numCandidates}
              aria-label="默认候选数"
              onChange={(e) => setNumCandidates(Number(e.target.value))}
            >
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {/* Batch2 督导条:失败/渲染中/完成计数 + 重跑失败 */}
      {shots.length > 0 && (
        <div className="studio-supervise" data-testid="studio-supervise">
          <div className="studio-supervise-stats">
            <span className="studio-supervise-item is-error">
              <Icon name="alert" size={12} /> {errored.length}
            </span>
            <span className="studio-supervise-item is-busy">
              <Icon name="loading" size={12} /> {rendering.length}
            </span>
            <span className="studio-supervise-item is-ok">
              <Icon name="check" size={12} /> {doneCount}
            </span>
          </div>
          {errored.length > 0 && (
            <ul className="studio-supervise-errors">
              {errored.slice(0, 6).map((s) => (
                <li key={s.id} title={s.error || ""}>
                  #{s.idx + 1} {(s.error || "失败").slice(0, 48)}
                  {(s.error || "").length > 48 ? "…" : ""}
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-sm studio-supervise-rerun"
            disabled={errored.length === 0 || renderingAll || rerunningFailed || stepRerunning}
            onClick={() => void rerunFailed()}
          >
            <Icon name={rerunningFailed ? "loading" : "refresh"} size={13} />
            重跑失败
          </button>
          {!focus && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              data-testid="studio-step-rerun"
              disabled={stepRerunning || renderingAll}
              title="整组重跑未完成/失败镜"
              onClick={() => void rerunStepGroup()}
            >
              <Icon name={stepRerunning ? "loading" : "refresh"} size={13} />
              整组重跑
            </button>
          )}
        </div>
      )}

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
          {visible.map((s) => (
            <ShotCard
              key={s.id}
              shot={s}
              projectId={d.id}
              characters={d.characters}
              busyRender={Boolean(project.busy[`render:${s.id}`]) || renderingAll || rerunningFailed}
              busyVoice={Boolean(project.busy[`voice:${s.id}`])}
              busyLipsync={Boolean(project.busy[`lipsync:${s.id}`])}
              saveState={project.saveState}
              savedAt={project.savedAt}
              videoFocus={focus === "video"}
              defaultVideoModel={videoModel}
              defaultNumCandidates={numCandidates}
              projectSceneImages={d.scene_images || []}
              onModeChange={(mode: StudioRenderMode) => patchShot(s.id, { render_mode: mode })}
              onPatch={(fields) => patchShot(s.id, fields)}
              onRender={(body) =>
                void project
                  .renderShot(
                    s.id,
                    body ??
                      (focus === "video"
                        ? { video_model: videoModel, num_candidates: numCandidates }
                        : undefined),
                  )
                  .catch(() => {
                    /* 错误已由 hook error 提示条透出 */
                  })
              }
              onPickCandidate={(cid) =>
                void project.pickCandidate(s.id, cid).catch(() => {
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
