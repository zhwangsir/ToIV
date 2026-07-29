"use client";

import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toast";
import type { UseDramaProjectReturn } from "@/hooks/useDramaProject";
import { ShotCard } from "@/components/drama-studio/ShotCard";
import {
  getDramaPolishTask,
  polishDramaBatch,
  type DramaPolishTask,
} from "@/lib/api";

interface ShotTabProps {
  project: UseDramaProjectReturn;
  onGoToScript?: () => void;
}

/** L3 批量精修轮询间隔(ms)。GLM-5.2-fp8 单镜 ~115s,10s 轮询足够。 */
const POLL_INTERVAL_MS = 10_000;
/** 轮询最大时长(ms),15 分钟超时。 */
const POLL_MAX_MS = 15 * 60 * 1000;

/**
 * 分镜板 Tab。
 * - 展示 AI 拆分镜产出的分镜列表
 * - 每镜渲染 ShotCard(视频/配音/导演台/编辑/模型选择)
 * - L3 异步批量精修:并发处理所有分镜 prompt,完成回写 shot.prompt
 */
export function ShotTab({ project, onGoToScript }: ShotTabProps) {
  const { shots, doneCount, reload } = project;
  const { show: showToast } = useToast();

  // M1:批量生成候选数(1/2/4)
  const [numCandidates, setNumCandidates] = useState<number>(1);

  // L3 批量精修状态
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchTask, setBatchTask] = useState<DramaPolishTask | null>(null);
  const [batchError, setBatchError] = useState<string>("");
  const [confirmingBatch, setConfirmingBatch] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollStartRef = useRef<number>(0);

  // 卸载时清理轮询定时器
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, []);

  const _availableShots = () =>
    shots.filter(
      (s) => (s.prompt || s.dialogue || s.scene || "").trim().length > 0,
    );

  /** 启动 L3 批量精修:所有分镜 prompt+dialogue+scene 送 L3 并发精修。 */
  const handleBatchPolish = async () => {
    if (batchBusy) return;
    if (shots.length === 0) {
      showToast("error", "暂无分镜,无法批量精修");
      return;
    }
    const available = _availableShots();
    if (available.length === 0) {
      showToast("error", "所有分镜内容为空,无法批量精修");
      return;
    }
    if (!confirmingBatch) {
      setConfirmingBatch(true);
      setTimeout(() => setConfirmingBatch(false), 5000);
      return;
    }
    setConfirmingBatch(false);
    setBatchBusy(true);
    setBatchError("");
    setBatchTask(null);
    showToast("success", `已启动 L3 批量精修,处理 ${available.length} 个分镜`);
    try {
      const res = await polishDramaBatch(project.current!.id, {
        shot_ids: available.map((s) => s.id),
      });
      await _pollTask(res.task_id);
    } catch (err) {
      setBatchError(
        err instanceof Error ? err.message : "L3 批量精修启动失败",
      );
      setBatchBusy(false);
    }
  };

  /** 轮询批量精修任务进度,完成或超时后停止。 */
  const _pollTask = async (taskId: string) => {
    pollStartRef.current = Date.now();

    const pollOnce = async () => {
      try {
        const task = await getDramaPolishTask(project.current!.id, taskId);
        setBatchTask(task);
        if (task.status === "done") {
          setBatchBusy(false);
          const ok = task.results.filter((r) => r.status === "done").length;
          const fail = task.results.filter((r) => r.status === "error").length;
          if (fail === 0) {
            showToast("success", `L3 精修完成:${ok} 个分镜已优化`);
          } else {
            showToast("error", `L3 精修完成:${ok} 成功 / ${fail} 失败`);
          }
          try {
            await reload();
          } catch {
            // ignore
          }
          return;
        }
        // 超时保护
        if (Date.now() - pollStartRef.current > POLL_MAX_MS) {
          setBatchError("批量精修轮询超时(15 分钟),任务仍在后端执行,可稍后刷新查看");
          setBatchBusy(false);
          return;
        }
        pollTimerRef.current = setTimeout(pollOnce, POLL_INTERVAL_MS);
      } catch (err) {
        setBatchError(
          err instanceof Error ? err.message : "查询批量精修进度失败",
        );
        setBatchBusy(false);
      }
    };

    await pollOnce();
  };

  /** 关闭批量精修结果面板。 */
  const closeBatchPanel = () => {
    setBatchTask(null);
    setBatchError("");
  };

  return (
    <section className="ds-section ds-shots-section">
      <div className="ds-section-head">
        <Icon name="film" size={14} />
        <span className="ds-section-title">分镜板</span>
        {shots.length > 0 && (
          <span className="ds-section-count">{shots.length}</span>
        )}
        {doneCount > 0 && (
          <span className="ds-section-hint">{doneCount} 镜已出片</span>
        )}
        {shots.length > 0 && (
          <button
            type="button"
            className={`btn btn-sm ds-batch-polish-btn ${confirmingBatch ? "btn-danger" : ""}`}
            onClick={handleBatchPolish}
            disabled={batchBusy}
            title="L3 GLM-5.2-fp8 并发精修所有分镜 prompt,完成回写"
          >
            {batchBusy ? (
              <>
                <Icon name="loading" size={13} className="ds-spin" />
                精修中…
              </>
            ) : confirmingBatch ? (
              <>
                <Icon name="warning" size={13} />
                确认执行?
              </>
            ) : (
              <>
                <Icon name="sparkles" size={13} />
                L3 批量精修
              </>
            )}
          </button>
        )}
      </div>

      {/* M2.1:批量操作工具栏(单镜生成视频/配音按钮已移至此处统一入口) */}
      {shots.length > 0 && (
        <div className="ds-batch-toolbar">
          <div className="ds-batch-candidates">
            <label className="ds-field-label">候选数</label>
            <select
              className="ds-input ds-batch-candidates-select"
              value={numCandidates}
              onChange={(e) => setNumCandidates(Number(e.target.value))}
              disabled={project.activeTaskCount > 0}
            >
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={4}>4</option>
            </select>
          </div>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => project.generateAllShots(numCandidates)}
            disabled={project.activeTaskCount > 0}
            title="LTX 文生视频,每镜约 1-2 分钟(异步,完成后回写)"
          >
            <Icon name="video" size={12} />
            生成全部视频
            {project.pendingCount > 0 && (
              <span className="ds-batch-count">{project.pendingCount}</span>
            )}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => project.generateAllVoices()}
            disabled={project.activeTaskCount > 0}
            title="IndexTTS2 同步配音,每个约 10 秒(需台词)"
          >
            <Icon name="audio" size={12} />
            批量配音
          </button>
        </div>
      )}

      {/* L3 批量精修进度面板 */}
      {(batchBusy || batchTask || batchError) && (
        <div className="ds-batch-polish-panel card">
          <div className="ds-batch-polish-head">
            <span className="ds-batch-polish-title">
              <Icon name="sparkles" size={13} />
              L3 批量精修
              {batchTask && (
                <span className="ds-batch-polish-model">
                  {batchTask.model}
                </span>
              )}
            </span>
            {!batchBusy && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={closeBatchPanel}
                title="关闭"
              >
                <Icon name="close" size={12} />
              </button>
            )}
          </div>

          {batchError && (
            <div className="ds-error-inline">{batchError}</div>
          )}

          {batchTask && (
            <>
              <div className="ds-batch-polish-progress">
                <div className="ds-batch-polish-bar-bg">
                  <div
                    className="ds-batch-polish-bar-fill"
                    style={{
                      width: `${
                        batchTask.total > 0
                          ? (batchTask.done / batchTask.total) * 100
                          : 0
                      }%`,
                    }}
                  />
                </div>
                <span className="ds-batch-polish-count">
                  {batchTask.done} / {batchTask.total}
                  <span className="ds-batch-polish-status">
                    {batchTask.status === "pending" && "等待中…"}
                    {batchTask.status === "running" && "精修中…"}
                    {batchTask.status === "done" && "已完成"}
                  </span>
                </span>
              </div>

              {/* 完成后展示结果摘要(成功/失败计数 + 失败详情) */}
              {batchTask.status === "done" && (
                <div className="ds-batch-polish-summary">
                  {(() => {
                    const ok = batchTask.results.filter(
                      (r) => r.status === "done",
                    ).length;
                    const fail = batchTask.results.filter(
                      (r) => r.status === "error",
                    ).length;
                    return (
                      <>
                        <span className="ds-batch-ok">成功 {ok}</span>
                        {fail > 0 && (
                          <span className="ds-batch-fail">失败 {fail}</span>
                        )}
                      </>
                    );
                  })()}
                </div>
              )}

              {/* 失败分镜列表(可展开) */}
              {batchTask.status === "done" &&
                batchTask.results.some((r) => r.status === "error") && (
                  <details className="ds-batch-polish-errors">
                    <summary>查看失败详情</summary>
                    <ul>
                      {batchTask.results
                        .filter((r) => r.status === "error")
                        .map((r, i) => (
                          <li key={r.shot_id ?? i}>
                            <strong>
                              {r.shot_id ? `分镜 ${r.shot_id.slice(0, 8)}` : `文本 ${i + 1}`}
                            </strong>
                            <span>{r.error || "未知错误"}</span>
                          </li>
                        ))}
                    </ul>
                  </details>
                )}
            </>
          )}
        </div>
      )}

      {shots.length === 0 && (
        <div className="empty-state ds-shots-empty">
          <div className="empty-state-icon">
            <Icon name="film" size={36} strokeWidth={1.3} />
          </div>
          <div className="empty-state-title">暂无分镜</div>
          <div className="empty-state-desc">
            由剧本自动拆分镜头脚本
          </div>
          {onGoToScript && (
            <button type="button" className="btn btn-primary btn-sm" onClick={onGoToScript}>
              <Icon name="sparkles" size={13} /> 去剧本 Tab 拆分镜
            </button>
          )}
        </div>
      )}

      {shots.length > 0 && (
        <div className="ds-shots">
          {shots.map((s) => (
            <ShotCard key={s.id} shot={s} project={project} />
          ))}
        </div>
      )}
    </section>
  );
}
