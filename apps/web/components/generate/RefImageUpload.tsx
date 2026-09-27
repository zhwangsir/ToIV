"use client";

import { useEffect, useRef, useState } from "react";

import { AssetPicker } from "@/components/generate/AssetPicker";
import { InpaintMaskPainter } from "@/components/generate/InpaintMaskPainter";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Field } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { uploadImage } from "@/lib/api";
import type { EngineParam, RefImageHandle } from "@/lib/engines";

/** 已上传参考图(服务端句柄 + 本地预览)。 */
export interface UploadedRef extends RefImageHandle {
  previewUrl: string;
  name: string;
}

// 上传校验:后端 /api/upload 上限 20MB;扩展名白名单与旧创作页一致
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_EXT_OK = ["jpg", "jpeg", "png", "webp"];

function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

interface RefImageUploadProps {
  param: EngineParam;
  value: UploadedRef | null;
  onChange: (v: UploadedRef | null) => void;
  /** 上传路由 kind(img2img / ltx_i2v),决定后端把图放到哪类 worker。 */
  uploadKind: string;
  /** 钉到指定 worker(与首帧/其它参考同机,提交时后端从该 worker 转运)。 */
  pinWorker?: string | null;
  disabled?: boolean;
  /** 局部重绘槽(工作流消费该图的 MASK):上传后可直接在图上涂抹重绘区域。 */
  maskable?: boolean;
}

