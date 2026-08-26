"use client";

/**
 * H3 多镜头单次生成编辑器(对标 Vidu Q3 单 prompt 多镜头 / PixVerse MultiShot):
 * 镜头卡列表(2-4 个,可增删/拖拽排序)→ 每镜头 prompt + 时长滑块(2-8s)
 * + 运镜提示(可选下拉)+ 转场提示(可选下拉,首镜头无)→ 总时长实时计算(≤15s 护栏)
 * → 提交 POST /api/h3/multishot → busy 态轮询作业,成片内联播放。
 *
 * 集成:GenerateView 选中「H3 多镜头」引擎(h3-multishot)时在舞台列渲染本编辑器
 * (替代 PromptBar;镜头与提交参数均由本编辑器承载)。
 * 全部 JSX 在单一组件内:<style jsx> 作用域类仅覆盖主组件自身元素(2026-08-24 P-2b 教训)。
 */
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { Icon } from "@/components/ui/Icon";
import { Field, Input, Select, Textarea } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { fetchJobsPage, imageUrl, invalidateJobs } from "@/lib/api";
import {
  MULTISHOT_CAMERA_OPTIONS,
  MULTISHOT_DEFAULT_SHOT_SEC,
  MULTISHOT_MAX_SHOTS,
  MULTISHOT_MAX_SHOT_SEC,
  MULTISHOT_MAX_TOTAL_SEC,
  MULTISHOT_MIN_SHOT_SEC,
  MULTISHOT_MIN_SHOTS,
  MULTISHOT_TRANSITION_OPTIONS,
  multishotSubmittable,
  multishotTotalDuration,
  reorderShots,
  submitMultiShot,
  type ShotDraft,
} from "@/lib/multishot";

function newShot(): ShotDraft {
  return { prompt: "", durationSec: MULTISHOT_DEFAULT_SHOT_SEC, cameraHint: "", transitionHint: "" };
}

/** 作业轮询终态(running 继续轮询;held 展示排队文案)。 */
type RunStatus = "running" | "done" | "error" | "held";

