"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Field, Input, Select } from "@/components/ui/Input";
import { OptimizeButton } from "@/components/ui/OptimizeButton";
import { PageHeader } from "@/components/ui/PageHeader";
import { AssetPicker, type PickedAsset } from "@/components/generate/AssetPicker";
import { OrbitViewer } from "@/components/image-edit/OrbitViewer";
import { ModelViewer } from "@/components/ui/ModelViewer";
import {
  generate3D,
  generateFaceDetailer,
  generateInpaint,
  generateQwenEdit,
  generateRemoveBg,
  generateUpscale,
  imageUrl,
  invalidateJobs,
  threeDOps,
  uploadImage,
} from "@/lib/api";
import type { GenerateResponse } from "@/lib/types";
import { useToast } from "@/components/ui/Toast";
import { trackJob, TrackJobAbortError, type JobProgress } from "@/lib/trackJob";

// ─────────────────────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────────────────────

type EditTool = "removebg" | "upscale" | "inpaint" | "facedetailer" | "qwenedit" | "camera3d" | "hunyuan3d";

interface ToolDef {
  key: EditTool;
  icon: IconName;
  title: string;
  desc: string;
  runLabel: string;
}

interface ProcessState {
  status: "idle" | "running" | "done" | "error";
  tool: EditTool | null;
  progress: JobProgress | null;
  resultUrl: string | null;
  resultPaths: string[];
  error: string | null;
}

interface UploadedImage {
  /** 本地上传的原文件;从作品库选取时为 null(预览走签名产物 URL) */
  file: File | null;
  filename: string;
  worker: string;
  previewUrl: string;
  name: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────────────────────

const TOOLS: ToolDef[] = [
  {
    key: "removebg",
    icon: "scissors",
    title: "智能去背景",
    desc: "一键移除图片背景，支持通用/动漫/人物模式",
    runLabel: "开始去背",
  },
  {
    key: "upscale",
    icon: "zoom-in",
    title: "高清增强",
    desc: "放大图片分辨率并修复细节，最高 4 倍",
    runLabel: "开始增强",
  },
  {
    key: "inpaint",
    icon: "brush",
    title: "局部重绘",
    desc: "用文字描述替换图片中的指定区域",
    runLabel: "开始重绘",
  },
  {
    key: "facedetailer",
    icon: "user",
    title: "人脸修复",
    desc: "智能检测并修复模糊、低质量人脸",
    runLabel: "开始修复",
  },
  {
    key: "qwenedit",
    icon: "sparkles",
    title: "智能编辑(Qwen)",
    desc: "自然语言语义编辑，支持多角度相机控制",
    runLabel: "开始编辑",
  },
  {
    key: "camera3d",
    icon: "rotate-cw",
    title: "3D 相机(360°)",
    desc: "精确控制方位/俯仰/距离，环绕一圈看全貌",
    runLabel: "生成视角",
  },
  {
    key: "hunyuan3d",
    icon: "model3d",
    title: "图生3D(Hunyuan3D)",
    desc: "单图生成 3D 模型，输出 GLB 网格文件",
    runLabel: "生成 3D 模型",
  },
];

const REMOVE_BG_MODES = [
  { value: "general", label: "通用" },
  { value: "anime", label: "动漫" },
  { value: "human", label: "人物" },
] as const;

const UPSCALE_SCALES = [
  { value: 2, label: "2 倍" },
  { value: 3, label: "3 倍" },
  { value: 4, label: "4 倍" },
] as const;

// Qwen-Image-Edit 相机角度预设(value 与后端 workflows/qwen_edit.CAMERA_PRESETS 的 key 一致)
const QWEN_CAMERAS = [
  { value: "", label: "无(仅语义编辑)" },
  { value: "forward", label: "镜头前移" },
  { value: "left", label: "镜头左移" },
  { value: "right", label: "镜头右移" },
  { value: "up", label: "镜头上移" },
  { value: "down", label: "镜头下移" },
  { value: "rotate_left", label: "向左旋转 45°" },
  { value: "rotate_right", label: "向右旋转 45°" },
  { value: "top_down", label: "俯视" },
  { value: "wide", label: "广角" },
  { value: "closeup", label: "特写" },
] as const;

const QWEN_SPEEDS = [
  { value: "fast", label: "快速(Lightning 8 步)" },
  { value: "standard", label: "标准(20 步,更细腻)" },
] as const;

// ── 3D 相机(2511 底模 + fal 96 机位 LoRA;value 与后端 CAMERA3D_* 一致)──
const CAM3D_AZIMUTHS = [
  { value: 0, label: "正面" },
  { value: 45, label: "右前 45°" },
  { value: 90, label: "右侧" },
  { value: 135, label: "右后 45°" },
  { value: 180, label: "背面" },
  { value: 225, label: "左后 45°" },
  { value: 270, label: "左侧" },
  { value: 315, label: "左前 45°" },
] as const;
const CAM3D_ELEVATIONS = [
  { value: -30, label: "仰视(低机位)" },
  { value: 0, label: "平视" },
  { value: 30, label: "俯视(浅)" },
  { value: 60, label: "俯视(高机位)" },
] as const;
const CAM3D_DISTANCES = [
  { value: "closeup", label: "特写" },
  { value: "medium", label: "标准" },
  { value: "wide", label: "广角" },
] as const;
const CAM3D_SPEEDS = [
  { value: "fast", label: "快速(Lightning 4 步)" },
  { value: "standard", label: "标准(20 步,更细腻)" },
] as const;

// ── 图生3D(Hunyuan3D):octree 分辨率档位(后端允许 64-512,常用取 2 的幂)──
const THREED_OCTREES = [
  { value: 64, label: "64(最快,粗糙)" },
  { value: 128, label: "128" },
  { value: 256, label: "256(默认,均衡)" },
  { value: 384, label: "384" },
  { value: 512, label: "512(最精细,最慢)" },
] as const;

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB，与后端一致
const ACCEPTED_EXTS = [".jpg", ".jpeg", ".png", ".webp"];

function isValidImage(file: File): boolean {
  const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  return ACCEPTED_EXTS.includes(ext);
}

// ─────────────────────────────────────────────────────────────────────────────
// 子组件:拖拽上传区
// ─────────────────────────────────────────────────────────────────────────────

interface DropZoneProps {
  onUpload: (file: File) => void;
  /** 打开作品库选择器(二次创作:直接用已生成的图) */
  onPickLibrary: () => void;
  uploading: boolean;
  error: string | null;
  onClearError: () => void;
}

function DropZone({ onUpload, onPickLibrary, uploading, error, onClearError }: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleDrag = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragIn = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.items?.length) setDragOver(true);
  }, []);

  const handleDragOut = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      const files = e.dataTransfer.files;
      if (files?.length) onUpload(files[0]);
    },
    [onUpload],
  );

  return (
    <div className="ie-dropzone-wrap">
      <button
        type="button"
        className={`ie-dropzone${dragOver ? " is-dragover" : ""}${uploading ? " is-uploading" : ""}`}
        onClick={() => inputRef.current?.click()}
        onDragEnter={handleDragIn}
        onDragLeave={handleDragOut}
        onDragOver={handleDrag}
        onDrop={handleDrop}
        disabled={uploading}
        aria-label="上传图片"
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_EXTS.join(",")}
          className="sr-only"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onUpload(f);
            e.target.value = "";
          }}
        />
        <span className="ie-dropzone-icon">
          {uploading ? <Icon name="loading" size={48} /> : <Icon name="upload" size={48} />}
        </span>
        <span className="ie-dropzone-title">
          {uploading ? "上传中…" : "拖拽图片到这里，或点击选择"}
        </span>
        <span className="ie-dropzone-desc">支持 JPG / PNG / WebP，不超过 20MB</span>
      </button>
      {error && (
        <ErrorBar className="ie-error" message={error} onClose={onClearError} />
      )}
      <Button
        size="sm"
        variant="secondary"
        className="ie-library-pick"
        icon={<Icon name="image" size={14} />}
        onClick={onPickLibrary}
        disabled={uploading}
      >
        从作品库选择
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 子组件:原图预览
// ─────────────────────────────────────────────────────────────────────────────