/** 参考图上传:客户端校验(20MB / 扩展名)→ /api/upload → 缩略预览,可移除重传。 */
export function RefImageUpload({ param, value, onChange, uploadKind, pinWorker, disabled, maskable }: RefImageUploadProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const toast = useToast();
  const [uploading, setUploading] = useState(false);
  /** 上传进度 0-100(XHR upload.onprogress;2026-08-30 P1-4);null=未在上传。 */
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  /** 未涂抹的原图(遮罩槽重复涂抹时 RGB 取它);masked = 当前表单值已是涂好遮罩的图。 */
  const [source, setSource] = useState<{ url: string; name: string } | null>(null);
  const [masked, setMasked] = useState(false);
  const [painterOpen, setPainterOpen] = useState(false);

  // 表单值被清空/外部替换 → 原图记录作废
  useEffect(() => {
    if (!value) {
      setSource(null);
      setMasked(false);
    }
  }, [value]);

  const painterSource = source ?? (value ? { url: value.previewUrl, name: value.name } : null);

  function takeNewImage(ref: UploadedRef) {
    onChange(ref);
    setSource({ url: ref.previewUrl, name: ref.name });
    setMasked(false);
    if (maskable) setPainterOpen(true);
  }

  async function applyMask(file: File) {
    const r = await uploadImage(file, uploadKind, false, pinWorker ?? value?.worker ?? undefined);
    onChange({
      filename: r.filename,
      worker: r.worker,
      previewUrl: URL.createObjectURL(file),
      name: file.name,
    });
    setMasked(true);
    toast.success("重绘区域已保存");
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
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
    setProgress(0);
    try {
      const r = await uploadImage(file, uploadKind, false, pinWorker ?? undefined, {
        onProgress: (pct) => setProgress(pct),
      });
      takeNewImage({
        filename: r.filename,
        worker: r.worker,
        previewUrl: URL.createObjectURL(file),
        name: file.name,
      });
      // 成功显式反馈(原静默入列,弱网下用户无法确认已传上);失败仍走内联 setError
      toast.success("参考图已上传");
    } catch (e) {
      setError(e instanceof Error ? e.message : "上传失败");
    } finally {
      setUploading(false);
      setProgress(null);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <Field label={param.label} hint={error ? undefined : param.hint} error={error ?? undefined}>
      {value ? (
        <div className="ref-image-preview">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={value.previewUrl}
            alt={value.name}
            className="ref-image-thumb"
            loading="lazy"
            decoding="async"
          />
          <span className="ref-image-name" title={value.name}>
            {value.name}
          </span>
          <Button
            variant="ghost"
            size="sm"
            icon={<Icon name="close" size={13} />}
            aria-label="移除参考图"
            disabled={disabled}
            onClick={() => onChange(null)}
          />
        </div>
      ) : (
        <div className="ref-image-actions">
          <Button
            variant="secondary"
            size="sm"
            loading={uploading}
            icon={<Icon name="upload" size={14} />}
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            {uploading ? "上传中…" : "上传参考图"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<Icon name="library" size={14} />}
            disabled={disabled}
            onClick={() => setPickerOpen(true)}
          >
            从作品库选
          </Button>
        </div>
      )}
      {maskable && value && (
        <div className="ref-mask-row">
          <Button
            variant={masked ? "ghost" : "secondary"}
            size="sm"
            icon={<Icon name="brush" size={13} />}
            disabled={disabled || !painterSource}
            onClick={() => setPainterOpen(true)}
          >
            {masked ? "修改重绘区域" : "涂抹重绘区域"}
          </Button>
          <span className="ref-mask-state" data-done={masked ? "1" : undefined}>
            {masked ? "已涂好，透明处会被重绘" : "还没涂抹：这张卡需要标出要改的地方"}
          </span>
        </div>
      )}
      {maskable && !value && <p className="ref-mask-tip">上传后可直接在图上涂出要重绘的区域</p>}
      {/* 上传进度条(2026-08-30 P1-4):XHR upload.onprogress 真实进度,大图不再盲等 */}
      {uploading && progress !== null && (
        <div
          className="ref-image-progress ui-progress-block"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          aria-label="上传进度"
        >
          <div className="ui-progress-meta">
            <span className="ui-progress-label">上传中</span>
            <span className="ui-progress-pct">{progress}%</span>
          </div>
          <div className="ui-progress" data-state="running">
            <div className="ref-image-progress-fill ui-progress-fill" style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}
      <AssetPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        assetType="image"
        kind={uploadKind}
        pinWorker={pinWorker}
        onPick={(a) => takeNewImage({ ...a })}
      />
      {maskable && painterSource && (
        <InpaintMaskPainter
          open={painterOpen}
          onClose={() => setPainterOpen(false)}
          sourceUrl={painterSource.url}
          sourceName={painterSource.name}
          maskUrl={masked && value ? value.previewUrl : null}
          onApply={applyMask}
        />
      )}
      <input
        ref={inputRef}
        type="file"
        accept=".jpg,.jpeg,.png,.webp"
        style={{ display: "none" }}
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
      <style jsx>{`
        .ref-image-preview {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          padding: var(--space-2);
          background: var(--bg-surface-3);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
        }
        .ref-image-thumb {
          width: 40px;
          height: 40px;
          object-fit: cover;
          border-radius: var(--radius-badge);
          flex-shrink: 0;
        }
        .ref-image-name {
          flex: 1;
          min-width: 0;
          font-size: var(--text-aux);
          color: var(--text-secondary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .ref-image-preview :global(button) {
          flex-shrink: 0;
        }
        .ref-image-actions {
          display: flex;
          gap: var(--space-2);
          flex-wrap: wrap;
        }
        .ref-mask-row {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          margin-top: var(--space-2);
          flex-wrap: wrap;
        }
        .ref-mask-state {
          font-size: var(--text-aux);
          color: var(--warn, var(--text-muted));
        }
        .ref-mask-state[data-done] {
          color: var(--text-muted);
        }
        .ref-mask-tip {
          margin: var(--space-1, 4px) 0 0;
          font-size: var(--text-aux);
          color: var(--text-muted);
        }
        /* 上传进度条:accent 软底填充 + 居中百分比(与任务中心条同语言) */
        .ref-image-progress {
          margin-top: var(--space-2);
        }
      `}</style>
    </Field>
  );
}