export function MultiShotEditor() {
  const toast = useToast();
  const [shots, setShots] = useState<ShotDraft[]>([newShot(), newShot()]);
  // 高级参数(尺寸/采样/种子;与 h3-t2v 同一套范围)
  const [width, setWidth] = useState(1344);
  const [height, setHeight] = useState(768);
  const [steps, setSteps] = useState(20);
  const [seedText, setSeedText] = useState("");
  const [error, setError] = useState<string | null>(null);
  // 拖拽排序:dragIndex 记录源镜头,dragOver 提供落点高亮
  const dragIndex = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  // 提交与作业轮询(busy 态)
  const [submitting, setSubmitting] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<RunStatus>("running");
  const [resultUrl, setResultUrl] = useState<string | null>(null);

  const totalDuration = multishotTotalDuration(shots.map((s) => s.durationSec));
  const overTotal = totalDuration > MULTISHOT_MAX_TOTAL_SEC;
  const busy = submitting || (runId !== null && runStatus !== "done" && runStatus !== "error");
  const canSubmit = multishotSubmittable({ shots, busy });

  // 作业轮询:提交后每 5s 拉作业列表,按 prompt_id 跟进 done/error/held
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const jobs = await fetchJobsPage(0, 200);
        if (cancelled) return;
        const job = jobs.find((j) => j.prompt_id === runId);
        if (!job) return;
        if (job.status === "done") {
          setRunStatus("done");
          setResultUrl(job.results[0] ?? null);
          invalidateJobs(); // 成片已落库,作品库缓存失效
          toast.success("多镜头成片已生成");
        } else if (job.status === "error") {
          setRunStatus("error");
        } else if (job.status === "held") {
          setRunStatus("held");
        } else {
          setRunStatus("running");
        }
      } catch {
        /* 网络抖动下轮再试 */
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const patchShot = (idx: number, patch: Partial<ShotDraft>) =>
    setShots((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));

  function removeShot(idx: number) {
    setShots((prev) => (prev.length > MULTISHOT_MIN_SHOTS ? prev.filter((_, i) => i !== idx) : prev));
  }

  async function onSubmit() {
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      const seed = seedText.trim() ? Number(seedText) : null;
      const res = await submitMultiShot({
        shots,
        width,
        height,
        steps,
        ...(seed !== null && Number.isInteger(seed) && seed >= 0 ? { seed } : {}),
      });
      setRunId(res.prompt_id);
      setRunStatus("running");
      setResultUrl(null);
      if (typeof res.queued_behind === "number" && res.queued_behind > 0) {
        toast.info(`已加入 H3 队列:前方还有 ${res.queued_behind} 个作业(排队等待,非故障)`);
      } else {
        toast.success(`多镜头已提交(${shots.length} 个镜头,共 ${totalDuration}s)`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "提交失败");
    } finally {
      setSubmitting(false);
    }
  }

  const busyLabel =
    runStatus === "held" ? "资源排队中…" : submitting ? "提交中…" : "生成中(单段多镜头)…";

  return (
    <div className="ms-editor">
      {/* 镜头卡列表:链序排列,拖拽排序;每卡 prompt/时长滑块/运镜/转场 */}
      <div className="ms-shots" role="list" aria-label="多镜头链序">
        {shots.map((shot, i) => (
          <div
            key={i}
            role="listitem"
            className={`ms-shot-card${dragOver === i ? " is-dragover" : ""}`}
            draggable={!busy}
            onDragStart={() => {
              dragIndex.current = i;
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(i);
            }}
            onDragLeave={() => setDragOver((v) => (v === i ? null : v))}
            onDrop={(e) => {
              e.preventDefault();
              const from = dragIndex.current;
              dragIndex.current = null;
              setDragOver(null);
              if (from !== null) {
                setShots((prev) => reorderShots(prev, from, i));
              }
            }}
            title={`镜头 ${i + 1}(拖拽调整顺序)`}
          >
            <div className="ms-shot-head">
              <span className="ms-shot-title">
                <Icon name="film" size={13} />
                镜头 {i + 1}
              </span>
              <span className="ms-shot-dur">{shot.durationSec}s</span>
              {shots.length > MULTISHOT_MIN_SHOTS && (
                <button
                  type="button"
                  className="ms-shot-remove"
                  aria-label={`移除镜头 ${i + 1}`}
                  disabled={busy}
                  onClick={() => removeShot(i)}
                >
                  <Icon name="close" size={11} />
                </button>
              )}
            </div>
            <Textarea
              rows={2}
              value={shot.prompt}
              placeholder="主体 + 动作 + 场景,如:深夜便利店,中年女人整理货架"
              disabled={busy}
              aria-label={`镜头 ${i + 1} 提示词`}
              onChange={(e) => patchShot(i, { prompt: e.target.value })}
            />
            <div className="ms-shot-row">
              <input
                type="range"
                min={MULTISHOT_MIN_SHOT_SEC}
                max={MULTISHOT_MAX_SHOT_SEC}
                step={0.5}
                value={shot.durationSec}
                disabled={busy}
                aria-label={`镜头 ${i + 1} 时长(秒)`}
                onChange={(e) => patchShot(i, { durationSec: Number(e.target.value) })}
              />
              <Select
                value={shot.cameraHint}
                disabled={busy}
                aria-label={`镜头 ${i + 1} 运镜提示`}
                onChange={(e) => patchShot(i, { cameraHint: e.target.value })}
              >
                <option value="">运镜(可选)</option>
                {MULTISHOT_CAMERA_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
              {i > 0 && (
                <Select
                  value={shot.transitionHint}
                  disabled={busy}
                  aria-label={`镜头 ${i + 1} 转场提示`}
                  onChange={(e) => patchShot(i, { transitionHint: e.target.value })}
                >
                  <option value="">转场(默认硬切)</option>
                  {MULTISHOT_TRANSITION_OPTIONS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </Select>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="ms-shot-actions">
        {shots.length < MULTISHOT_MAX_SHOTS && (
          <Button
            variant="ghost"
            size="sm"
            icon={<Icon name="plus" size={13} />}
            disabled={busy}
            onClick={() => setShots((prev) => [...prev, newShot()])}
          >
            添加镜头
          </Button>
        )}
        <span className="ms-shot-hint">
          {shots.length}/{MULTISHOT_MAX_SHOTS} 个镜头 · 每镜头 {MULTISHOT_MIN_SHOT_SEC}-
          {MULTISHOT_MAX_SHOT_SEC}s · 单段内按序自动切镜
        </span>
      </div>

      {/* 镜头时长分配可视化 + 总时长实时预览(≤15s 护栏) */}
      <div className="ms-total">
        <div className="ms-total-bar" aria-hidden="true">
          {shots.map((s, i) => (
            <span
              key={i}
              className={`ms-total-seg ms-total-seg-${i % 4}`}
              style={{ width: `${(s.durationSec / Math.max(totalDuration, 0.01)) * 100}%` }}
              title={`镜头 ${i + 1}:${s.durationSec}s`}
            />
          ))}
        </div>
        <div className={`ms-total-text${overTotal ? " is-over" : ""}`}>
          总时长 {totalDuration}s / {MULTISHOT_MAX_TOTAL_SEC}s
          {overTotal && "(超限,请缩短各镜头时长)"}
        </div>
      </div>

      {/* 高级参数:尺寸/采样/种子(与 h3-t2v 同一套范围) */}
      <details className="ms-adv">
        <summary>
          高级参数
          <span className="ms-adv-chevron">
            <Icon name="chevron-down" size={13} />
          </span>
        </summary>
        <div className="ms-adv-body">
          <Field label="宽度">
            <Input
              type="number"
              min={256}
              max={1344}
              step={32}
              value={width}
              disabled={busy}
              onChange={(e) => setWidth(Number(e.target.value))}
            />
          </Field>
          <Field label="高度">
            <Input
              type="number"
              min={256}
              max={1344}
              step={32}
              value={height}
              disabled={busy}
              onChange={(e) => setHeight(Number(e.target.value))}
            />
          </Field>
          <Field label="采样步数">
            <Input
              type="number"
              min={1}
              max={50}
              value={steps}
              disabled={busy}
              onChange={(e) => setSteps(Number(e.target.value))}
            />
          </Field>
          <Field label="随机种子">
            <Input
              type="text"
              value={seedText}
              placeholder="留空随机"
              disabled={busy}
              onChange={(e) => setSeedText(e.target.value)}
            />
          </Field>
        </div>
      </details>

      {error && <ErrorBar message={error} onClose={() => setError(null)} />}

      {/* 提交 + busy 态 / 成片 */}
      <div className="ms-submit-row">
        <Button variant="primary" loading={busy} disabled={!canSubmit} onClick={() => void onSubmit()}>
          {busy ? busyLabel : `生成多镜头视频(${shots.length} 镜 · ${totalDuration}s)`}
        </Button>
        {runId && runStatus === "error" && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setRunId(null);
              setResultUrl(null);
            }}
          >
            重新编辑
          </Button>
        )}
      </div>
      {runId && runStatus === "error" && (
        <p className="ms-error-text">生成失败,可调整镜头内容后重新提交。</p>
      )}
      {runStatus === "done" && resultUrl && (
        <div className="ms-result">
          <video
            src={imageUrl(resultUrl)}
            controls
            playsInline
            className="ms-result-video"
            aria-label="多镜头成片"
          />
        </div>
      )}

      <style jsx>{`
        .ms-editor {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
          padding: var(--space-3) var(--space-4);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-lg);
          background: var(--bg-surface-2);
        }
        .ms-shots {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
        }
        .ms-shot-card {
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: var(--space-2) var(--space-3);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-md);
          background: var(--bg-surface-3);
          cursor: grab;
          transition: border-color var(--duration-fast) var(--ease-standard);
        }
        .ms-shot-card.is-dragover {
          border-color: var(--accent);
        }
        .ms-shot-head {
          display: flex;
          align-items: center;
          gap: var(--space-2);
        }
        .ms-shot-title {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          font-size: 12px;
          color: var(--text-secondary);
        }
        .ms-shot-dur {
          margin-left: auto;
          font-size: 12px;
          font-weight: 600;
          color: var(--text-primary);
          font-variant-numeric: tabular-nums;
        }
        .ms-shot-remove {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 18px;
          height: 18px;
          border: none;
          border-radius: 50%;
          background: transparent;
          color: var(--text-muted);
          cursor: pointer;
          padding: 0;
        }
        .ms-shot-remove:hover:not(:disabled) {
          color: var(--text-primary);
        }
        .ms-shot-row {
          display: flex;
          align-items: center;
          gap: var(--space-2);
        }
        .ms-shot-row input[type="range"] {
          flex: 1;
          min-width: 80px;
        }
        .ms-shot-row select {
          max-width: 150px;
        }
        .ms-shot-actions {
          display: flex;
          align-items: center;
          gap: var(--space-2);
        }
        .ms-shot-hint {
          font-size: 11px;
          color: var(--text-muted);
        }
        .ms-total {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .ms-total-bar {
          display: flex;
          height: 8px;
          border-radius: 999px;
          overflow: hidden;
          background: var(--bg-surface-3);
        }
        .ms-total-seg-0 {
          background: var(--accent);
        }
        .ms-total-seg-1 {
          background: #7c8cf8;
        }
        .ms-total-seg-2 {
          background: #4ec9b0;
        }
        .ms-total-seg-3 {
          background: #e0a458;
        }
        .ms-total-text {
          font-size: 12px;
          color: var(--text-secondary);
          font-variant-numeric: tabular-nums;
        }
        .ms-total-text.is-over {
          color: var(--danger, #e5484d);
          font-weight: 600;
        }
        .ms-adv summary {
          display: flex;
          align-items: center;
          justify-content: space-between;
          cursor: pointer;
          font-size: 12px;
          color: var(--text-secondary);
          list-style: none;
        }
        .ms-adv summary::-webkit-details-marker {
          display: none;
        }
        .ms-adv[open] .ms-adv-chevron {
          display: inline-block;
          transform: rotate(180deg);
        }
        .ms-adv-body {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
          gap: var(--space-2);
          margin-top: var(--space-2);
        }
        .ms-submit-row {
          display: flex;
          align-items: center;
          gap: var(--space-2);
        }
        .ms-error-text {
          margin: 0;
          font-size: 12px;
          color: var(--danger, #e5484d);
        }
        .ms-result-video {
          width: 100%;
          max-height: 420px;
          border-radius: var(--radius-md);
          background: #000;
        }
      `}</style>
    </div>
  );
}
