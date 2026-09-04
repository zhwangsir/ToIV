"use client";

/**
 * 关键帧链式转场编辑器(对标 Pika 2.5 Pikaframes):
 * 2-5 张关键帧(链序槽位,拖拽排序/删除/作品库选择)→ 逐段参数卡(时长滑块 1-10s
 * + 段提示词覆盖)→ 总时长实时预览(≤25s)→ 提交 POST /api/generate/keyframe-chain
 * → busy 态轮询段进度(chainProgress),成片内联播放。
 *
 * 集成:GenerateView 选中「关键帧链」引擎(keyframe-chain)时在舞台列渲染本编辑器
 * (替代 PromptBar;引擎自带参数均由本编辑器承载)。
 * 全部 JSX 在单一组件内:<style jsx> 作用域类仅覆盖主组件自身元素(2026-08-24 P-2b 教训)。
 */
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { Icon } from "@/components/ui/Icon";
import { Field, Input, Textarea } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { imageUrl, invalidateJobs, lookupJob, uploadImage } from "@/lib/api";
import type { JobItem } from "@/lib/types";
import {
  CHAIN_DEFAULT_SEG_SEC,
  CHAIN_MAX_FRAMES,
  CHAIN_MAX_SEG_SEC,
  CHAIN_MAX_TOTAL_SEC,
  CHAIN_MIN_FRAMES,
  CHAIN_MIN_SEG_SEC,
  buildChainPrompts,
  chainProgress,
  chainSubmittable,
  chainTotalDuration,
  reorderSlots,
  submitKeyframeChain,
  type ChainProgressInfo,
} from "@/lib/keyframeChain";

import { AssetPicker } from "./AssetPicker";
import type { UploadedRef } from "./RefImageUpload";

// 上传校验:后端 /api/upload 上限 20MB;扩展名白名单与单图上传一致
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_EXT_OK = ["jpg", "jpeg", "png", "webp"];

/** 轮询总超时(2026-08-30 P0-4:超时判终态解锁,不再永久锁死)。 */
const RUN_TIMEOUT_MS = 35 * 60_000;
/** 合并作业连续查不到(404)多少次判「链已消失」:12 × 5s ≈ 60s,覆盖提交后可见性瞬抖。 */
const RUN_MISS_LIMIT = 12;

type Slot = UploadedRef | null;

function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** 段参数数组与段数对齐:增帧补默认值,减帧截断(保留前缀已调值)。 */
function resizeTo<T>(arr: T[], n: number, fill: T): T[] {
  if (arr.length === n) return arr;
  if (arr.length > n) return arr.slice(0, n);
  return [...arr, ...Array.from({ length: n - arr.length }, () => fill)];
}

