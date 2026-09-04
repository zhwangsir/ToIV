"use client";

/**
 * VACE 视频到视频编辑器(Runway Aleph 式 in-context 编辑):
 * 源视频(上传/作品库,≤10s)→ 编辑模式(对象替换/移除/风格迁移/重打光/相机变换)
 * + 英文编辑指令 → 可选关键帧锚点(播放器点击标记 ≤5 帧,或手工输入帧索引;
 * 锚点帧整帧保留,内容向全片传播)与区域保留 mask(白色保留) →
 * 提交 POST /api/generate/video-edit → busy 态轮询(editJobProgress),
 * 成片与源视频并排对比播放。
 *
 * 集成:GenerateView 选中「VACE 视频编辑」引擎(vace-edit)时在舞台列渲染本编辑器
 * (替代 PromptBar;源视频/模式/指令/关键帧/参数全部自承载)。
 * 全部 JSX 在单一组件内:<style jsx> 作用域类仅覆盖主组件自身元素(2026-08-24 P-2b 教训)。
 *
 * 命名说明:同目录 VideoEditView.tsx 是 OpenCut 时间线剪辑器(ffmpeg),本组件是
 * AI 视频到视频编辑,为避免覆盖既有视图独立命名 AiVideoEditView。
 */
import { useEffect, useRef, useState } from "react";

import { AssetPicker } from "@/components/generate/AssetPicker";
import { Button } from "@/components/ui/Button";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { Icon } from "@/components/ui/Icon";
import { Field, Input, Select, Textarea } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { cancelJob, imageUrl, invalidateJobs, lookupJob, uploadImage } from "@/lib/api";
import {
  EDIT_MAX_DURATION_SEC,
  EDIT_MAX_KEYFRAMES,
  EDIT_MODES,
  editJobProgress,
  editSubmittable,
  parseKeyframeIndices,
  submitVideoEdit,
  timeToFrameIndex,
  toggleKeyframe,
  type EditMode,
  type EditProgressInfo,
} from "@/lib/videoEdit";

// 上传校验:后端 /api/upload 视频类上限 200MB / 图片类 20MB;扩展名与 RefVideoUpload 一致
const VIDEO_MAX_BYTES = 200 * 1024 * 1024;
const VIDEO_EXT_OK = ["mp4", "mov", "webm"];
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_EXT_OK = ["jpg", "jpeg", "png", "webp"];

/** 已就绪媒体句柄(上传 objectURL 本地预览 / 作品库签名 URL 预览)。 */
interface MediaHandle {
  filename: string;
  worker: string;
  name: string;
  preview: string;
  /** true=本地 objectURL(替换/卸载时须 revoke);false=作品库签名 URL */
  local: boolean;
}

function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** 16 对齐 + 320-1280 夹取(与后端 _snap16/范围校验同惯例)。 */
function snap16Clamp(v: number): number {
  return Math.min(1280, Math.max(320, Math.floor(v / 16) * 16));
}

