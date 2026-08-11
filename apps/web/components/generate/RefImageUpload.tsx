"use client";

import { useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Field } from "@/components/ui/Input";
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
  disabled?: boolean;
}

/** 参考图上传:客户端校验(20MB / 扩展名)→ /api/upload → 缩略预览,可移除重传。 */
export function RefImageUpload({ param, value, onChange, uploadKind, disabled }: RefImageUploadProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    try {
      const r = await uploadImage(file, uploadKind);
      onChange({
        filename: r.filename,
        worker: r.worker,
        previewUrl: URL.createObjectURL(file),
        name: file.name,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "上传失败");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <Field label={param.label} hint={error ? undefined : param.hint} error={error ?? undefined}>
      {value ? (
        <div className="ref-image-preview">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={value.previewUrl} alt={value.name} className="ref-image-thumb" />
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
          border-radius: var(--radius-sm);
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
      `}</style>
    </Field>
  );
}