export function KeyframeChainEditor() {
  const toast = useToast();
  // 槽位(2-5 个,含空槽;链序 = 数组序,空槽在提交时忽略)
  const [slots, setSlots] = useState<Slot[]>([null, null]);
  const [sharedPrompt, setSharedPrompt] = useState("");
  const [segPrompts, setSegPrompts] = useState<string[]>([""]);
  const [segDurations, setSegDurations] = useState<number[]>([CHAIN_DEFAULT_SEG_SEC]);
  // 高级参数(尺寸/采样/种子;与 transition 同一套范围)
  const [width, setWidth] = useState(832);
  const [height, setHeight] = useState(480);
  const [steps, setSteps] = useState(20);
  const [cfg, setCfg] = useState(5);
  const [seedText, setSeedText] = useState("");
  // 上传/作品库
  const [uploading, setUploading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 拖拽排序:dragIndex 记录源槽位,dragOver 提供落点高亮
  const dragIndex = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingSlotRef = useRef<number>(0);
  // 提交与段进度(busy 态轮询)
  const [submitting, setSubmitting] = useState(false);
  const [runIds, setRunIds] = useState<{ mergedId: string; segmentIds: string[] } | null>(null);
  const [progress, setProgress] = useState<ChainProgressInfo | null>(null);

  const frames = slots.filter((s): s is UploadedRef => s !== null);
  const segCount = Math.max(0, frames.length - 1);
  const pinWorker = frames[0]?.worker ?? null;

  // 段参数数组跟随段数(增帧补默认,减帧截断)
  useEffect(() => {
    setSegDurations((prev) => resizeTo(prev, Math.max(1, segCount), CHAIN_DEFAULT_SEG_SEC));
    setSegPrompts((prev) => resizeTo(prev, Math.max(1, segCount), ""));
  }, [segCount]);

  const totalDuration = chainTotalDuration(segDurations.slice(0, segCount));
  const overTotal = totalDuration > CHAIN_MAX_TOTAL_SEC;
  // 2026-08-30 P0-4:done/error/canceled 均为终态解锁(此前 canceled 不落终态 → 永久锁死)
  const busy =
    submitting ||
    (runIds !== null &&
      progress?.status !== "done" &&
      progress?.status !== "error" &&
      progress?.status !== "canceled");
  const canSubmit = chainSubmittable({
    frames: frames.length,
    sharedPrompt,
    segPrompts: segPrompts.slice(0, segCount),
    durations: segDurations.slice(0, segCount),
    busy,
  });

  // 段进度轮询:提交后每 5s 精确查各段/合并作业(2026-08-29:替代全量 200 条过滤,降负载)
  // 2026-08-30 P0-4 锁死根治:① allSettled 防单点静默(一段查询失败不再吞掉整轮);
  // ② canceled = 终态(chainProgress);③ 合并作业连续 404(≈60s)判消失;
  // ④ 总超时 35min 兜底;⑤ 终态即停轮询;⑥ 「停止跟踪」出口(setRunIds(null))
  useEffect(() => {
    if (!runIds) return;
    let cancelled = false;
    let mergedMisses = 0;
    const startedAt = Date.now();
    const ids = [...runIds.segmentIds, runIds.mergedId];
    const stop = () => clearInterval(timer);
    const tick = async (): Promise<void> => {
      if (cancelled) return;
      if (Date.now() - startedAt > RUN_TIMEOUT_MS) {
        stop();
        setProgress((prev) =>
          prev ? { ...prev, status: "error" } : { segDone: 0, segTotal: runIds.segmentIds.length, status: "error", resultUrl: null },
        );
        setError("跟踪超时,请在作品库查看结果");
        return;
      }
      const settled = await Promise.allSettled(ids.map((id) => lookupJob(id)));
      if (cancelled) return;
      const jobs = settled
        .filter((r): r is PromiseFulfilledResult<JobItem | null> => r.status === "fulfilled")
        .map((r) => r.value)
        .filter((j): j is JobItem => j !== null);
      // 合并作业是成片终态的唯一权威:它连续查不到(404)说明链已消失/被回收
      const last = settled[settled.length - 1];
      const mergedFound = last?.status === "fulfilled" && last.value !== null;
      mergedMisses = mergedFound ? 0 : mergedMisses + 1;
      if (mergedMisses >= RUN_MISS_LIMIT) {
        stop();
        setProgress((prev) =>
          prev ? { ...prev, status: "error" } : { segDone: 0, segTotal: runIds.segmentIds.length, status: "error", resultUrl: null },
        );
        setError("合并作业已消失(可能被回收),各段产物可到作品库查看");
        return;
      }
      const p = chainProgress(jobs, runIds.segmentIds, runIds.mergedId);
      setProgress(p);
      if (p.status === "done") {
        stop();
        invalidateJobs(); // 成片已落库,作品库缓存失效
        toast.success("关键帧链成片已生成");
      } else if (p.status === "error") {
        stop();
      } else if (p.status === "canceled") {
        stop();
        toast.info("关键帧链作业已中止");
      }
    };
    const timer = setInterval(() => void tick(), 5000);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runIds]);

  /** 停止跟踪(P0-4 逃生口):后端作业继续跑,编辑器立即解锁,结果可去作品库看。 */
  function stopTracking() {
    setRunIds(null);
    setProgress(null);
    toast.info("已停止跟踪,作业仍在后端继续,完成后可在作品库查看");
  }

  /** 上传关键帧到指定槽位(钉首个已填帧所在 worker,与 VACE 同实例 kind)。 */
  async function onFile(file: File | undefined) {
    if (!file) return;
    const slotIdx = pendingSlotRef.current;
    setError(null);
    if (!IMAGE_EXT_OK.includes(fileExt(file.name))) {
      setError("仅支持 jpg / png / webp 图片");
      return;
    }
    if (file.size > IMAGE_MAX_BYTES) {
      setError("图片超过 20MB 上限");
      return;
    }
    setUploading(true);
    try {
      const r = await uploadImage(file, "wan_vace", false, pinWorker ?? undefined);
      setSlots((prev) =>
        prev.map((s, i) =>
          i === slotIdx
            ? {
                filename: r.filename,
                worker: r.worker,
                previewUrl: URL.createObjectURL(file),
                name: file.name,
              }
            : s,
        ),
      );
      toast.success(`关键帧 ${slotIdx + 1} 已上传`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "上传失败");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  /** 移除槽位:槽位数 >2 整槽移除;否则清空为待填(保底部 2 槽)。 */
  function removeSlot(idx: number) {
    setSlots((prev) =>
      prev.length > CHAIN_MIN_FRAMES ? prev.filter((_, i) => i !== idx) : prev.map((s, i) => (i === idx ? null : s)),
    );
  }

  async function onSubmit() {
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      const seed = seedText.trim() ? Number(seedText) : null;
      const res = await submitKeyframeChain({
        keyframes: frames.map((f) => ({ filename: f.filename, worker: f.worker })),
        prompts: buildChainPrompts(sharedPrompt, segPrompts.slice(0, segCount)),
        durations: segDurations.slice(0, segCount),
        width,
        height,
        steps,
        cfg,
        ...(seed !== null && Number.isInteger(seed) && seed >= 0 ? { seed } : {}),
      });
      setRunIds({ mergedId: res.prompt_id, segmentIds: res.segments });
      setProgress({
        segDone: 0,
        segTotal: res.segments.length,
        status: res.held ? "held" : "running",
        resultUrl: null,
      });
      if (res.held) {
        toast.info(`资源暂不足,${res.segments.length} 个转场段已进入排队,资源释放后自动执行`);
      } else {
        toast.success(`关键帧链已提交(${res.segments.length} 段,共 ${res.total_duration}s)`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "提交失败");
    } finally {
      setSubmitting(false);
    }
  }

  const segTotal = runIds?.segmentIds.length ?? segCount;
  const busyLabel =
    progress?.status === "held"
      ? "资源排队中…"
      : `生成中(第 ${Math.min((progress?.segDone ?? 0) + 1, segTotal)}/${segTotal} 段)…`;

  return (
    <div className="kf-editor">
      {/* 关键帧槽位区:链序排列,拖拽排序;空槽点击上传,满槽缩略图 + 移除 */}
      <div className="kf-slots" role="list" aria-label="关键帧链序">
        {slots.map((slot, i) => (
          <div key={i} className="kf-slot-wrap" role="listitem">
            <div
              className={`kf-slot${slot ? " is-filled" : ""}${dragOver === i ? " is-dragover" : ""}`}
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
                  setSlots((prev) => reorderSlots(prev, from, i));
                }
              }}
              title={slot ? `关键帧 ${i + 1}:${slot.name}(拖拽调整链序)` : `关键帧 ${i + 1}:点击上传`}
            >
              {slot ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={slot.previewUrl} alt={`关键帧 ${i + 1}`} className="kf-slot-thumb" />
                  <span className="kf-slot-idx">{i + 1}</span>
                  <button
                    type="button"
                    className="kf-slot-remove"
                    aria-label={`移除关键帧 ${i + 1}`}
                    disabled={busy}
                    onClick={() => removeSlot(i)}
                  >
                    <Icon name="close" size={10} />
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="kf-slot-add"
                  disabled={busy || uploading}
                  onClick={() => {
                    pendingSlotRef.current = i;
                    fileInputRef.current?.click();
                  }}
                >
                  <Icon name={uploading && pendingSlotRef.current === i ? "loading" : "upload"} size={16} />
                  <span>帧 {i + 1}</span>
                </button>
              )}
            </div>
            {i < slots.length - 1 && (
              <span className="kf-slot-arrow" aria-hidden="true">
                →
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="kf-slot-actions">
        {slots.length < CHAIN_MAX_FRAMES && (
          <Button
            variant="ghost"
            size="sm"
            icon={<Icon name="plus" size={13} />}
            disabled={busy}
            onClick={() => setSlots((prev) => [...prev, null])}
          >
            添加槽位
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          icon={<Icon name="library" size={13} />}
          disabled={busy}
          onClick={() => {
            if (!slots.some((s) => s === null)) {
              toast.info(`槽位已满(${CHAIN_MAX_FRAMES} 张),请先移除一帧`);
              return;
            }
            setPickerOpen(true);
          }}
        >
          从作品库选
        </Button>
        <span className="kf-slot-hint">
          {frames.length}/{CHAIN_MAX_FRAMES} 帧 · 至少 {CHAIN_MIN_FRAMES} 帧
        </span>
      </div>

      {/* 共享提示词:逐段覆盖全空时全段共用 */}
      <Field label="转场提示词(全段共用)">
        <Textarea
          rows={2}
          value={sharedPrompt}
          placeholder="描述转场过程,如:镜头从白天平滑过渡到夜晚;逐段留空时各段共用此提示词"
          disabled={busy}
          onChange={(e) => setSharedPrompt(e.target.value)}
        />
      </Field>

      {/* 逐段参数卡:时长滑块(1-10s)+ 段提示词覆盖 */}
      {segCount > 0 && (
        <div className="kf-segments">
          {segDurations.slice(0, segCount).map((d, i) => (
            <div key={i} className="kf-seg-card">
              <div className="kf-seg-head">
                <span className="kf-seg-title">
                  段 {i + 1}:帧 {i + 1} → 帧 {i + 2}
                </span>
                <span className="kf-seg-dur">{d}s</span>
              </div>
              <input
                type="range"
                min={CHAIN_MIN_SEG_SEC}
                max={CHAIN_MAX_SEG_SEC}
                step={0.5}
                value={d}
                disabled={busy}
                aria-label={`段 ${i + 1} 时长(秒)`}
                onChange={(e) =>
                  setSegDurations((prev) => prev.map((v, j) => (j === i ? Number(e.target.value) : v)))
                }
              />
              <Textarea
                rows={1}
                value={segPrompts[i] ?? ""}
                placeholder="段提示词(留空则用共享提示词)"
                disabled={busy}
                onChange={(e) =>
                  setSegPrompts((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))
                }
              />
            </div>
          ))}
        </div>
      )}

      {/* 段间时长分配可视化 + 总时长实时预览 */}
      {segCount > 0 && (
        <div className="kf-total">
          <div className="kf-total-bar" aria-hidden="true">
            {segDurations.slice(0, segCount).map((d, i) => (
              <span
                key={i}
                className={`kf-total-seg kf-total-seg-${i % 4}`}
                style={{ width: `${(d / Math.max(totalDuration, 0.01)) * 100}%` }}
                title={`段 ${i + 1}:${d}s`}
              />
            ))}
          </div>
          <div className={`kf-total-text${overTotal ? " is-over" : ""}`}>
            总时长 {totalDuration}s / {CHAIN_MAX_TOTAL_SEC}s
            {overTotal && "(超限,请缩短各段时长)"}
          </div>
        </div>
      )}

      {/* 高级参数:尺寸/采样/种子(与 transition 同一套范围) */}
      <details className="kf-adv">
        <summary>
          高级参数
          <span className="kf-adv-chevron">
            <Icon name="chevron-down" size={13} />
          </span>
        </summary>
        <div className="kf-adv-body">
          <Field label="宽度">
            <Input
              type="number"
              min={320}
              max={1280}
              step={16}
              value={width}
              disabled={busy}
              onChange={(e) => setWidth(Number(e.target.value))}
            />
          </Field>
          <Field label="高度">
            <Input
              type="number"
              min={320}
              max={1280}
              step={16}
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
          <Field label="CFG">
            <Input
              type="number"
              min={0}
              max={20}
              step={0.5}
              value={cfg}
              disabled={busy}
              onChange={(e) => setCfg(Number(e.target.value))}
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

      {/* 提交 + busy 态段进度 / 成片 */}
      <div className="kf-submit-row">
        <Button
          variant="primary"
          loading={busy}
          disabled={!canSubmit}
          onClick={() => void onSubmit()}
        >
          {busy ? busyLabel : "生成关键帧链"}
        </Button>
        {busy && runIds && (
          /* P0-4 逃生口:轮询异常(消失/卡 held)时用户可主动停跟踪解锁 */
          <Button variant="ghost" size="sm" onClick={stopTracking}>
            停止跟踪
          </Button>
        )}
        {runIds && (progress?.status === "error" || progress?.status === "canceled") && (
          <Button variant="ghost" size="sm" onClick={() => { setRunIds(null); setProgress(null); setError(null); }}>
            重新编辑
          </Button>
        )}
      </div>
      {runIds && progress?.status === "error" && (
        <p className="kf-error-text">有转场段失败或拼接失败,各段产物可在作品库查看;可调整后重新提交。</p>
      )}
      {runIds && progress?.status === "canceled" && (
        <p className="kf-slot-hint">作业已中止,可调整后重新提交。</p>
      )}
      {progress?.status === "done" && progress.resultUrl && (
        <div className="kf-result">
          <video
            src={imageUrl(progress.resultUrl)}
            controls
            playsInline
            className="kf-result-video"
            aria-label="关键帧链成片"
          />
        </div>
      )}

      <AssetPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        assetType="image"
        kind="wan_vace"
        pinWorker={pinWorker}
        onPick={(a) => {
          setSlots((prev) => {
            const idx = prev.findIndex((s) => s === null);
            if (idx < 0) return prev;
            return prev.map((s, i) => (i === idx ? { ...a } : s));
          });
          setPickerOpen(false);
          toast.success("已引用作品库图片为关键帧");
        }}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept=".jpg,.jpeg,.png,.webp"
        style={{ display: "none" }}
        onChange={(e) => void onFile(e.target.files?.[0])}
      />

      <style jsx>{`
        .kf-editor {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
          padding: var(--space-3) var(--space-4);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-panel);
          background: var(--bg-surface-2);
        }
        .kf-slots {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: var(--space-2);
        }
        .kf-slot-wrap {
          display: flex;
          align-items: center;
          gap: var(--space-2);
        }
        .kf-slot {
          position: relative;
          width: 72px;
          height: 72px;
          border: 1px dashed var(--border-subtle);
          border-radius: var(--radius-control);
          background: var(--bg-surface-3);
          overflow: visible;
          cursor: grab;
          transition: border-color var(--duration-fast) var(--ease-standard);
        }
        .kf-slot.is-dragover {
          border-color: var(--accent);
        }
        .kf-slot.is-filled {
          border-style: solid;
        }
        .kf-slot-thumb {
          width: 100%;
          height: 100%;
          object-fit: cover;
          border-radius: var(--radius-control);
          display: block;
        }
        .kf-slot-idx {
          position: absolute;
          left: 4px;
          bottom: 4px;
          padding: 1px 6px;
          border-radius: 999px;
          background: rgba(0, 0, 0, 0.55);
          color: #fff;
          font-size: 10px;
        }
        .kf-slot-remove {
          position: absolute;
          top: -6px;
          right: -6px;
          width: 18px;
          height: 18px;
          display: flex;
          align-items: center;
          justify-content: center;
          border: none;
          border-radius: 50%;
          background: var(--bg-surface-3);
          color: var(--text-secondary);
          cursor: pointer;
          padding: 0;
        }
        .kf-slot-remove:hover:not(:disabled) {
          color: var(--text-primary);
        }
        .kf-slot-add {
          width: 100%;
          height: 100%;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 4px;
          border: none;
          background: transparent;
          color: var(--text-muted);
          font-size: 11px;
          cursor: pointer;
        }
        .kf-slot-add:hover:not(:disabled) {
          color: var(--text-primary);
        }
        .kf-slot-arrow {
          color: var(--text-muted);
          font-size: 13px;
        }
        .kf-slot-actions {
          display: flex;
          align-items: center;
          gap: var(--space-2);
        }
        .kf-slot-hint {
          font-size: 11px;
          color: var(--text-muted);
        }
        .kf-segments {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
        }
        .kf-seg-card {
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: var(--space-2) var(--space-3);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          background: var(--bg-surface-3);
        }
        .kf-seg-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .kf-seg-title {
          font-size: 12px;
          color: var(--text-secondary);
        }
        .kf-seg-dur {
          font-size: 12px;
          font-weight: 600;
          color: var(--text-primary);
          font-variant-numeric: tabular-nums;
        }
        .kf-total {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .kf-total-bar {
          display: flex;
          height: 8px;
          border-radius: 999px;
          overflow: hidden;
          background: var(--bg-surface-3);
        }
        .kf-total-seg-0 {
          background: var(--accent);
        }
        .kf-total-seg-1 {
          background: #7c8cf8;
        }
        .kf-total-seg-2 {
          background: #4ec9b0;
        }
        .kf-total-seg-3 {
          background: #e0a458;
        }
        .kf-total-text {
          font-size: 12px;
          color: var(--text-secondary);
          font-variant-numeric: tabular-nums;
        }
        .kf-total-text.is-over {
          color: var(--err);
          font-weight: 600;
        }
        .kf-adv summary {
          display: flex;
          align-items: center;
          justify-content: space-between;
          cursor: pointer;
          font-size: 12px;
          color: var(--text-secondary);
          list-style: none;
        }
        .kf-adv summary::-webkit-details-marker {
          display: none;
        }
        .kf-adv[open] .kf-adv-chevron {
          display: inline-block;
          transform: rotate(180deg);
        }
        .kf-adv-body {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
          gap: var(--space-2);
          margin-top: var(--space-2);
        }
        .kf-submit-row {
          display: flex;
          align-items: center;
          gap: var(--space-2);
        }
        .kf-error-text {
          margin: 0;
          font-size: 12px;
          color: var(--err);
        }
        .kf-result-video {
          width: 100%;
          max-height: 420px;
          border-radius: var(--radius-control);
          background: #000;
        }
      `}</style>
    </div>
  );
}
