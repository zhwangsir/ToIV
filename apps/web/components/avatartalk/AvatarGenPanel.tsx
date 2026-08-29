"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  avatarAssetImageUrl,
  createAvatarAsset,
  cancelJob,
  generateAvatarTalk,
  imageUrl,
  invalidateJobs,
  listAvatarAssets,
  uploadImage,
  type AvatarAsset,
} from "@/lib/api";
import {
  buildAvatarTalkPayload,
  clampSpeed,
  driveTextReady,
  DRIVE_TEXT_MAX,
  SPEED_DEFAULT,
  SPEED_MAX,
  SPEED_MIN,
  type AvatarDriveMode,
} from "@/lib/avatarTalk";
import {
  BLEND_DEFAULT,
  KEY_COLOR_DEFAULT,
  SIMILARITY_DEFAULT,
  chromakeyCompose,
  workerViewUrl,
} from "@/lib/chromakey";
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

  // 形象模板(参考资产库 kind=avatar):选中即填入形象图,免重复上传
  const [templates, setTemplates] = useState<AvatarAsset[]>([]);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [saveName, setSaveName] = useState("");
  const [savingTpl, setSavingTpl] = useState(false);
  const [tplError, setTplError] = useState<string | null>(null);

  // 驱动源:上传音频(现有行为) | 文本驱动(TTS 直通,与音频互斥由 UI 保证)
  const [driveMode, setDriveMode] = useState<AvatarDriveMode>("audio");
  const [driveText, setDriveText] = useState("");
  const [voice, setVoice] = useState("");
  const [speed, setSpeed] = useState(SPEED_DEFAULT);

  const [positive, setPositive] = useState("");
  const [negative, setNegative] = useState("");
  // 正/负向提示词自动增高(负向在 closed <details> 内时 hook 自动跳过,展开后随输入增高)
  const positiveRef = useRef<HTMLTextAreaElement | null>(null);
  const negativeRef = useRef<HTMLTextAreaElement | null>(null);
  const driveTextRef = useRef<HTMLTextAreaElement | null>(null);
  useAutoResize(positiveRef, positive);
  useAutoResize(negativeRef, negative);
  useAutoResize(driveTextRef, driveText);
  const [resPreset, setResPreset] = useState<string>("480x832");
  const [durationSec, setDurationSec] = useState(3.7);
  const [fps, setFps] = useState(25);
  const [steps, setSteps] = useState(8);
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

  // ── 绿幕合成(M6):有产物视频时出现在结果区;形象模板绿幕标记默认展开 ──
  const [ckOpen, setCkOpen] = useState(false);
  const [ckBgType, setCkBgType] = useState<"color" | "image">("color");
  const [ckColorPreset, setCkColorPreset] = useState<"black" | "white" | "custom">("black");
  const [ckColorHex, setCkColorHex] = useState("#202040");
  const [ckBgImage, setCkBgImage] = useState<UploadedFile | null>(null);
  const [ckBgUploading, setCkBgUploading] = useState(false);
  const [ckKeyColor, setCkKeyColor] = useState(KEY_COLOR_DEFAULT);
  const [ckSimilarity, setCkSimilarity] = useState(SIMILARITY_DEFAULT);
  const [ckBlend, setCkBlend] = useState(BLEND_DEFAULT);
  const [ckSubmitting, setCkSubmitting] = useState(false);
  const [ckError, setCkError] = useState<string | null>(null);
  const [ckResultUrl, setCkResultUrl] = useState<string | null>(null);
  const ckBgInputRef = useRef<HTMLInputElement | null>(null);

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

  // 提交返回的 prompt_id:「取消等待」必须 cancelJob,不能只 gen.reset(作业继续跑)
  const runningPromptIdRef = useRef<string | null>(null);
  const gen = useGeneration({
    onDone: () => {
      runningPromptIdRef.current = null;
      invalidateJobs(); // 产物已落库,作品库缓存失效
    },
  });

  /** 产物视频相对路径(签名 URL,直接作 chromakey foreground_url,后端白名单认 /api/images?)。 */
  const resultUrl = gen.status === "done" && gen.resultPaths.length > 0 ? gen.resultPaths[0] : null;
  /** 当前选中形象模板是绿幕标记:折叠区默认展开并提示。 */
  const greenTpl = useMemo(
    () => templates.find((t) => t.id === selectedTemplateId)?.green_screen ?? false,
    [templates, selectedTemplateId],
  );
  useEffect(() => {
    if (greenTpl) setCkOpen(true);
  }, [greenTpl]);
  // 产物更换(重新生成)后清掉上次合成结果,避免播错片
  useEffect(() => {
    setCkResultUrl(null);
  }, [resultUrl]);

  // 形象模板列表:进入即拉取一次(失败不阻断主流程,保存成功后本地追加)
  useEffect(() => {
    let cancelled = false;
    listAvatarAssets()
      .then((list) => {
        if (!cancelled) setTemplates(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        /* 模板拉取失败仅影响模板区,不阻断上传/生成 */
      })
      .finally(() => {
        if (!cancelled) setTemplatesLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** 选中模板:直接引用其上传句柄填入形象图(免重复上传;预览走资产图回显端点)。 */
  function applyTemplate(t: AvatarAsset) {
    const img = t.images[0];
    if (!img) return;
    setImage({
      filename: img.filename,
      worker: img.worker,
      name: t.name,
      previewUrl: avatarAssetImageUrl(t.id, 0),
    });
    setSelectedTemplateId(t.id);
    setImgError(null);
  }

  /** 存为模板:把当前已上传形象图落为 avatar 资产(默认非绿幕),成功即选中。 */
  async function saveAsTemplate() {
    if (!image || savingTpl) return;
    const name = saveName.trim();
    if (!name) {
      setTplError("请先输入模板名称");
      return;
    }
    setTplError(null);
    setSavingTpl(true);
    try {
      const created = await createAvatarAsset({
        name,
        images: [{ filename: image.filename, worker: image.worker }],
        green_screen: false,
      });
      setTemplates((prev) => [created, ...prev]);
      setSelectedTemplateId(created.id);
      setSaveName("");
    } catch (e) {
      const raw = e instanceof Error ? e.message : "模板保存失败";
      setTplError(friendlyError(raw).message);
    } finally {
      setSavingTpl(false);
    }
  }

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
        setSelectedTemplateId(null); // 手动换图后不再与任何模板对应
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
      setSelectedTemplateId(null); // 手动上传与模板无关
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

  // 同 worker 兜底校验(钉住上传后理论恒等;不一致即提示重传)。仅音频模式参与:
  // 文本模式不带音频字段,残留音频句柄不参与提交。
  const workerMismatch =
    driveMode === "audio" && !!image && !!audio && image.worker !== audio.worker;

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

  // 驱动源就绪:音频模式需已上传音频;文本模式需非空文本(≤2000 字)
  const driveReady = driveMode === "audio" ? !!audio : driveTextReady(driveText);

  const canSubmit =
    !!image &&
    driveReady &&
    !workerMismatch &&
    positive.trim().length > 0 &&
    !seedInvalid &&
    engineReady &&
    !gen.isRunning &&
    !submitting &&
    !imgUploading &&
    !audUploading;

  async function onCancelWait() {
    const promptId = runningPromptIdRef.current;
    runningPromptIdRef.current = null;
    if (promptId) {
      try {
        await cancelJob(promptId);
      } catch (e) {
        setSubmitError(e instanceof Error ? e.message : "中止失败");
      }
    }
    gen.reset();
  }

  async function onGenerate() {
    if (!image || !canSubmit) return;
    if (driveMode === "audio" && !audio) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      const res = await generateAvatarTalk(
        buildAvatarTalkPayload(
          {
            image: image.filename,
            worker: image.worker,
            positive,
            negative,
            width: preset.width,
            height: preset.height,
            duration_sec: durationSec,
            fps,
            steps,
            shift,
            cfg,
            dmd_lora_strength: dmdStrength,
            seed: seedParsed,
          },
          driveMode === "audio"
            ? { mode: "audio", audio: audio!.filename }
            : { mode: "text", driveText, voice, speed },
        ),
      );
      runningPromptIdRef.current = res.prompt_id;
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

  // ── 绿幕合成(M6) ──
  /** 背景色字面值:预设颜色名直传;自定义 hex(#RRGGBB)转后端契约 0xRRGGBB。 */
  const ckBgColor = ckColorPreset === "custom" ? "0x" + ckColorHex.slice(1).toUpperCase() : ckColorPreset;

  /** 上传背景图(走 /api/upload,句柄转 worker /view 直链,后端白名单认 worker host)。 */
  async function onCkBgFile(file: File | undefined) {
    if (!file) return;
    setCkError(null);
    if (!IMAGE_EXT_OK.includes(fileExt(file.name))) {
      setCkError("背景图仅支持 jpg / png / webp");
      return;
    }
    if (file.size > MAX_BYTES) {
      setCkError("背景图超过 20MB 上限");
      return;
    }
    setCkBgUploading(true);
    try {
      const r = await uploadImage(file, "avatar", false);
      setCkBgImage({
        filename: r.filename,
        worker: r.worker,
        name: file.name,
        previewUrl: URL.createObjectURL(file),
      });
    } catch (e) {
      setCkError(e instanceof Error ? e.message : "背景图上传失败");
    } finally {
      setCkBgUploading(false);
      if (ckBgInputRef.current) ckBgInputRef.current.value = "";
    }
  }

  async function onChromakey() {
    if (!resultUrl || ckSubmitting) return;
    if (ckBgType === "image" && !ckBgImage) {
      setCkError("请先上传背景图");
      return;
    }
    setCkError(null);
    setCkSubmitting(true);
    try {
      const r = await chromakeyCompose({
        foreground_url: resultUrl,
        background:
          ckBgType === "image"
            ? { mode: "image", url: workerViewUrl(ckBgImage!) }
            : { mode: "color", color: ckBgColor },
        key_color: ckKeyColor,
        similarity: ckSimilarity,
        blend: ckBlend,
      });
      setCkResultUrl(r.url);
      invalidateJobs(); // 产物建档 kind=chromakey,作品库缓存失效
    } catch (e) {
      const raw = e instanceof Error ? e.message : "绿幕合成失败";
      setCkError(friendlyError(raw).message);
    } finally {
      setCkSubmitting(false);
    }
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
                  : "上传人像,用音频或文本驱动,生成对口型的数字人说话视频"}
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
                <Button variant="ghost" size="sm" onClick={() => void onCancelWait()} title="中止后端作业并停止本页跟踪">
                  停止
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

        {/* 绿幕合成(M6):有产物视频时出现;形象模板绿幕标记默认展开提示 */}
        {resultUrl && (
          <section className={`at-ck${ckOpen ? " is-open" : ""}`} aria-label="绿幕合成">
            <button
              type="button"
              className="at-ck-head"
              aria-expanded={ckOpen}
              onClick={() => setCkOpen((v) => !v)}
            >
              <span className="at-ck-title">
                <Icon name="layers" size={14} />
                绿幕合成
              </span>
              {greenTpl && (
                <Badge tone="ok" dot={false}>
                  绿幕形象,可直接合成
                </Badge>
              )}
              <span className="at-ck-chevron">
                <Icon name={ckOpen ? "chevron-down" : "chevron-up"} size={13} />
              </span>
            </button>
            {ckOpen && (
              <div className="at-ck-body">
                <Field label="背景类型">
                  <div className="at-seg" role="tablist" aria-label="背景类型">
                    {(
                      [
                        { key: "color", label: "纯色" },
                        { key: "image", label: "背景图" },
                      ] as const
                    ).map((t) => (
                      <button
                        key={t.key}
                        type="button"
                        role="tab"
                        aria-selected={ckBgType === t.key}
                        className={`at-seg-btn${ckBgType === t.key ? " is-active" : ""}`}
                        disabled={ckSubmitting}
                        onClick={() => setCkBgType(t.key)}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                </Field>

                {ckBgType === "color" ? (
                  <Field label="背景色">
                    <div className="at-gen-inline">
                      <div className="at-seg" role="tablist" aria-label="背景色">
                        {(
                          [
                            { key: "black", label: "黑色" },
                            { key: "white", label: "白色" },
                            { key: "custom", label: "自定义" },
                          ] as const
                        ).map((c) => (
                          <button
                            key={c.key}
                            type="button"
                            role="tab"
                            aria-selected={ckColorPreset === c.key}
                            className={`at-seg-btn${ckColorPreset === c.key ? " is-active" : ""}`}
                            disabled={ckSubmitting}
                            onClick={() => setCkColorPreset(c.key)}
                          >
                            {c.label}
                          </button>
                        ))}
                      </div>
                      {ckColorPreset === "custom" && (
                        <input
                          type="color"
                          value={ckColorHex}
                          aria-label="自定义背景色"
                          disabled={ckSubmitting}
                          className="at-ck-colorwell"
                          onChange={(e) => setCkColorHex(e.target.value)}
                        />
                      )}
                    </div>
                  </Field>
                ) : (
                  <Field label="背景图" hint="jpg / png / webp,≤ 20MB">
                    {ckBgImage ? (
                      <div className="at-gen-file">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={ckBgImage.previewUrl}
                          alt={ckBgImage.name}
                          className="at-gen-file-thumb"
                          loading="lazy"
                          decoding="async"
                        />
                        <span className="at-gen-file-name" title={ckBgImage.name}>
                          {ckBgImage.name}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={<Icon name="close" size={13} />}
                          aria-label="移除背景图"
                          disabled={ckSubmitting}
                          onClick={() => setCkBgImage(null)}
                        />
                      </div>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={ckBgUploading}
                        icon={<Icon name="upload" size={14} />}
                        disabled={ckSubmitting}
                        onClick={() => ckBgInputRef.current?.click()}
                      >
                        {ckBgUploading ? "上传中…" : "上传背景图"}
                      </Button>
                    )}
                    <input
                      ref={ckBgInputRef}
                      type="file"
                      accept=".jpg,.jpeg,.png,.webp"
                      style={{ display: "none" }}
                      onChange={(e) => void onCkBgFile(e.target.files?.[0])}
                    />
                  </Field>
                )}

                <Field label="抠像色" hint="ffmpeg chromakey 颜色,默认 0x00FF00(纯绿)">
                  <Input
                    type="text"
                    value={ckKeyColor}
                    maxLength={8}
                    placeholder="0x00FF00"
                    disabled={ckSubmitting}
                    onChange={(e) => setCkKeyColor(e.target.value)}
                  />
                </Field>
                <Field label={`相似度 ${ckSimilarity.toFixed(2)}`} hint="越大抠得越宽,默认 0.18">
                  <input
                    type="range"
                    min={0.01}
                    max={1}
                    step={0.01}
                    value={ckSimilarity}
                    disabled={ckSubmitting}
                    aria-label="相似度"
                    onChange={(e) => setCkSimilarity(Number(e.target.value))}
                  />
                </Field>
                <Field label={`边缘柔化 ${ckBlend.toFixed(2)}`} hint="边缘过渡,默认 0.08">
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={ckBlend}
                    disabled={ckSubmitting}
                    aria-label="边缘柔化"
                    onChange={(e) => setCkBlend(Number(e.target.value))}
                  />
                </Field>

                {ckError && (
                  <p className="at-gen-warn" role="alert">
                    {ckError}
                  </p>
                )}
                <Button
                  variant="primary"
                  size="sm"
                  loading={ckSubmitting}
                  icon={<Icon name="scissors" size={14} />}
                  disabled={ckBgType === "image" && !ckBgImage}
                  onClick={() => void onChromakey()}
                >
                  {ckSubmitting ? "合成中…" : "开始合成"}
                </Button>

                {ckResultUrl && (
                  /* eslint-disable-next-line jsx-a11y/media-has-caption */
                  <video
                    className="at-ck-result"
                    src={imageUrl(ckResultUrl)}
                    controls
                    playsInline
                    aria-label="绿幕合成结果"
                  />
                )}
              </div>
            )}
          </section>
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
            {/* 形象模板:选中即填入形象图(免重复上传);当前形象可存为模板复用 */}
            <section className="at-gen-section">
              <div className="at-section-head">
                <h3 className="at-section-title">形象模板</h3>
                <span className="at-section-count">
                  {!templatesLoaded ? "加载中" : `${templates.length} 个已存`}
                </span>
              </div>
              {templates.length > 0 ? (
                <div className="at-avatar-grid">
                  {templates.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className={`at-avatar-card${t.id === selectedTemplateId ? " is-selected" : ""}`}
                      disabled={gen.isRunning}
                      onClick={() => applyTemplate(t)}
                      title={t.description || t.name}
                    >
                      <div className="at-avatar-preview">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={avatarAssetImageUrl(t.id, 0)}
                          alt={t.name}
                          loading="lazy"
                          decoding="async"
                        />
                      </div>
                      <div className="at-avatar-info">
                        <span className="at-avatar-name">{t.name}</span>
                        {t.green_screen && (
                          <Badge tone="ok" dot={false}>
                            绿幕
                          </Badge>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                templatesLoaded && (
                  <p className="at-models-empty">
                    暂无形象模板:先上传人像图,点下方「存为模板」,下次一键复用
                  </p>
                )
              )}
              <div className="at-gen-inline">
                <Input
                  type="text"
                  value={saveName}
                  maxLength={100}
                  placeholder={image ? "模板名称(存当前形象图)" : "先上传人像图,再存为模板"}
                  disabled={gen.isRunning || savingTpl || !image}
                  onChange={(e) => setSaveName(e.target.value)}
                  aria-label="模板名称"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  loading={savingTpl}
                  icon={<Icon name="save" size={14} />}
                  disabled={gen.isRunning || !image || !saveName.trim()}
                  onClick={() => void saveAsTemplate()}
                >
                  存为模板
                </Button>
              </div>
              {tplError && (
                <p className="at-gen-warn" role="alert">
                  {tplError}
                </p>
              )}
            </section>

            {/* 素材:人像首帧 + 驱动音频 */}
            <section className="at-gen-section">
              <div className="at-section-head">
                <h3 className="at-section-title">素材</h3>
                <span className="at-section-count">
                  {(image ? 1 : 0) + (driveReady ? 1 : 0)}/2 已就绪
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
                    onClick={() => {
                      setImage(null);
                      setSelectedTemplateId(null);
                    }}
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

            {/* 驱动源:上传音频(现有行为) | 文本驱动(TTS 直通),互斥由段控保证 */}
            <Field label="驱动源">
              <div className="at-seg" role="tablist" aria-label="驱动源">
                {(
                  [
                    { key: "audio", label: "上传音频" },
                    { key: "text", label: "文本驱动" },
                  ] as const
                ).map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    role="tab"
                    aria-selected={driveMode === t.key}
                    className={`at-seg-btn${driveMode === t.key ? " is-active" : ""}`}
                    disabled={gen.isRunning}
                    onClick={() => setDriveMode(t.key)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </Field>

            {driveMode === "audio" ? (
            /* 驱动音频 */
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
            ) : (
            /* 文本驱动(TTS 直通):drive_text ≤2000 字 + 音色(可选)+ 语速 0.5-2.0 */
            <>
            <Field
              label="驱动文本"
              hint={`${driveText.length}/${DRIVE_TEXT_MAX} 字,经 IndexTTS 合成语音驱动`}
            >
              <Textarea
                ref={driveTextRef}
                rows={4}
                value={driveText}
                maxLength={DRIVE_TEXT_MAX}
                placeholder="输入数字人要说的内容(≤2000 字)"
                disabled={gen.isRunning}
                onChange={(e) => setDriveText(e.target.value)}
              />
            </Field>
            <Field label="音色(可选)" hint="留空使用引擎默认音色">
              <Input
                type="text"
                value={voice}
                placeholder="默认音色"
                disabled={gen.isRunning}
                onChange={(e) => setVoice(e.target.value)}
              />
            </Field>
            <Field label={`语速 ${speed.toFixed(2)}×`} hint="0.5-2.0,默认 1.0">
              <input
                type="range"
                min={SPEED_MIN}
                max={SPEED_MAX}
                step={0.05}
                value={speed}
                disabled={gen.isRunning}
                aria-label="语速"
                onChange={(e) => setSpeed(clampSpeed(Number(e.target.value)))}
              />
            </Field>
            </>
            )}

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

            <Field label="采样步数" hint="DMD2 蒸馏官方 8 步;画质不足可回调 12">
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