function SourcePreview({ image }: { image: UploadedImage }) {
  return (
    <Card className="at-card ie-preview-card">
      <div className="ie-preview-head">
        <span className="ie-preview-label">原图</span>
      </div>
      <div className="ie-preview-media">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {/* CLS 防护:1:1 设计基准值;CSS max-width/max-height + object-fit:contain 保持实际纵横比(.ie-preview-img) */}
        <img
          src={image.previewUrl}
          alt={image.name}
          className="ie-preview-img"
          width={1024}
          height={1024}
          loading="lazy"
          decoding="async"
        />
      </div>
      <p className="ie-preview-name" title={image.name}>
        {image.name}
      </p>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 子组件:工具卡片
// ─────────────────────────────────────────────────────────────────────────────

interface ToolCardProps {
  tool: ToolDef;
  active: boolean;
  disabled: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}

function ToolCard({ tool, active, disabled, onSelect, children }: ToolCardProps) {
  return (
    <div className={`at-card ie-tool-card${active ? " is-active" : ""}`}>
      <button
        type="button"
        className="ie-tool-head"
        onClick={onSelect}
        disabled={disabled}
        aria-expanded={active}
      >
        <span className="ie-tool-icon">
          <Icon name={tool.icon} size={18} />
        </span>
        <span className="ie-tool-text">
          <span className="ie-tool-title">{tool.title}</span>
          <span className="ie-tool-desc">{tool.desc}</span>
        </span>
        <Icon name={active ? "chevron-up" : "chevron-down"} size={16} className="ie-tool-chevron" />
      </button>
      {active && <div className="ie-tool-body">{children}</div>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 子组件:结果对比区
// ─────────────────────────────────────────────────────────────────────────────

interface ResultPanelProps {
  source: UploadedImage;
  resultUrl: string;
  resultPaths: string[];
}

function ResultPanel({ source, resultUrl, resultPaths }: ResultPanelProps) {
  const [mode, setMode] = useState<"compare" | "result">("result");
  const fullUrl = imageUrl(resultUrl);
  const downloadName = `toiv-edited-${Date.now()}.${resultUrl.split(".").pop() ?? "png"}`;

  return (
    <Card className="at-card ie-result-card">
      <div className="ie-result-head">
        <span className="ie-result-label">处理结果</span>
        <div className="ie-result-actions">
          <div className="at-seg ie-result-toggle" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "result"}
              className={`at-seg-btn ie-toggle-btn${mode === "result" ? " is-active" : ""}`}
              onClick={() => setMode("result")}
            >
              结果
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "compare"}
              className={`at-seg-btn ie-toggle-btn${mode === "compare" ? " is-active" : ""}`}
              onClick={() => setMode("compare")}
            >
              对比
            </button>
          </div>
          <a href={fullUrl} download={downloadName} className="at-btn at-btn--primary ie-download-btn">
            <Icon name="download" size={13} />
            下载结果
          </a>
        </div>
      </div>

      {mode === "result" ? (
        <div className="ie-result-media">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {/* CLS 防护:1:1 设计基准值;CSS 约束保持实际纵横比(.ie-result-img) */}
          <img
            src={fullUrl}
            alt="处理结果"
            className="ie-result-img"
            width={1024}
            height={1024}
            loading="lazy"
            decoding="async"
          />
        </div>
      ) : (
        <div className="ie-compare-grid">
          <div className="ie-compare-col">
            <span className="ie-compare-tag">原图</span>
            <div className="ie-compare-media">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {/* CLS 防护:1:1 设计基准值;CSS 约束保持实际纵横比(.ie-compare-img) */}
              <img
                src={source.previewUrl}
                alt="原图"
                className="ie-compare-img"
                width={1024}
                height={1024}
                loading="lazy"
                decoding="async"
              />
            </div>
          </div>
          <div className="ie-compare-col">
            <span className="ie-compare-tag is-result">结果</span>
            <div className="ie-compare-media">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {/* CLS 防护:1:1 设计基准值;CSS 约束保持实际纵横比(.ie-compare-img) */}
              <img
                src={fullUrl}
                alt="处理结果"
                className="ie-compare-img"
                width={1024}
                height={1024}
                loading="lazy"
                decoding="async"
              />
            </div>
          </div>
        </div>
      )}

      {resultPaths.length > 1 && (
        <p className="ie-result-note">共生成 {resultPaths.length} 张，已自动存入作品库</p>
      )}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 子组件:3D 模型结果卡(内联 model-viewer 交互预览 + 文件名 + 下载)
// ─────────────────────────────────────────────────────────────────────────────

function Model3DResult({ resultUrl }: { resultUrl: string }) {
  const fullUrl = imageUrl(resultUrl); // 带 token 查询参数,与图片产物同规则
  const filename = resultUrl.split("?")[0].split("/").pop() ?? "model.glb";
  const toast = useToast();
  const [bakeBusy, setBakeBusy] = useState(false);
  const [bakePreset, setBakePreset] = useState<string>("clay");

  // 应用材质生成新模型:从签名产物 URL 解析 filename/worker 作为 /api/3d/ops 的
  // source 句柄;out=glb 把材质预设烘焙回模型,产物(threed_render GLB)作为新作业
  // 进作品库 3D 桶,与灯箱 3D 操作条同一链路
  const bakeMaterial = async () => {
    if (bakeBusy) return;
    let qs: URLSearchParams;
    try {
      qs = new URLSearchParams(resultUrl.split("?")[1] ?? "");
    } catch {
      toast.error("无法解析 3D 产物来源");
      return;
    }
    const glbFilename = qs.get("filename");
    const worker = qs.get("worker");
    if (!glbFilename || !worker) {
      toast.error("无法解析 3D 产物来源");
      return;
    }
    setBakeBusy(true);
    try {
      await threeDOps({
        op: "render",
        source: { filename: glbFilename, worker },
        material: bakePreset as "clay",
        out: "glb",
      });
      invalidateJobs();
      toast.success("新 3D 模型已生成,已收入作品库(3D 筛选)");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "3D 渲染失败");
    } finally {
      setBakeBusy(false);
    }
  };

  return (
    <Card className="at-card ie-result-card">
      <div className="ie-result-head">
        <span className="ie-result-label">3D 模型已生成</span>
        <div className="ie-model3d-actions">
          <select
            className="ie-model3d-preset"
            aria-label="材质预设"
            value={bakePreset}
            disabled={bakeBusy}
            onChange={(e) => setBakePreset(e.target.value)}
          >
            <option value="clay">黏土</option>
            <option value="matte">哑光</option>
            <option value="metal">金属</option>
            <option value="glossy">陶瓷</option>
          </select>
          <button
            type="button"
            className="at-btn ie-model3d-bake-btn"
            disabled={bakeBusy}
            onClick={bakeMaterial}
          >
            <Icon name={bakeBusy ? "loading" : "model3d"} size={13} />
            应用材质生成新模型
          </button>
          <a href={fullUrl} download={filename} className="at-btn at-btn--primary ie-download-btn">
            <Icon name="download" size={13} />
            下载 GLB
          </a>
        </div>
      </div>
      {/* 浏览器内交互预览:轨道旋转/缩放,高度约束在容器 */}
      <div className="ie-model3d-viewer">
        <ModelViewer src={fullUrl} />
      </div>
      <div className="ie-model3d-body">
        <Icon name="model3d" size={40} />
        <span className="ie-model3d-name" title={filename}>
          {filename}
        </span>
        <span className="ie-model3d-hint">GLB 网格文件，可导入 Blender / 3D 查看器，已存入作品库(3D 筛选)</span>
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 子组件:进度条
// ─────────────────────────────────────────────────────────────────────────────

function ProgressBar({ progress }: { progress: JobProgress }) {
  const pct = progress.max > 0 ? progress.pct : 0;
  return (
    <div className="ie-progress">
      <div className="ie-progress-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="ie-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="ie-progress-text">
        {progress.max > 0 ? `处理中 ${progress.value}/${progress.max}` : "排队中…"}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 主组件
// ─────────────────────────────────────────────────────────────────────────────

export function ImageEditView() {
  const [source, setSource] = useState<UploadedImage | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [tool, setTool] = useState<EditTool>("removebg");
  const [removeBgMode, setRemoveBgMode] = useState<string>("general");
  const [upscaleScale, setUpscaleScale] = useState<number>(2);
  const [inpaintTarget, setInpaintTarget] = useState("");
  const [inpaintPositive, setInpaintPositive] = useState("");
  const [inpaintNegative, setInpaintNegative] = useState("");
  const [faceDenoise, setFaceDenoise] = useState(0.5);
  const [qwenPositive, setQwenPositive] = useState("");
  const [qwenCamera, setQwenCamera] = useState<string>("");
  const [qwenSpeed, setQwenSpeed] = useState<string>("fast");
  // 3D 相机(2511):方位/俯仰/距离 + 附加指令 + 360° 环绕序列
  const [cam3dAzimuth, setCam3dAzimuth] = useState<number>(45);
  const [cam3dElevation, setCam3dElevation] = useState<number>(0);
  const [cam3dDistance, setCam3dDistance] = useState<string>("medium");
  const [cam3dNote, setCam3dNote] = useState("");
  const [cam3dSpeed, setCam3dSpeed] = useState<string>("fast");
  const [cam3dOrbit, setCam3dOrbit] = useState(false);
  // 360° 旋转查看器当前帧(环绕序列集齐后启用;胶片条点击/拖拽/箭头共用)
  const [orbitFrame, setOrbitFrame] = useState(0);
  // 图生3D(Hunyuan3D):步数/octree 分辨率/seed(可空=随机)
  const [threedSteps, setThreedSteps] = useState(30);
  const [threedOctree, setThreedOctree] = useState(256);
  const [threedSeed, setThreedSeed] = useState("");
  // 作品库选图(二次创作):AssetPicker 转运句柄与上传产物同构,直接灌 source
  const [pickerOpen, setPickerOpen] = useState(false);

  const [proc, setProc] = useState<ProcessState>({
    status: "idle",
    tool: null,
    progress: null,
    resultUrl: null,
    resultPaths: [],
    error: null,
  });

  const esRef = useRef<EventSource | null>(null);
  // 当前跟踪的中止控制器:卸载/重新上传/重入 runTool 时 abort,让 trackJob 立即 settle
  // (只 close EventSource 不会让 trackJob 的 Promise 落定,看门狗还会软重连复活跟踪)
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
      esRef.current?.close();
      esRef.current = null;
    };
  }, []);

  /** 中止当前作业跟踪(abort 优先,close 兜底):trackJob 立即 settle 并自行关流。 */
  const stopTracking = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    esRef.current?.close();
    esRef.current = null;
  }, []);

  const resetSource = useCallback(() => {
    // 只 revoke 本地上传的 blob: URL;作品库选取的 previewUrl 是签名 HTTP URL,revoke 无意义
    if (source?.previewUrl.startsWith("blob:")) URL.revokeObjectURL(source.previewUrl);
    setSource(null);
    setUploadError(null);
    setProc({ status: "idle", tool: null, progress: null, resultUrl: null, resultPaths: [], error: null });
    stopTracking();
  }, [source, stopTracking]);

  /** 从作品库选图:转运完成即设为源图(与上传产物同构:PickedAsset={filename,worker,previewUrl,name})。 */
  const handlePickLibrary = useCallback(
    (a: PickedAsset) => {
      if (source?.previewUrl.startsWith("blob:")) URL.revokeObjectURL(source.previewUrl);
      setSource({ file: null, filename: a.filename, worker: a.worker, previewUrl: a.previewUrl, name: a.name });
      setUploadError(null);
      setProc({ status: "idle", tool: null, progress: null, resultUrl: null, resultPaths: [], error: null });
      setPickerOpen(false);
    },
    [source],
  );

  const handleUpload = useCallback(
    async (file: File) => {
      setUploadError(null);
      if (!isValidImage(file)) {
        setUploadError("仅支持 JPG / PNG / WebP 格式");
        return;
      }
      if (file.size > MAX_FILE_SIZE) {
        setUploadError("图片超过 20MB 上限");
        return;
      }
      setUploading(true);
      try {
        const res = await uploadImage(file, "img2img");
        if (!mountedRef.current) return;
        setSource({
          file,
          filename: res.filename,
          worker: res.worker,
          previewUrl: URL.createObjectURL(file),
          name: file.name,
        });
        setProc({ status: "idle", tool: null, progress: null, resultUrl: null, resultPaths: [], error: null });
      } catch (e) {
        if (mountedRef.current) {
          setUploadError(e instanceof Error ? e.message : "上传失败");
        }
      } finally {
        if (mountedRef.current) setUploading(false);
      }
    },
    [],
  );

  const runTool = useCallback(async () => {
    if (!source || proc.status === "running") return;
    stopTracking();
    const ac = new AbortController();
    abortRef.current = ac;
    setProc({ status: "running", tool, progress: null, resultUrl: null, resultPaths: [], error: null });

    // 360° 环绕序列:8 个方位逐个提交+跟踪,全部完成后成组展示(随时可 abort)
    if (tool === "camera3d" && cam3dOrbit) {
      try {
        setOrbitFrame(0);
        // 内容分组 id:同批 8 张作业务带同一 batch_id,作品库折叠为一个文件夹
        const batchId = crypto.randomUUID();
        const paths: string[] = [];
        for (const az of CAM3D_AZIMUTHS) {
          const res = await generateQwenEdit({
            image: source.filename,
            worker: source.worker,
            positive: cam3dNote.trim(),
            azimuth: az.value,
            elevation: cam3dElevation,
            distance: cam3dDistance,
            fast: cam3dSpeed === "fast",
            batchId,
          });
          const got = await trackJob(res, {
            label: `3D 相机 ${az.value}°`,
            signal: ac.signal,
            register: (es) => {
              esRef.current = es;
            },
          });
          if (!mountedRef.current) return;
          paths.push(...got);
          // 逐张落地即更新:结果区先出已完成的方位,不必等满 8 张
          setProc((prev) => ({
            ...prev,
            resultUrl: prev.resultUrl ?? got[0] ?? null,
            resultPaths: [...paths],
          }));
        }
        if (!mountedRef.current) return;
        setProc((prev) => ({ ...prev, status: "done", progress: null }));
        invalidateJobs();
      } catch (e) {
        if (!mountedRef.current) return;
        if (e instanceof TrackJobAbortError) return; // 显式中止:静默(部分结果已落地保留)
        setProc((prev) => ({
          ...prev,
          status: "error",
          error: e instanceof Error ? e.message : "环绕序列生成失败",
          progress: null,
        }));
      }
      return;
    }

    let res: GenerateResponse;
    try {
      const base = { image: source.filename, worker: source.worker };
      switch (tool) {
        case "removebg":
          res = await generateRemoveBg({ ...base, mode: removeBgMode });
          break;
        case "upscale":
          res = await generateUpscale({ ...base, scale: upscaleScale });
          break;
        case "inpaint":
          if (!inpaintTarget.trim() || !inpaintPositive.trim()) {
            setProc((p) => ({ ...p, status: "error", error: "请填写要修改的区域和替换内容" }));
            return;
          }
          res = await generateInpaint({
            ...base,
            target: inpaintTarget.trim(),
            positive: inpaintPositive.trim(),
            negative: inpaintNegative.trim() || undefined,
          });
          break;
        case "facedetailer":
          res = await generateFaceDetailer({ ...base, denoise: faceDenoise });
          break;
        case "qwenedit":
          if (!qwenPositive.trim() && !qwenCamera) {
            setProc((p) => ({ ...p, status: "error", error: "请填写编辑指令或选择相机角度" }));
            return;
          }
          res = await generateQwenEdit({
            ...base,
            positive: qwenPositive.trim(),
            camera: qwenCamera || undefined,
            fast: qwenSpeed === "fast",
          });
          break;
        case "camera3d":
          res = await generateQwenEdit({
            ...base,
            positive: cam3dNote.trim(),
            azimuth: cam3dAzimuth,
            elevation: cam3dElevation,
            distance: cam3dDistance,
            fast: cam3dSpeed === "fast",
          });
          break;
        case "hunyuan3d": {
          if (threedSteps < 10 || threedSteps > 100) {
            setProc((p) => ({ ...p, status: "error", error: "步数须在 10-100 之间" }));
            return;
          }
          const seedText = threedSeed.trim();
          const seed = seedText === "" ? null : Number(seedText);
          if (seed !== null && (!Number.isInteger(seed) || seed < 0)) {
            setProc((p) => ({ ...p, status: "error", error: "seed 须为非负整数(留空随机)" }));
            return;
          }
          // Hunyuan3D 只在持有该模型/节点的 worker 上跑:本地源图按 kind=hunyuan3d 重传,
          // 由上传路由钉到具备能力的 worker;作品库选取的图沿用转运后的句柄
          let target = base;
          if (source.file) {
            const up = await uploadImage(source.file, "hunyuan3d");
            target = { image: up.filename, worker: up.worker };
          }
          res = await generate3D({
            ...target,
            steps: threedSteps,
            cfg: 5.0,
            octree_resolution: threedOctree,
            seed,
          });
          break;
        }
        default:
          return;
      }
    } catch (e) {
      setProc((p) => ({
        ...p,
        status: "error",
        error: e instanceof Error ? e.message : "处理请求失败",
      }));
      return;
    }

    try {
      const paths = await trackJob(res, {
        label: TOOLS.find((t) => t.key === tool)?.title ?? "图像处理",
        signal: ac.signal,
        onProgress: (p) => {
          if (!mountedRef.current) return;
          setProc((prev) => ({ ...prev, progress: p }));
        },
        register: (es) => {
          esRef.current = es;
        },
      });
      if (!mountedRef.current) return;
      const first = paths[0];
      setProc((prev) => ({
        ...prev,
        status: "done",
        resultUrl: first ?? null,
        resultPaths: paths,
        progress: null,
      }));
      invalidateJobs();
    } catch (e) {
      if (!mountedRef.current) return;
      // 卸载/重新上传/重入触发的显式中止:静默——状态已由对应路径复位,
      // 不能按失败处理(error 态会让已取消的任务误标失败)
      if (e instanceof TrackJobAbortError) return;
      setProc((prev) => ({
        ...prev,
        status: "error",
        error: e instanceof Error ? e.message : "处理失败",
        progress: null,
      }));
    }
  }, [
    source,
    tool,
    proc.status,
    removeBgMode,
    upscaleScale,
    inpaintTarget,
    inpaintPositive,
    inpaintNegative,
    faceDenoise,
    qwenPositive,
    qwenCamera,
    qwenSpeed,
    cam3dAzimuth,
    cam3dElevation,
    cam3dDistance,
    cam3dNote,
    cam3dSpeed,
    cam3dOrbit,
    threedSteps,
    threedOctree,
    threedSeed,
    stopTracking,
  ]);

  const isRunning = proc.status === "running";
  // 环绕序列集齐 8 帧且完成:主预览区换 360° 旋转查看器(进行中/未集齐保持主图+胶片条)
  const orbitReady =
    proc.tool === "camera3d" &&
    cam3dOrbit &&
    proc.status === "done" &&
    proc.resultPaths.length === CAM3D_AZIMUTHS.length;

  /** 查看器/胶片条共用切帧:同步当前帧与主图路径(胶片高亮跟随)。 */
  const handleOrbitFrame = useCallback((i: number) => {
    setOrbitFrame(i);
    setProc((prev) => ({ ...prev, resultUrl: prev.resultPaths[i] ?? prev.resultUrl }));
  }, []);

  return (
    <div className="single-view ie-view">
      {/* 2026-08-18 页头移除(灵动岛已指示当前板块):「重新上传」收进工作区顶部窄行 */}
      {!source ? (
        <DropZone
          onUpload={handleUpload}
          onPickLibrary={() => setPickerOpen(true)}
          uploading={uploading}
          error={uploadError}
          onClearError={() => setUploadError(null)}
        />
      ) : (
        <>
          <div className="ie-actions">
            <Button variant="ghost" size="sm" icon={<Icon name="refresh" size={13} />} onClick={resetSource}>
              重新上传
            </Button>
          </div>
          <div className="ie-workspace">
          <aside className="ie-rail">
            <span className="ie-section-label">处理工具</span>
            <div className="ie-tools">
              {TOOLS.map((t) => (
                <ToolCard
                  key={t.key}
                  tool={t}
                  active={tool === t.key}
                  disabled={isRunning}
                  onSelect={() => setTool(t.key)}
                >
                  {t.key === "removebg" && (
                    <Field label="模式">
                      <Select value={removeBgMode} onChange={(e) => setRemoveBgMode(e.target.value)} disabled={isRunning}>
                        {REMOVE_BG_MODES.map((m) => (
                          <option key={m.value} value={m.value}>
                            {m.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  )}
                  {t.key === "upscale" && (
                    <Field label="放大倍数">
                      <Select
                        value={String(upscaleScale)}
                        onChange={(e) => setUpscaleScale(Number(e.target.value))}
                        disabled={isRunning}
                      >
                        {UPSCALE_SCALES.map((s) => (
                          <option key={s.value} value={s.value}>
                            {s.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  )}
                  {t.key === "inpaint" && (
                    <div className="ie-field-group">
                      <Field label="要修改的区域">
                        <Input
                          value={inpaintTarget}
                          onChange={(e) => setInpaintTarget(e.target.value)}
                          placeholder="例如：帽子、背景、衣服"
                          disabled={isRunning}
                        />
                      </Field>
                      <Field label="替换成">
                        <Input
                          value={inpaintPositive}
                          onChange={(e) => setInpaintPositive(e.target.value)}
                          placeholder="例如：红色贝雷帽、蓝天白云"
                          disabled={isRunning}
                        />
                      </Field>
                      <Field label="负向提示(可选)">
                        <Input
                          value={inpaintNegative}
                          onChange={(e) => setInpaintNegative(e.target.value)}
                          placeholder="不想出现的内容"
                          disabled={isRunning}
                        />
                      </Field>
                    </div>
                  )}
                  {t.key === "facedetailer" && (
                    <Field label={`修复强度 ${faceDenoise.toFixed(2)}`}>
                      <input
                        type="range"
                        min={0.3}
                        max={1.0}
                        step={0.05}
                        value={faceDenoise}
                        onChange={(e) => setFaceDenoise(Number(e.target.value))}
                        disabled={isRunning}
                        className="ie-slider"
                        aria-label="修复强度"
                      />
                    </Field>
                  )}
                  {t.key === "qwenedit" && (
                    <div className="ie-field-group">
                      <Field>
                        <div className="ie-field-head">
                          <span className="ie-field-label">编辑指令</span>
                          {/* AI 优化:中文修改意图 → 英文编辑指令(后端 kind=qwen_edit 指令方言,
                              不套画风/画质词方言;仅文本回填,不改其它参数) */}
                          <OptimizeButton
                            prompt={qwenPositive}
                            kind="qwen_edit"
                            onOptimized={(text) => setQwenPositive(text)}
                            disabled={isRunning}
                          />
                        </div>
                        <Input
                          value={qwenPositive}
                          onChange={(e) => setQwenPositive(e.target.value)}
                          placeholder="例如：把衣服换成红色、给人物戴上墨镜"
                          disabled={isRunning}
                        />
                      </Field>
                      <Field label="相机角度(可选)">
                        <Select value={qwenCamera} onChange={(e) => setQwenCamera(e.target.value)} disabled={isRunning}>
                          {QWEN_CAMERAS.map((cm) => (
                            <option key={cm.value} value={cm.value}>
                              {cm.label}
                            </option>
                          ))}
                        </Select>
                        {/* 评测实证(2026-08-24):主体/角色类旋转效果好;大场景风景超分布,可能无明显变化 */}
                        <p className="ie-tool-desc">人物/物品主体效果最佳;大场景风景的旋转可能不明显</p>
                      </Field>
                      <Field label="档位">
                        <Select value={qwenSpeed} onChange={(e) => setQwenSpeed(e.target.value)} disabled={isRunning}>
                          {QWEN_SPEEDS.map((s) => (
                            <option key={s.value} value={s.value}>
                              {s.label}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    </div>
                  )}

                  {t.key === "camera3d" && (
                    <div className="ie-field-group">
                      <Field label="方位(绕主体水平旋转)">
                        <div className="ie-cam3d-compass" role="radiogroup" aria-label="方位">
                          {CAM3D_AZIMUTHS.map((az) => (
                            <button
                              key={az.value}
                              type="button"
                              role="radio"
                              aria-checked={cam3dAzimuth === az.value}
                              className={`ie-cam3d-btn${cam3dAzimuth === az.value ? " is-active" : ""}`}
                              disabled={isRunning}
                              onClick={() => setCam3dAzimuth(az.value)}
                            >
                              {az.label}
                            </button>
                          ))}
                        </div>
                      </Field>
                      <Field label="俯仰">
                        <Select value={cam3dElevation} onChange={(e) => setCam3dElevation(Number(e.target.value))} disabled={isRunning}>
                          {CAM3D_ELEVATIONS.map((el) => (
                            <option key={el.value} value={el.value}>
                              {el.label}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="距离">
                        <Select value={cam3dDistance} onChange={(e) => setCam3dDistance(e.target.value)} disabled={isRunning}>
                          {CAM3D_DISTANCES.map((d) => (
                            <option key={d.value} value={d.value}>
                              {d.label}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field>
                        <div className="ie-field-head">
                          <span className="ie-field-label">附加指令(可选)</span>
                          {/* 与编辑指令同方言:附加指令同样进 generateQwenEdit 的 positive */}
                          <OptimizeButton
                            prompt={cam3dNote}
                            kind="qwen_edit"
                            onOptimized={(text) => setCam3dNote(text)}
                            disabled={isRunning}
                          />
                        </div>
                        <Input
                          value={cam3dNote}
                          onChange={(e) => setCam3dNote(e.target.value)}
                          placeholder="例如:保持白底、换成红色衣服"
                          disabled={isRunning}
                        />
                      </Field>
                      <Field label="档位">
                        <Select value={cam3dSpeed} onChange={(e) => setCam3dSpeed(e.target.value)} disabled={isRunning}>
                          {CAM3D_SPEEDS.map((s) => (
                            <option key={s.value} value={s.value}>
                              {s.label}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <label className="ie-cam3d-orbit">
                        <input
                          type="checkbox"
                          checked={cam3dOrbit}
                          onChange={(e) => setCam3dOrbit(e.target.checked)}
                          disabled={isRunning}
                        />
                        360° 环绕序列(8 个方位全部生成,约 2 分钟)
                      </label>
                      <p className="ie-tool-desc">人物/物品主体效果最佳;大场景风景的环绕可能不明显</p>
                    </div>
                  )}

                  {t.key === "hunyuan3d" && (
                    <div className="ie-field-group">
                      <Field label={`步数 ${threedSteps}(10-100)`}>
                        <input
                          type="range"
                          min={10}
                          max={100}
                          step={5}
                          value={threedSteps}
                          onChange={(e) => setThreedSteps(Number(e.target.value))}
                          disabled={isRunning}
                          className="ie-slider"
                          aria-label="步数"
                        />
                      </Field>
                      <Field label="Octree 分辨率">
                        <Select
                          value={String(threedOctree)}
                          onChange={(e) => setThreedOctree(Number(e.target.value))}
                          disabled={isRunning}
                        >
                          {THREED_OCTREES.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="Seed(可选,留空随机)">
                        <Input
                          value={threedSeed}
                          onChange={(e) => setThreedSeed(e.target.value)}
                          placeholder="非负整数,留空随机"
                          inputMode="numeric"
                          disabled={isRunning}
                        />
                      </Field>
                      <p className="ie-tool-desc">单一居中主体、干净背景的图效果最佳;输出 GLB 网格文件</p>
                    </div>
                  )}

                  <div className="ie-tool-run">
                    <Button
                      variant="primary"
                      loading={isRunning && proc.tool === t.key}
                      disabled={isRunning}
                      icon={isRunning && proc.tool === t.key ? undefined : <Icon name="wand" size={14} />}
                      onClick={() => void runTool()}
                    >
                      {isRunning && proc.tool === t.key ? "处理中…" : t.runLabel}
                    </Button>
                    {isRunning && proc.tool === t.key && proc.progress && (
                      <ProgressBar progress={proc.progress} />
                    )}
                    {proc.status === "error" && proc.tool === t.key && (
                      <ErrorBar
                        className="ie-error"
                        message={proc.error}
                        onClose={() => setProc((p) => ({ ...p, error: null }))}
                      />
                    )}
                  </div>
                </ToolCard>
              ))}
            </div>

            {proc.status === "done" && (
              <div className="ie-done-tip">
                <Icon name="success" size={16} />
                <span>处理完成，结果已自动保存到作品库</span>
              </div>
            )}
          </aside>

          <div className="ie-canvas">
            <span className="ie-section-label">画布</span>
            <SourcePreview image={source} />
            {/* 多结果(360° 环绕序列)胶片条:逐张落地即追加,点击切主图/查看器当前帧(GLB 产物非图片,不进胶片条) */}
            {proc.resultPaths.length > 1 && proc.tool !== "hunyuan3d" && (
              <div className="ie-strip" role="listbox" aria-label="环绕序列">
                {proc.resultPaths.map((p, i) => (
                  <button
                    key={p}
                    type="button"
                    className={`ie-strip-item${proc.resultUrl === p ? " is-active" : ""}`}
                    onClick={() => handleOrbitFrame(i)}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={imageUrl(p)} alt={`视角 ${i + 1}`} loading="lazy" decoding="async" />
                  </button>
                ))}
              </div>
            )}
            {proc.resultUrl && proc.tool === "hunyuan3d" ? (
              <Model3DResult resultUrl={proc.resultUrl} />
            ) : orbitReady ? (
              <OrbitViewer frames={proc.resultPaths} frame={orbitFrame} onFrame={handleOrbitFrame} />
            ) : (
              proc.resultUrl && (
                <ResultPanel source={source} resultUrl={proc.resultUrl} resultPaths={proc.resultPaths} />
              )
            )}
          </div>
          </div>
        </>
      )}

      {/* 作品库选图(二次创作):转运产物到目标 worker 的 input,句柄直接灌 source */}
      <AssetPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        assetType="image"
        kind="img2img"
        onPick={handlePickLibrary}
      />

      {/* DropZone/ToolCard 等子组件在主组件之外定义,styled-jsx 作用域属性不会传递,必须用 global(ie- 前缀类名全项目唯一) */}
      <style jsx global>{`
        .ie-view {
          display: flex;
          flex-direction: column;
          gap: var(--space-8);
        }
        .ie-header-text {
          display: flex;
          flex-direction: column;
        }
        .ie-section-label {
          font-size: var(--text-label);
          font-weight: var(--font-medium);
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: var(--text-muted);
        }

        /* ── 拖拽上传区 ── */
        .ie-dropzone-wrap {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: var(--space-4);
        }
        .ie-dropzone {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: var(--space-3);
          width: 100%;
          max-width: 760px;
          min-height: 320px;
          padding: var(--space-12) var(--space-8);
          background: var(--bg-surface-1);
          border: 2px dashed var(--border-subtle);
          border-radius: var(--radius-panel);
          color: var(--text-primary);
          cursor: pointer;
          transition: border-color var(--duration-fast) var(--ease-standard),
            background-color var(--duration-fast) var(--ease-standard),
            box-shadow var(--duration-fast) var(--ease-standard);
        }
        .ie-dropzone:hover:not(:disabled),
        .ie-dropzone.is-dragover {
          border-color: var(--accent);
          background: var(--accent-soft);
          box-shadow: var(--shadow-md);
        }
        .ie-dropzone:disabled {
          opacity: 0.6;
          cursor: wait;
        }
        .ie-dropzone-icon {
          color: var(--text-muted);
          display: flex;
          margin-bottom: var(--space-2);
        }
        .ie-dropzone.is-dragover .ie-dropzone-icon,
        .ie-dropzone:hover:not(:disabled) .ie-dropzone-icon {
          color: var(--accent);
        }
        .ie-dropzone-title {
          font-size: var(--text-lg);
          font-weight: var(--font-semibold);
        }
        .ie-dropzone-desc {
          font-size: var(--text-aux);
          color: var(--text-muted);
        }
        .ie-dropzone-wrap .ie-error {
          width: 100%;
          max-width: 760px;
        }
        @media (max-width: 767px) {
          .ie-dropzone {
            min-height: 240px;
            padding: var(--space-10) var(--space-5);
          }
        }

        /* ── 工作区布局:左侧工具栏(340px 吸附) + 右侧画布 ── */
        .ie-actions {
          display: flex;
          justify-content: flex-end;
        }
        .ie-workspace {
          display: flex;
          gap: var(--space-8);
          align-items: flex-start;
        }
        .ie-rail {
          width: 340px;
          flex-shrink: 0;
          display: flex;
          flex-direction: column;
          gap: var(--space-4);
          position: sticky;
          top: var(--space-6);
        }
        .ie-canvas {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: var(--space-4);
        }
        .ie-canvas .ie-preview-card,
        .ie-canvas .ie-result-card {
          margin-top: var(--space-2);
        }
        @media (max-width: 1023px) {
          .ie-workspace {
            flex-direction: column;
            gap: var(--space-6);
          }
          .ie-rail {
            width: 100%;
            position: static;
            order: 2;
          }
          .ie-canvas {
            order: 1;
            width: 100%;
          }
        }

        /* ── 预览卡片 ── */
        .card.ie-preview-card {
          padding: var(--space-6);
          gap: var(--space-4);
        }
        .ie-preview-card {
          display: flex;
          flex-direction: column;
        }
        .ie-preview-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .ie-preview-label {
          font-size: var(--text-label);
          font-weight: var(--font-medium);
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: var(--text-muted);
        }
        .ie-preview-media {
          display: flex;
          justify-content: center;
          background: var(--bg-canvas);
          border-radius: var(--radius-control);
          overflow: hidden;
        }
        .ie-preview-img {
          max-width: 100%;
          max-height: 480px;
          object-fit: contain;
          display: block;
        }
        .ie-preview-name {
          font-size: var(--text-aux);
          color: var(--text-muted);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          margin: 0;
        }

        /* ── 工具面板(卡片基底由共享 .at-card 承载,此处保留布局与选中态)── */
        .ie-tools {
          display: flex;
          flex-direction: column;
          gap: var(--space-4);
        }
        .ie-tool-card {
          overflow: hidden;
        }
        .ie-tool-card:hover {
          border-color: var(--border-strong);
          box-shadow: var(--shadow-lift);
          transform: translateY(-2px);
        }
        .ie-tool-card.is-active {
          border-color: var(--accent);
          box-shadow: var(--shadow-md);
        }
        .ie-tool-head {
          display: flex;
          align-items: center;
          gap: var(--space-3);
          width: 100%;
          min-height: 68px;
          padding: var(--space-4) var(--space-5);
          background: transparent;
          border: none;
          color: var(--text-primary);
          cursor: pointer;
          text-align: left;
          transition: background-color var(--duration-fast) var(--ease-standard);
        }
        .ie-tool-head:hover:not(:disabled) {
          background: var(--bg-surface-2);
        }
        .ie-tool-head:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .ie-tool-icon {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 40px;
          height: 40px;
          border-radius: var(--radius-control);
          background: var(--bg-surface-3);
          color: var(--text-secondary);
          flex-shrink: 0;
        }
        .ie-tool-card.is-active .ie-tool-icon {
          background: var(--accent-soft);
          color: var(--accent);
        }
        .ie-tool-text {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: var(--space-1);
        }
        .ie-tool-title {
          font-size: var(--text-md);
          font-weight: var(--font-semibold);
        }
        .ie-tool-desc {
          font-size: var(--text-aux);
          color: var(--text-muted);
        }
        .ie-tool-chevron {
          color: var(--text-muted);
          flex-shrink: 0;
        }
        .ie-tool-body {
          display: flex;
          flex-direction: column;
          gap: var(--space-4);
          padding: var(--space-4) var(--space-5) var(--space-5);
          border-top: 1px solid var(--border-subtle);
        }
        .ie-field-group {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
          padding: var(--space-3);
          background: var(--bg-surface-2);
          border-radius: var(--radius-control);
        }
        /* 字段头:标签 + 优化提示词按钮同行(对齐 ui/Field 的 ui-field-label 视觉) */
        .ie-field-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-2);
        }
        .ie-field-label {
          font-size: var(--text-label);
          font-weight: var(--font-medium);
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: var(--text-muted);
        }
        .ie-tool-run {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
          padding-top: var(--space-4);
          border-top: 1px dashed var(--border-subtle);
        }

        /* ── 滑杆 ── */
        .ie-slider {
          width: 100%;
          height: 6px;
          -webkit-appearance: none;
          appearance: none;
          background: var(--bg-surface-3);
          border-radius: var(--radius-full);
          outline: none;
          cursor: pointer;
        }
        .ie-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: var(--accent);
          cursor: pointer;
          transition: transform var(--duration-fast) var(--ease-standard);
        }
        .ie-slider::-webkit-slider-thumb:hover {
          transform: scale(1.1);
        }
        .ie-slider::-moz-range-thumb {
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: var(--accent);
          cursor: pointer;
          border: none;
        }
        .ie-slider:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .ie-slider:focus-visible {
          outline: 1px solid var(--accent);
          outline-offset: 4px;
        }

        /* ── 进度条 ── */
        .ie-progress {
          display: flex;
          align-items: center;
          gap: var(--space-3);
        }
        .ie-progress-track {
          flex: 1;
          height: 4px;
          background: var(--bg-surface-3);
          border-radius: var(--radius-full);
          overflow: hidden;
        }
        .ie-progress-fill {
          height: 100%;
          background: var(--accent);
          border-radius: var(--radius-full);
          transition: width var(--duration-fast) var(--ease-standard);
        }
        .ie-progress-text {
          font-size: var(--text-aux);
          color: var(--text-secondary);
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
        }

        /* ── 结果卡片 ── */
        .card.ie-result-card {
          padding: var(--space-6);
          gap: var(--space-4);
        }
        .ie-result-card {
          display: flex;
          flex-direction: column;
        }
        .ie-result-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: var(--space-2);
        }
        .ie-result-label {
          font-size: var(--text-label);
          font-weight: var(--font-medium);
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: var(--text-muted);
        }
        .ie-result-actions {
          display: flex;
          align-items: center;
          gap: var(--space-2);
        }
        /* 结果/对比切换:共享 .at-seg 墨丸段控,此处仅保留布局钩子;
           下载主钮共享 .at-btn--primary,对齐段控高度的紧凑规格 */
        .ie-download-btn {
          min-height: 30px;
          padding: 0 var(--space-3);
          font-size: var(--text-aux);
        }
        @media (max-width: 767px) {
          /* 移动端触控目标 ≥44px */
          .ie-toggle-btn {
            min-height: 44px;
            padding: var(--space-1) var(--space-4);
          }
          .ie-download-btn {
            min-height: 44px;
          }
        }
        .ie-result-media {
          display: flex;
          justify-content: center;
          background: var(--bg-canvas);
          border-radius: var(--radius-control);
          overflow: hidden;
        }
        .ie-result-img {
          max-width: 100%;
          max-height: 520px;
          object-fit: contain;
          display: block;
        }
        .ie-compare-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: var(--space-4);
        }
        @media (max-width: 767px) {
          .ie-compare-grid {
            grid-template-columns: 1fr;
          }
        }
        .ie-compare-col {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
        }
        .ie-compare-tag {
          font-size: var(--text-xs);
          font-weight: var(--font-medium);
          color: var(--text-muted);
          text-align: center;
        }
        .ie-compare-tag.is-result {
          color: var(--accent);
        }
        .ie-compare-media {
          display: flex;
          justify-content: center;
          background: var(--bg-canvas);
          border-radius: var(--radius-control);
          overflow: hidden;
        }
        .ie-compare-img {
          max-width: 100%;
          max-height: 320px;
          object-fit: contain;
          display: block;
        }
        .ie-result-note {
          font-size: var(--text-aux);
          color: var(--text-muted);
          margin: 0;
        }

        /* ── 3D 模型结果卡(内联 model-viewer 预览 + 图标+文件名+下载) ── */
        .ie-model3d-viewer {
          height: 320px;
          margin-bottom: var(--space-3);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          overflow: hidden;
        }
        .ie-model3d-body {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: var(--space-2);
          padding: var(--space-8) var(--space-4);
          background: var(--bg-canvas);
          border-radius: var(--radius-control);
          color: var(--text-muted);
        }
        .ie-model3d-name {
          font-size: var(--text-md);
          font-weight: var(--font-medium);
          color: var(--text-primary);
          max-width: 100%;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .ie-model3d-hint {
          font-size: var(--text-aux);
          text-align: center;
        }
        /* 结果卡头部操作组(材质烘焙 + 下载) */
        .ie-model3d-actions {
          display: flex;
          align-items: center;
          gap: var(--space-2);
        }
        .ie-model3d-preset {
          padding: 5px 6px;
          font-size: var(--text-aux);
          color: var(--text-primary);
          background: var(--bg-surface-2);
          border: 1px solid var(--border-subtle);
          border-radius: 8px;
        }
        .ie-model3d-bake-btn {
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        .ie-model3d-bake-btn:disabled {
          opacity: 0.6;
          cursor: wait;
        }

        /* ── 3D 相机:方位罗盘 + 环绕胶片条 ── */
        .ie-cam3d-compass {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: var(--space-2);
        }
        .ie-cam3d-btn {
          padding: var(--space-2) var(--space-1);
          font-size: var(--text-aux);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          background: var(--bg-surface-2);
          color: var(--text-secondary);
          cursor: pointer;
          transition: border-color 0.15s, color 0.15s, background 0.15s;
        }
        .ie-cam3d-btn:hover:not(:disabled) {
          border-color: var(--accent);
          color: var(--text-primary);
        }
        .ie-cam3d-btn.is-active {
          border-color: var(--accent);
          background: var(--accent-soft);
          color: var(--accent);
          font-weight: 600;
        }
        .ie-cam3d-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .ie-cam3d-orbit {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          font-size: var(--text-aux);
          color: var(--text-secondary);
          cursor: pointer;
        }
        .ie-strip {
          display: flex;
          gap: var(--space-2);
          overflow-x: auto;
          padding: var(--space-1) 0;
        }
        .ie-strip-item {
          flex: 0 0 auto;
          width: 96px;
          border: 2px solid var(--border-subtle);
          border-radius: var(--radius-control);
          overflow: hidden;
          padding: 0;
          background: var(--bg-surface-2);
          cursor: pointer;
        }
        .ie-strip-item.is-active {
          border-color: var(--accent);
        }
        .ie-strip-item img {
          width: 100%;
          height: auto;
          display: block;
        }

        /* ── 错误 / 完成提示 ── */
        .ie-error {
          font-size: var(--text-aux);
          color: var(--err);
          background: var(--err-soft);
          padding: var(--space-2) var(--space-3);
          border-radius: var(--radius-control);
          overflow-wrap: break-word;
          margin: 0;
        }
        .ie-done-tip {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          padding: var(--space-3);
          background: var(--ok-soft);
          border-radius: var(--radius-control);
          font-size: var(--text-aux);
          color: var(--ok);
        }
      `}</style>
    </div>
  );
}