export function AiVideoEditView() {
  const toast = useToast();
  // 源视频与元数据(探测自 <video> loadedmetadata)
  const [video, setVideo] = useState<MediaHandle | null>(null);
  const [videoMeta, setVideoMeta] = useState<{ duration: number; width: number; height: number } | null>(null);
  // 编辑模式 + 指令
  const [mode, setMode] = useState<EditMode>("style_transfer");
  const [prompt, setPrompt] = useState("");
  // 关键帧锚点(chips 与手工输入双向同步)
  const [keyframes, setKeyframes] = useState<number[]>([]);
  const [kfText, setKfText] = useState("");
  const [kfError, setKfError] = useState<string | null>(null);
  // 区域保留 mask(可选)
  const [mask, setMask] = useState<MediaHandle | null>(null);
  // 高级参数(尺寸/时长默认值在源视频元数据到达时按源视频初始化)
  const [width, setWidth] = useState(832);
  const [height, setHeight] = useState(480);
  const [durationSec, setDurationSec] = useState(5);
  const [steps, setSteps] = useState(20);
  const [cfg, setCfg] = useState(5);
  const [fps, setFps] = useState(16);
  const [seedText, setSeedText] = useState("");
  // 上传/作品库
  const [uploading, setUploading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [maskPickerOpen, setMaskPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 提交与进度(busy 态轮询)
  const [submitting, setSubmitting] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [progress, setProgress] = useState<EditProgressInfo | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const maskInputRef = useRef<HTMLInputElement | null>(null);
  // 卸载时回收本地 objectURL(ref 镜像避免闭包过期)
  const mediaRef = useRef<(MediaHandle | null)[]>([null, null]);
  useEffect(() => {
    mediaRef.current = [video, mask];
  }, [video, mask]);
  useEffect(() => {
    return () => {
      mediaRef.current.forEach((m) => {
        if (m?.local) URL.revokeObjectURL(m.preview);
      });
    };
  }, []);

  const busy =
    submitting ||
    (runId !== null &&
      progress?.status !== "done" &&
      progress?.status !== "error" &&
      progress?.status !== "canceled");
  const canSubmit = editSubmittable({
    hasVideo: video !== null,
    editPrompt: prompt,
    durationSec,
    keyframes,
    busy,
  });
  const modeDef = EDIT_MODES.find((m) => m.value === mode) ?? EDIT_MODES[0];

  // 进度轮询:提交后每 5s 拉作业列表,editJobProgress 推导状态/成片
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const job = await lookupJob(runId);
        if (cancelled) return;
        const p = editJobProgress(job ? [job] : [], runId);
        setProgress(p);
        if (p.status === "done") {
          invalidateJobs(); // 成片已落库,作品库缓存失效
          toast.success("视频编辑成片已生成");
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

  /** 源视频元数据到达:时长/尺寸默认值按源视频初始化(帧空间变化,清空已标锚点)。 */
  function onVideoLoaded() {
    const v = videoRef.current;
    if (!v || !Number.isFinite(v.duration) || v.duration <= 0) return;
    setVideoMeta({ duration: v.duration, width: v.videoWidth, height: v.videoHeight });
    setDurationSec(Math.min(EDIT_MAX_DURATION_SEC, Math.round(v.duration * 2) / 2));
    if (v.videoWidth > 0) setWidth(snap16Clamp(v.videoWidth));
    if (v.videoHeight > 0) setHeight(snap16Clamp(v.videoHeight));
    setKeyframes([]);
    setKfText("");
  }

  function replaceVideo(next: MediaHandle | null) {
    setVideo((prev) => {
      if (prev?.local) URL.revokeObjectURL(prev.preview);
      return next;
    });
    setVideoMeta(null);
    setKeyframes([]);
    setKfText("");
    setRunId(null);
    setProgress(null);
  }

  /** 上传源视频(钉区域 mask 所在 worker,保持互钉)。 */
  async function onVideoFile(file: File | undefined) {
    if (!file || busy) return;
    setError(null);
    if (!VIDEO_EXT_OK.includes(fileExt(file.name))) {
      setError("仅支持 mp4 / mov / webm 视频");
      return;
    }
    if (file.size > VIDEO_MAX_BYTES) {
      setError("视频超过 200MB 上限");
      return;
    }
    setUploading(true);
    try {
      const r = await uploadImage(file, "wan_vace", false, mask?.worker ?? undefined);
      replaceVideo({
        filename: r.filename,
        worker: r.worker,
        name: file.name,
        preview: URL.createObjectURL(file),
        local: true,
      });
      toast.success("源视频已上传");
    } catch (e) {
      setError(e instanceof Error ? e.message : "上传失败");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  /** 上传区域保留 mask(钉源视频所在 worker,白色区域保留)。 */
  async function onMaskFile(file: File | undefined) {
    if (!file || busy) return;
    setError(null);
    if (!IMAGE_EXT_OK.includes(fileExt(file.name))) {
      setError("mask 仅支持 jpg / png / webp 图片");
      return;
    }
    if (file.size > IMAGE_MAX_BYTES) {
      setError("mask 图片超过 20MB 上限");
      return;
    }
    setUploading(true);
    try {
      const r = await uploadImage(file, "wan_vace", false, video?.worker ?? undefined);
      setMask((prev) => {
        if (prev?.local) URL.revokeObjectURL(prev.preview);
        return {
          filename: r.filename,
          worker: r.worker,
          name: file.name,
          preview: URL.createObjectURL(file),
          local: true,
        };
      });
      toast.success("区域保留 mask 已上传");
    } catch (e) {
      setError(e instanceof Error ? e.message : "mask 上传失败");
    } finally {
      setUploading(false);
      if (maskInputRef.current) maskInputRef.current.value = "";
    }
  }

  /** 播放器打点:当前时刻 → 输出帧索引(fps 帧空间)→ 切换锚点。 */
  function markCurrentFrame() {
    const v = videoRef.current;
    if (!v || busy) return;
    const idx = timeToFrameIndex(v.currentTime, fps);
    if (keyframes.length >= EDIT_MAX_KEYFRAMES && !keyframes.includes(idx)) {
      toast.info(`关键帧锚点最多 ${EDIT_MAX_KEYFRAMES} 个,请先移除一个`);
      return;
    }
    const next = toggleKeyframe(keyframes, idx);
    setKeyframes(next);
    setKfText(next.join(", "));
    setKfError(null);
  }

  function removeKeyframe(idx: number) {
    if (busy) return;
    const next = keyframes.filter((k) => k !== idx);
    setKeyframes(next);
    setKfText(next.join(", "));
  }

  /** 手工输入帧索引(onBlur 同步;非法输入内联报错,不覆盖已标锚点)。 */
  function applyKeyframeText() {
    try {
      const next = parseKeyframeIndices(kfText);
      setKeyframes(next);
      setKfText(next.join(", "));
      setKfError(null);
    } catch (e) {
      setKfError(e instanceof Error ? e.message : "帧索引格式错误");
    }
  }

  async function onCancelRun() {
    if (!runId) return;
    try {
      await cancelJob(runId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "中止失败");
    }
    setProgress({ status: "canceled", resultUrl: null });
  }

  async function onSubmit() {
    if (!canSubmit || !video) return;
    setError(null);
    setSubmitting(true);
    try {
      const seed = seedText.trim() ? Number(seedText) : null;
      const res = await submitVideoEdit({
        sourceVideo: { filename: video.filename, worker: video.worker },
        editPrompt: prompt,
        editMode: mode,
        keyframeIndices: keyframes,
        preserveMask: mask ? { filename: mask.filename, worker: mask.worker } : null,
        width,
        height,
        durationSec,
        steps,
        cfg,
        fps,
        ...(seed !== null && Number.isInteger(seed) && seed >= 0 ? { seed } : {}),
      });
      setRunId(res.prompt_id);
      setProgress({ status: res.held ? "held" : "running", resultUrl: null });
      if (res.held) {
        toast.info("资源暂不足,编辑作业已进入排队,资源释放后自动执行");
      } else {
        toast.success("视频编辑已提交");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "提交失败");
    } finally {
      setSubmitting(false);
    }
  }

  const busyLabel = progress?.status === "held" ? "资源排队中…" : "编辑生成中…";

  return (
    <div className="veai-editor">
      {/* 源视频区:未就绪=上传/作品库入口;就绪=播放器(锚点打点面)+ 信息行 */}
      {video ? (
        <div className="veai-source">
          <video
            key={video.filename}
            ref={videoRef}
            className="veai-video"
            controls
            playsInline
            preload="metadata"
            src={video.preview}
            onLoadedMetadata={onVideoLoaded}
            aria-label="源视频"
          />
          <div className="veai-source-meta">
            <span className="veai-source-name" title={video.name}>
              <Icon name="video" size={13} />
              {video.name}
            </span>
            {videoMeta && (
              <span className="veai-source-dims">
                {videoMeta.duration.toFixed(1)}s · {videoMeta.width}×{videoMeta.height}
                {videoMeta.duration > EDIT_MAX_DURATION_SEC &&
                  ` · 超过 ${EDIT_MAX_DURATION_SEC}s 部分将被截断`}
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              icon={<Icon name="close" size={13} />}
              disabled={busy}
              onClick={() => replaceVideo(null)}
            >
              更换视频
            </Button>
          </div>
        </div>
      ) : (
        <div className="veai-empty">
          <Button
            variant="secondary"
            size="sm"
            loading={uploading}
            icon={<Icon name="upload" size={14} />}
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? "上传中…" : "上传源视频"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<Icon name="library" size={14} />}
            disabled={busy}
            onClick={() => setPickerOpen(true)}
          >
            从作品库选
          </Button>
          <span className="veai-empty-hint">
            mp4 / mov / webm · ≤200MB · ≤{EDIT_MAX_DURATION_SEC}s(超长截断)
          </span>
        </div>
      )}

      {/* 编辑模式 + 指令 */}
      <div className="veai-mode-row">
        <Field label="编辑模式" hint={modeDef.hint}>
          <Select
            value={mode}
            disabled={busy}
            aria-label="编辑模式"
            onChange={(e) => setMode(e.target.value as EditMode)}
          >
            {EDIT_MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="编辑指令(英文)">
        <Textarea
          rows={2}
          value={prompt}
          placeholder={modeDef.placeholder}
          disabled={busy}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </Field>

      {/* 关键帧锚点:播放器打点 + chips + 手工输入(≤5) */}
      {video && (
        <div className="veai-keyframes">
          <div className="veai-kf-head">
            <span className="veai-kf-title">
              关键帧锚点(可选,≤{EDIT_MAX_KEYFRAMES})
            </span>
            <Button
              variant="ghost"
              size="sm"
              icon={<Icon name="plus" size={13} />}
              disabled={busy || keyframes.length >= EDIT_MAX_KEYFRAMES}
              onClick={markCurrentFrame}
            >
              标记当前帧
            </Button>
          </div>
          <p className="veai-kf-hint">
            锚点帧整帧保留不动,其余帧按指令重生成并向锚点传播(改一帧 → 全片传播);
            不标记则整片按源视频上下文重生成
          </p>
          {keyframes.length > 0 && (
            <div className="veai-kf-chips" role="list" aria-label="已标记关键帧">
              {keyframes.map((k) => (
                <span key={k} className="veai-kf-chip" role="listitem" title={`第 ${(k / fps).toFixed(1)}s`}>
                  帧 {k}
                  <button
                    type="button"
                    aria-label={`移除关键帧 ${k}`}
                    disabled={busy}
                    onClick={() => removeKeyframe(k)}
                  >
                    <Icon name="close" size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <Field label="手工输入帧索引" error={kfError ?? undefined}>
            <Input
              type="text"
              value={kfText}
              placeholder="如:0, 40, 80(0 基,逗号分隔)"
              disabled={busy}
              onChange={(e) => setKfText(e.target.value)}
              onBlur={applyKeyframeText}
            />
          </Field>
        </div>
      )}

      {/* 区域保留 mask(可选,折叠):白色区域保留不动,黑色区域重生成 */}
      <details className="veai-adv">
        <summary>
          区域保留 mask(可选)
          <span className="veai-adv-chevron">
            <Icon name="chevron-down" size={13} />
          </span>
        </summary>
        <div className="veai-adv-body">
          <p className="veai-mask-hint">
            上传黑白 mask 图:白色区域保留不动,黑色区域按指令重生成(与源视频同 worker 互钉)
          </p>
          {mask ? (
            <div className="veai-mask-preview">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={mask.preview} alt="区域保留 mask" className="veai-mask-thumb" />
              <span className="veai-mask-name" title={mask.name}>
                {mask.name}
              </span>
              <Button
                variant="ghost"
                size="sm"
                icon={<Icon name="close" size={13} />}
                aria-label="移除区域 mask"
                disabled={busy}
                onClick={() =>
                  setMask((prev) => {
                    if (prev?.local) URL.revokeObjectURL(prev.preview);
                    return null;
                  })
                }
              />
            </div>
          ) : (
            <div className="veai-mask-actions">
              <Button
                variant="secondary"
                size="sm"
                loading={uploading}
                icon={<Icon name="upload" size={14} />}
                disabled={busy || !video}
                onClick={() => maskInputRef.current?.click()}
              >
                上传 mask
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={<Icon name="library" size={14} />}
                disabled={busy || !video}
                onClick={() => setMaskPickerOpen(true)}
              >
                从作品库选
              </Button>
            </div>
          )}
        </div>
      </details>

      {/* 高级参数:尺寸/时长/采样/种子(默认值随源视频元数据初始化) */}
      <details className="veai-adv">
        <summary>
          高级参数
          <span className="veai-adv-chevron">
            <Icon name="chevron-down" size={13} />
          </span>
        </summary>
        <div className="veai-adv-body veai-adv-grid">
          <Field label="宽度">
            <Input type="number" min={320} max={1280} step={16} value={width} disabled={busy}
              onChange={(e) => setWidth(Number(e.target.value))} />
          </Field>
          <Field label="高度">
            <Input type="number" min={320} max={1280} step={16} value={height} disabled={busy}
              onChange={(e) => setHeight(Number(e.target.value))} />
          </Field>
          <Field label={`时长(秒,≤${EDIT_MAX_DURATION_SEC})`}>
            <Input type="number" min={0.5} max={EDIT_MAX_DURATION_SEC} step={0.5} value={durationSec} disabled={busy}
              onChange={(e) => setDurationSec(Number(e.target.value))} />
          </Field>
          <Field label="采样步数">
            <Input type="number" min={1} max={50} value={steps} disabled={busy}
              onChange={(e) => setSteps(Number(e.target.value))} />
          </Field>
          <Field label="CFG">
            <Input type="number" min={0} max={20} step={0.5} value={cfg} disabled={busy}
              onChange={(e) => setCfg(Number(e.target.value))} />
          </Field>
          <Field label="帧率">
            <Input type="number" min={8} max={30} value={fps} disabled={busy}
              onChange={(e) => setFps(Number(e.target.value))} />
          </Field>
          <Field label="随机种子">
            <Input type="text" value={seedText} placeholder="留空随机" disabled={busy}
              onChange={(e) => setSeedText(e.target.value)} />
          </Field>
        </div>
      </details>

      {error && <ErrorBar message={error} onClose={() => setError(null)} />}

      {/* 提交 + busy 态进度 / 并排对比 */}
      <div className="veai-submit-row">
        <Button
          variant="primary"
          loading={busy}
          disabled={!canSubmit}
          onClick={() => void onSubmit()}
        >
          {busy ? busyLabel : "生成编辑视频"}
        </Button>
        {busy && runId && (
          <Button variant="ghost" size="sm" onClick={() => void onCancelRun()} title="中止后端作业并停止本页跟踪">
            停止
          </Button>
        )}
        {runId && (progress?.status === "error" || progress?.status === "canceled") && (
          <Button variant="ghost" size="sm" onClick={() => { setRunId(null); setProgress(null); }}>
            重新编辑
          </Button>
        )}
      </div>
      {runId && progress?.status === "error" && (
        <p className="veai-error-text">编辑作业失败,可调整指令或参数后重新提交。</p>
      )}
      {runId && progress?.status === "canceled" && (
        <p className="veai-error-text">已中止该作业。</p>
      )}
      {progress?.status === "done" && progress.resultUrl && video && (
        <div className="veai-compare">
          <div className="veai-compare-cell">
            <span className="veai-compare-label">源视频</span>
            <video
              className="veai-video"
              controls
              playsInline
              preload="metadata"
              src={video.preview}
              aria-label="源视频对比"
            />
          </div>
          <div className="veai-compare-cell">
            <span className="veai-compare-label">编辑后</span>
            <video
              className="veai-video"
              controls
              playsInline
              preload="metadata"
              src={imageUrl(progress.resultUrl)}
              aria-label="编辑后视频"
            />
          </div>
        </div>
      )}

      <AssetPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        assetType="video"
        kind="wan_vace"
        pinWorker={mask?.worker ?? null}
        onPick={(a) => {
          replaceVideo({ filename: a.filename, worker: a.worker, name: a.name, preview: a.previewUrl, local: false });
          setPickerOpen(false);
          toast.success("已引用作品库视频为源视频");
        }}
      />
      <AssetPicker
        open={maskPickerOpen}
        onClose={() => setMaskPickerOpen(false)}
        assetType="image"
        kind="wan_vace"
        pinWorker={video?.worker ?? null}
        onPick={(a) => {
          setMask((prev) => {
            if (prev?.local) URL.revokeObjectURL(prev.preview);
            return { filename: a.filename, worker: a.worker, name: a.name, preview: a.previewUrl, local: false };
          });
          setMaskPickerOpen(false);
          toast.success("已引用作品库图片为区域 mask");
        }}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept=".mp4,.mov,.webm"
        style={{ display: "none" }}
        onChange={(e) => void onVideoFile(e.target.files?.[0])}
      />
      <input
        ref={maskInputRef}
        type="file"
        accept=".jpg,.jpeg,.png,.webp"
        style={{ display: "none" }}
        onChange={(e) => void onMaskFile(e.target.files?.[0])}
      />

      <style jsx>{`
        .veai-editor {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
          padding: var(--space-3) var(--space-4);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-panel);
          background: var(--bg-surface-2);
        }
        .veai-video {
          width: 100%;
          max-height: 420px;
          border-radius: var(--radius-control);
          background: #000;
        }
        .veai-source {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
        }
        .veai-source-meta {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          flex-wrap: wrap;
        }
        .veai-source-name {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          font-size: 12px;
          font-weight: 500;
          color: var(--text-primary);
          max-width: 45%;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .veai-source-dims {
          font-size: 11px;
          color: var(--text-muted);
          font-variant-numeric: tabular-nums;
        }
        .veai-source-meta :global(button) {
          margin-left: auto;
        }
        .veai-empty {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          flex-wrap: wrap;
          padding: var(--space-4);
          border: 1px dashed var(--border-subtle);
          border-radius: var(--radius-control);
          background: var(--bg-surface-3);
        }
        .veai-empty-hint {
          font-size: 11px;
          color: var(--text-muted);
        }
        .veai-keyframes {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
          padding: var(--space-2) var(--space-3);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          background: var(--bg-surface-3);
        }
        .veai-kf-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-2);
        }
        .veai-kf-title {
          font-size: 12px;
          font-weight: 500;
          color: var(--text-secondary);
        }
        .veai-kf-hint {
          margin: 0;
          font-size: 11px;
          color: var(--text-muted);
          line-height: 1.5;
        }
        .veai-kf-chips {
          display: flex;
          flex-wrap: wrap;
          gap: var(--space-1);
        }
        .veai-kf-chip {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 2px 4px 2px 8px;
          border: 1px solid var(--accent);
          border-radius: 999px;
          background: var(--accent-soft, var(--bg-surface-2));
          font-size: 11px;
          color: var(--text-primary);
          font-variant-numeric: tabular-nums;
        }
        .veai-kf-chip button {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 16px;
          height: 16px;
          border: none;
          border-radius: 50%;
          background: transparent;
          color: var(--text-muted);
          cursor: pointer;
          padding: 0;
        }
        .veai-kf-chip button:hover:not(:disabled) {
          color: var(--text-primary);
        }
        .veai-adv summary {
          display: flex;
          align-items: center;
          justify-content: space-between;
          cursor: pointer;
          font-size: 12px;
          color: var(--text-secondary);
          list-style: none;
        }
        .veai-adv summary::-webkit-details-marker {
          display: none;
        }
        .veai-adv[open] .veai-adv-chevron {
          display: inline-block;
          transform: rotate(180deg);
        }
        .veai-adv-body {
          margin-top: var(--space-2);
        }
        .veai-adv-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
          gap: var(--space-2);
        }
        .veai-mask-hint {
          margin: 0 0 var(--space-2);
          font-size: 11px;
          color: var(--text-muted);
        }
        .veai-mask-actions {
          display: flex;
          gap: var(--space-2);
          flex-wrap: wrap;
        }
        .veai-mask-preview {
          display: flex;
          align-items: center;
          gap: var(--space-2);
        }
        .veai-mask-thumb {
          width: 56px;
          height: 56px;
          object-fit: cover;
          border-radius: var(--radius-badge);
          border: 1px solid var(--border-subtle);
        }
        .veai-mask-name {
          flex: 1;
          min-width: 0;
          font-size: 11px;
          color: var(--text-secondary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .veai-submit-row {
          display: flex;
          align-items: center;
          gap: var(--space-2);
        }
        .veai-error-text {
          margin: 0;
          font-size: 12px;
          color: var(--err);
        }
        .veai-compare {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
          gap: var(--space-3);
        }
        .veai-compare-cell {
          display: flex;
          flex-direction: column;
          gap: var(--space-1);
        }
        .veai-compare-label {
          font-size: 11px;
          font-weight: 500;
          color: var(--text-muted);
        }
      `}</style>
    </div>
  );
}
