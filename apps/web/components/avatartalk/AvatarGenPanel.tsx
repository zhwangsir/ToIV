"use client";

import { useCallback, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { Icon } from "@/components/ui/Icon";
import { Field, Input, Select, Textarea } from "@/components/ui/Input";
import { OptimizeButton } from "@/components/ui/OptimizeButton";
import { AssetPicker, type PickedAsset } from "@/components/generate/AssetPicker";
import { useAutoResize } from "@/hooks/useAutoResize";
import { usePoll } from "@/hooks/usePoll";
import {
  generateAvatarTalk,
  imageUrl,
  invalidateJobs,
  uploadImage,
} from "@/lib/api";
import { fetchEngines, type EngineInfo } from "@/lib/engines";
import { friendlyError } from "@/lib/friendlyError";
import { useGeneration } from "@/lib/useGeneration";

/** 已上传文件句柄(服务端 filename/worker + 本地预览)。 */
interface UploadedFile {
  filename: string;
  worker: string;
  name: string;
  previewUrl: string;
}

interface UploadedAudio extends UploadedFile {
  /** 秒;本地 metadata 探测,用于时长显示与帧数匹配。 */
  duration?: number;
}

// 上传校验:与后端 /api/upload 上限 20MB 对齐
const MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_EXT_OK = ["jpg", "jpeg", "png", "webp"];
const AUDIO_EXT_OK = ["wav", "mp3", "m4a", "flac", "ogg"];

/** 分辨率档位(均 16 对齐;默认与后端一致 480×832 竖屏)。 */
const RES_PRESETS = [
  { key: "480x832", label: "480×832 竖屏", width: 480, height: 832 },
  { key: "832x480", label: "832×480 横屏", width: 832, height: 480 },
  { key: "640x640", label: "640×640 方形", width: 640, height: 640 },
] as const;

function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}分${s}秒` : `${s}秒`;
}

interface AvatarGenPanelProps {
  /** 跳作品库(page.tsx 的视图路由);未传时不显示入口。 */
  onNavigate?: (target: string) => void;
}

/**
 * LongCat-Avatar 数字人视频生成工作台(上传人像+音频 → 调参 → 生成 → 作品库)。
 *
 * 同 worker 保证:第一个文件不指定 worker 由后端 pool.pick 选机,
 * 第二个文件上传时带 worker=<第一个的落点>钉到同机(后端白名单校验),
 * 因此两者恒同机;兜底再比对一次,不一致提示重传。
 */
export function AvatarGenPanel({ onNavigate }: AvatarGenPanelProps) {
  const [image, setImage] = useState<UploadedFile | null>(null);
  const [audio, setAudio] = useState<UploadedAudio | null>(null);
  const [imgUploading, setImgUploading] = useState(false);
  const [audUploading, setAudUploading] = useState(false);
  const [imgError, setImgError] = useState<string | null>(null);
  const [audError, setAudError] = useState<string | null>(null);

  const [positive, setPositive] = useState("");
  const [negative, setNegative] = useState("");
  // 正/负向提示词自动增高(负向在 closed <details> 内时 hook 自动跳过,展开后随输入增高)
  const positiveRef = useRef<HTMLTextAreaElement | null>(null);
  const negativeRef = useRef<HTMLTextAreaElement | null>(null);
  useAutoResize(positiveRef, positive);
  useAutoResize(negativeRef, negative);
  const [resPreset, setResPreset] = useState<string>("480x832");
  const [durationSec, setDurationSec] = useState(3.7);
  const [fps, setFps] = useState(25);
  const [steps, setSteps] = useState(12);
  const [seedText, setSeedText] = useState("");
  // 高级参数(默认与后端一致)
  const [shift, setShift] = useState(12);
  const [cfg, setCfg] = useState(1.0);
  const [dmdStrength, setDmdStrength] = useState(1.0);

  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [engineChecked, setEngineChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const imgInputRef = useRef<HTMLInputElement | null>(null);
  const audInputRef = useRef<HTMLInputElement | null>(null);
  // 作品库选取(二次创作):非 null 即打开对应类型的 AssetPicker
  const [pickerFor, setPickerFor] = useState<"image" | "audio" | null>(null);

  // 引擎可用性:进入即拉取 + 30s 轮询(同 GenerateView;avatar-talk 不可用时禁提交)
  usePoll(
    async () => {
      try {
        const list = await fetchEngines();
        setEngine(list.find((e) => e.id === "avatar-talk") ?? null);
      } catch {
        /* 网络失败保持旧状态,由提交错误兜底 */
      } finally {
        setEngineChecked(true);
      }
    },
    { intervalMs: 30_000, enabled: true, backoff: true },
  );

  const gen = useGeneration({
    onDone: () => {
      invalidateJobs(); // 产物已落库,作品库缓存失效
    },
  });

  /** 通用上传:kind=avatar(后端只要求 worker 能存文件);已存在的另一文件钉住同 worker。 */
  const doUpload = useCallback(
    async (
      file: File,
      pinWorker: string | undefined,
    ): Promise<{ filename: string; worker: string }> => {
      return uploadImage(file, "avatar", false, pinWorker);
    },
    [],
  );

  /** 从作品库选取:PickedAsset 与 UploadedFile 同构;音频时长未知留空(不影响提交)。 */
  const handlePickAsset = useCallback(
    (a: PickedAsset) => {
      const file = { filename: a.filename, worker: a.worker, name: a.name, previewUrl: a.previewUrl };
      if (pickerFor === "image") {
        setImage(file);
        setImgError(null);
      } else if (pickerFor === "audio") {
        setAudio(file);
        setAudError(null);
      }
      setPickerFor(null);
    },
    [pickerFor],
  );

  async function onImageFile(file: File | undefined) {
    if (!file) return;
    setImgError(null);
    if (!IMAGE_EXT_OK.includes(fileExt(file.name))) {
      setImgError("仅支持 jpg / png / webp 图片");
      return;
    }
    if (file.size > MAX_BYTES) {
      setImgError("图片超过 20MB 上限");
      return;
    }
    setImgUploading(true);
    try {
      const r = await doUpload(file, audio?.worker);
      setImage({
        filename: r.filename,
        worker: r.worker,
        name: file.name,
        previewUrl: URL.createObjectURL(file),
      });
    } catch (e) {
      setImgError(e instanceof Error ? e.message : "上传失败");
    } finally {
      setImgUploading(false);
      if (imgInputRef.current) imgInputRef.current.value = "";
    }
  }

  async function onAudioFile(file: File | undefined) {
    if (!file) return;
    setAudError(null);
    if (!AUDIO_EXT_OK.includes(fileExt(file.name))) {
      setAudError("仅支持 wav / mp3 / m4a / flac / ogg 音频");
      return;
    }
    if (file.size > MAX_BYTES) {
      setAudError("音频超过 20MB 上限");
      return;
    }
    setAudUploading(true);
    try {
      const r = await doUpload(file, image?.worker);
      const previewUrl = URL.createObjectURL(file);
      setAudio({ filename: r.filename, worker: r.worker, name: file.name, previewUrl });
      // 本地探测时长(只读 metadata,不出站)
      const probe = new Audio();
      probe.preload = "metadata";
      probe.src = previewUrl;
      probe.onloadedmetadata = () => {
        const d = probe.duration;
        setAudio((prev) =>
          prev && prev.previewUrl === previewUrl ? { ...prev, duration: d } : prev,
        );
      };
    } catch (e) {
      setAudError(e instanceof Error ? e.message : "上传失败");
    } finally {
      setAudUploading(false);
      if (audInputRef.current) audInputRef.current.value = "";
    }
  }

  // 同 worker 兜底校验(钉住上传后理论恒等;不一致即提示重传)
  const workerMismatch = !!image && !!audio && image.worker !== audio.worker;

  const seedParsed = useMemo((): number | null => {
    const raw = seedText.trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : null;
  }, [seedText]);
  const seedInvalid = seedText.trim() !== "" && seedParsed === null;

  const preset = RES_PRESETS.find((p) => p.key === resPreset) ?? RES_PRESETS[0];
  const estFrames = Math.round(durationSec * Math.max(1, fps));
  const engineReady = !!engine && engine.available;

  const canSubmit =
    !!image &&
    !!audio &&
    !workerMismatch &&
    positive.trim().length > 0 &&
    !seedInvalid &&
    engineReady &&
    !gen.isRunning &&
    !submitting &&
    !imgUploading &&
    !audUploading;

  async function onGenerate() {
    if (!image || !audio || !canSubmit) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      const res = await generateAvatarTalk({
        image: image.filename,
        audio: audio.filename,
        worker: image.worker,
        positive: positive.trim(),
        ...(negative.trim() ? { negative: negative.trim() } : {}),
        width: preset.width,
        height: preset.height,
        duration_sec: durationSec,
        fps,
        steps,
        shift,
        cfg,
        dmd_lora_strength: dmdStrength,
        seed: seedParsed,
      });
      // start 永远 resolve:出错经 onError → gen.error 展示
      await gen.start(res, { label: engine?.label ?? "对口型视频" });
    } catch (e) {
      const raw = e instanceof Error ? e.message : "生成请求失败";
      setSubmitError(friendlyError(raw).message);
    } finally {
      setSubmitting(false);
    }
  }

  /** 按音频时长匹配视频时长(0.1s 粒度,夹到 0.5-100s)。 */
  function matchDurationToAudio() {
    if (!audio?.duration) return;
    const secs = Math.min(100, Math.max(0.5, Math.round(audio.duration * 10) / 10));
    setDurationSec(secs);
  }

  const statusLabel = !engineChecked
    ? "检测中"
    : engineReady
      ? "引擎可用"
      : engine
        ? `不可用:${engine.unavailable_reason ?? "未知原因"}`
        : "引擎未注册";

  return (
    <>
      {/* ── 左:结果舞台 ── */}
      <div className="at-stage at-gen-stage">
        {gen.status === "done" && gen.resultPaths.length > 0 ? (
          <video
            className="at-video"
            src={imageUrl(gen.resultPaths[0])}
            controls
            autoPlay
            loop
            playsInline
          />
        ) : (
          <div className="at-placeholder">
            <div className="at-placeholder-icon">
              <Icon name="video" size={48} strokeWidth={1.5} />
            </div>
            <p className="at-placeholder-title">数字人视频生成</p>
            <p className="at-placeholder-desc">
              {gen.status === "running"
                ? "正在生成,完成后在此播放;也可随时去作品库查看"
                : gen.status === "error"
                  ? "生成失败,调整参数后可重新生成"
                  : "上传人像与驱动音频,生成对口型的数字人说话视频"}
            </p>
            {gen.status === "running" && (
              <div className="at-gen-progress" role="status" aria-label="生成进度">
                {gen.progress.max > 0 ? (
                  <>
                    <div className="at-gen-progress-track">
                      <div
                        className="at-gen-progress-fill"
                        style={{
                          width: `${Math.min(100, Math.round((gen.progress.value / gen.progress.max) * 100))}%`,
                        }}
                      />
                    </div>
                    <span className="at-gen-progress-text">
                      采样 {gen.progress.value}/{gen.progress.max}
                    </span>
                  </>
                ) : (
                  <span className="at-gen-progress-text">排队 / 准备中…</span>
                )}
                <Button variant="ghost" size="sm" onClick={gen.reset}>
                  取消等待
                </Button>
              </div>
            )}
            {gen.status === "error" && gen.error && (
              <ErrorBar
                className="at-gen-stage-error"
                message={gen.error}
                onClose={gen.reset}
              />
            )}
          </div>
        )}

        <Badge
          tone={!engineChecked ? "neutral" : engineReady ? "ok" : "err"}
          title={statusLabel}
          className="at-status-badge"
        >
          {statusLabel}
        </Badge>
      </div>

      {/* ── 右:参数面板(分组卡片:素材 / 提示词 / 生成参数) ── */}
      <div className="at-panel">
        <div className="at-panel-body">
          <div className="at-gen-form">
            {/* 素材:人像首帧 + 驱动音频 */}
            <section className="at-gen-section">
              <div className="at-section-head">
                <h3 className="at-section-title">素材</h3>
                <span className="at-section-count">
                  {(image ? 1 : 0) + (audio ? 1 : 0)}/2 已上传
                </span>
              </div>
            {/* 人像首帧 */}
            <Field
              label="人像首帧"
              hint={imgError ? undefined : "jpg / png / webp,单张 ≤ 20MB"}
              error={imgError ?? undefined}
            >
              {image ? (
                <div className="at-gen-file">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={image.previewUrl}
                    alt={image.name}
                    className="at-gen-file-thumb"
                    loading="lazy"
                    decoding="async"
                  />
                  <span className="at-gen-file-name" title={image.name}>
                    {image.name}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Icon name="close" size={13} />}
                    aria-label="移除人像图"
                    disabled={gen.isRunning}
                    onClick={() => setImage(null)}
                  />
                </div>
              ) : (
                <div style={{ display: "flex", gap: "var(--space-2)" }}>
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={imgUploading}
                    icon={<Icon name="upload" size={14} />}
                    disabled={gen.isRunning}
                    onClick={() => imgInputRef.current?.click()}
                  >
                    {imgUploading ? "上传中…" : "上传人像图"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Icon name="image" size={14} />}
                    disabled={gen.isRunning}
                    onClick={() => setPickerFor("image")}
                  >
                    作品库
                  </Button>
                </div>
              )}
              <input
                ref={imgInputRef}
                type="file"
                accept=".jpg,.jpeg,.png,.webp"
                style={{ display: "none" }}
                onChange={(e) => void onImageFile(e.target.files?.[0])}
              />
            </Field>

            {/* 驱动音频 */}
            <Field
              label="驱动音频"
              hint={audError ? undefined : "wav / mp3,≤ 20MB"}
              error={audError ?? undefined}
            >
              {audio ? (
                <div className="at-gen-audio">
                  <div className="at-gen-file">
                    <span className="at-gen-audio-icon">
                      <Icon name="audio" size={16} />
                    </span>
                    <span className="at-gen-file-name" title={audio.name}>
                      {audio.name}
                      {audio.duration ? `(${formatDuration(audio.duration)})` : ""}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<Icon name="close" size={13} />}
                      aria-label="移除音频"
                      disabled={gen.isRunning}
                      onClick={() => setAudio(null)}
                    />
                  </div>
                  {/* 试听 */}
                  {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                  <audio src={audio.previewUrl} controls className="at-gen-audio-player" />
                </div>
              ) : (
                <div style={{ display: "flex", gap: "var(--space-2)" }}>
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={audUploading}
                    icon={<Icon name="upload" size={14} />}
                    disabled={gen.isRunning}
                    onClick={() => audInputRef.current?.click()}
                  >
                    {audUploading ? "上传中…" : "上传音频"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Icon name="audio" size={14} />}
                    disabled={gen.isRunning}
                    onClick={() => setPickerFor("audio")}
                  >
                    作品库
                  </Button>
                </div>
              )}
              <input
                ref={audInputRef}
                type="file"
                accept=".wav,.mp3,.m4a,.flac,.ogg"
                style={{ display: "none" }}
                onChange={(e) => void onAudioFile(e.target.files?.[0])}
              />
            </Field>

            {workerMismatch && (
              <p className="at-gen-warn" role="alert">
                人像图与音频未落在同一 worker,请移除其中一个重新上传
              </p>
            )}
            </section>

            {/* 提示词 */}
            <section className="at-gen-section">
              <div className="at-section-head">
                <h3 className="at-section-title">提示词</h3>
                {/* AI 优化:中文意图 → 英文视频提示词(通用视频方言,negative 回填高级参数负向) */}
                <span className="at-gen-inline">
                  <span className="at-section-count">必填</span>
                  <OptimizeButton
                    prompt={positive}
                    kind="video"
                    engine="avatar-talk"
                    onOptimized={(text, neg) => {
                      setPositive(text);
                      if (neg) setNegative(neg);
                    }}
                    disabled={gen.isRunning}
                  />
                </span>
              </div>
            <Field label="正向提示词">
              <Textarea
                ref={positiveRef}
                rows={3}
                value={positive}
                placeholder="描述人物状态、表情与场景,如:一位女士面对镜头自然说话"
                disabled={gen.isRunning}
                onChange={(e) => setPositive(e.target.value)}
              />
            </Field>
            </section>

            {/* 生成参数 */}
            <section className="at-gen-section">
              <div className="at-section-head">
                <h3 className="at-section-title">生成参数</h3>
                <span className="at-section-count">
                  {preset.width}×{preset.height} · {steps} 步
                </span>
              </div>
            <Field label="分辨率">
              <Select
                value={resPreset}
                disabled={gen.isRunning}
                onChange={(e) => setResPreset(e.target.value)}
                aria-label="分辨率档位"
              >
                {RES_PRESETS.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="时长(秒)"
              hint={`${durationSec}s @ ${fps}fps ≈ ${estFrames} 帧;>3.7s 自动续段`}
            >
              <div className="at-gen-inline">
                <Input
                  type="number"
                  min={0.5}
                  max={100}
                  step={0.1}
                  value={durationSec}
                  disabled={gen.isRunning}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n)) setDurationSec(Math.min(100, Math.max(0.5, Math.round(n * 10) / 10)));
                  }}
                />
                {audio?.duration ? (
                  <Button variant="ghost" size="sm" onClick={matchDurationToAudio} disabled={gen.isRunning}>
                    匹配音频时长
                  </Button>
                ) : null}
              </div>
            </Field>

            <Field label="帧率(fps)" hint="Whisper 特征帧率与成片打包帧率同源">
              <Input
                type="number"
                min={8}
                max={30}
                step={1}
                value={fps}
                disabled={gen.isRunning}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n)) setFps(Math.min(30, Math.max(8, Math.round(n))));
                }}
              />
            </Field>

            <Field label="采样步数" hint="dmd 蒸馏 LoRA 低步数,默认 12">
              <Input
                type="number"
                min={1}
                max={50}
                step={1}
                value={steps}
                disabled={gen.isRunning}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n)) setSteps(Math.min(50, Math.max(1, Math.round(n))));
                }}
              />
            </Field>

            {/* 高级参数(默认折叠;默认值与后端一致) */}
            <details className="adv-params">
              <summary>
                高级参数
                <span className="adv-chevron">
                  <Icon name="chevron-down" size={13} />
                </span>
              </summary>
              <div className="adv-params-body">
                <Field label="负向提示词">
                  <Textarea
                    ref={negativeRef}
                    rows={2}
                    value={negative}
                    placeholder="留空使用引擎默认负向"
                    disabled={gen.isRunning}
                    onChange={(e) => setNegative(e.target.value)}
                  />
                </Field>
                <Field
                  label="随机种子"
                  hint={seedInvalid ? undefined : "留空则随机"}
                  error={seedInvalid ? "种子须为非负整数" : undefined}
                >
                  <Input
                    type="text"
                    inputMode="numeric"
                    value={seedText}
                    placeholder="留空随机"
                    disabled={gen.isRunning}
                    onChange={(e) => setSeedText(e.target.value)}
                  />
                </Field>
                <Field label="Shift" hint="1-30,默认 12">
                  <Input
                    type="number"
                    min={1}
                    max={30}
                    step={0.5}
                    value={shift}
                    disabled={gen.isRunning}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (Number.isFinite(n)) setShift(Math.min(30, Math.max(1, n)));
                    }}
                  />
                </Field>
                <Field label="CFG" hint="0-10,蒸馏链路默认 1.0">
                  <Input
                    type="number"
                    min={0}
                    max={10}
                    step={0.1}
                    value={cfg}
                    disabled={gen.isRunning}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (Number.isFinite(n)) setCfg(Math.min(10, Math.max(0, n)));
                    }}
                  />
                </Field>
                <Field label="DMD LoRA 强度" hint="0-2,默认 1.0">
                  <Input
                    type="number"
                    min={0}
                    max={2}
                    step={0.05}
                    value={dmdStrength}
                    disabled={gen.isRunning}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (Number.isFinite(n)) setDmdStrength(Math.min(2, Math.max(0, n)));
                    }}
                  />
                </Field>
              </div>
            </details>
            </section>
          </div>
        </div>

        <div className="at-gen-footer">
          {submitError && (
            <ErrorBar message={submitError} onClose={() => setSubmitError(null)} />
          )}
          <Button
            variant="primary"
            className="at-start-btn"
            onClick={() => void onGenerate()}
            disabled={!canSubmit}
            loading={submitting || gen.isRunning}
            icon={<Icon name="playing" size={16} />}
          >
            {gen.isRunning ? "生成中…" : submitting ? "提交中…" : "生成数字人视频"}
          </Button>
          {onNavigate && (
            <Button
              variant="ghost"
              size="sm"
              icon={<Icon name="library" size={14} />}
              onClick={() => onNavigate("library")}
            >
              去作品库
            </Button>
          )}
        </div>
      </div>

      {/* 作品库选取(人像/音频);钉住另一文件所在 worker,防跨机 */}
      <AssetPicker
        open={pickerFor !== null}
        onClose={() => setPickerFor(null)}
        assetType={pickerFor ?? "image"}
        kind="avatar"
        pinWorker={pickerFor === "image" ? audio?.worker : image?.worker}
        onPick={handlePickAsset}
      />
    </>
  );
}
