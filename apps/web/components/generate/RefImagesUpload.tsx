"use client";

import { useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Field } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { uploadImage } from "@/lib/api";
import type { EngineParam } from "@/lib/engines";

import type { UploadedRef } from "./RefImageUpload";

// 上传校验:后端 /api/upload 上限 20MB;扩展名白名单与单图上传一致
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_EXT_OK = ["jpg", "jpeg", "png", "webp"];

function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

interface RefImagesUploadProps {
  param: EngineParam;
  values: UploadedRef[];
  onChange: (v: UploadedRef[]) => void;
  /** 上传路由 kind(wan_vace 等,决定后端接收校验与落点)。 */
  uploadKind: string;
  disabled?: boolean;
}

/**
 * 多参考图上传(images 类型 max>1,如 VACE 1-4 张):
 * 客户端校验(20MB / 扩展名)→ /api/upload;首张自由落点,后续钉首张所在 worker
 * (提交时后端从同一 worker 转运到专用实例,跨机取不到文件)。
 */
export function RefImagesUpload({ param, values, onChange, uploadKind, disabled }: RefImagesUploadProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const toast = useToast();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const max = param.max ?? 4;
  // 首张已上传图的 worker 为后续图的钉点;全部移除后恢复自由落点
  const pinWorker = values[0]?.worker ?? null;

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (values.length >= max) {
      setError(`参考图最多 ${max} 张`);
      return;
    }
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
      const r = await uploadImage(file, uploadKind, false, pinWorker ?? undefined);
      onChange([
        ...values,
        {
          filename: r.filename,
          worker: r.worker,
          previewUrl: URL.createObjectURL(file),
          name: file.name,
        },
      ]);
      // 成功显式反馈(原静默入列);失败仍走内联 setError
      toast.success(`参考图已上传(${values.length + 1}/${max})`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "上传失败");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  const removeAt = (idx: number) => onChange(values.filter((_, i) => i !== idx));

  return (
    <Field
      label={`${param.label}(${values.length}/${max})`}
      hint={error ? undefined : param.hint}
      error={error ?? undefined}
    >
      <div className="ref-images-grid">
        {values.map((v, i) => (
          <div key={v.filename} className="ref-images-item">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={v.previewUrl}
              alt={v.name}
              className="ref-images-thumb"
              title={v.name}
              loading="lazy"
              decoding="async"
            />
            <button
              type="button"
              className="ref-images-remove"
              aria-label={`移除参考图 ${i + 1}`}
              disabled={disabled}
              onClick={() => removeAt(i)}
            >
              <Icon name="close" size={11} />
            </button>
          </div>
        ))}
        {values.length < max && (
          <Button
            variant="secondary"
            size="sm"
            loading={uploading}
            icon={<Icon name="upload" size={14} />}
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            {uploading ? "上传中…" : values.length === 0 ? "上传参考图" : "再加一张"}
          </Button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".jpg,.jpeg,.png,.webp"
        style={{ display: "none" }}
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
      <style jsx>{`
        .ref-images-grid {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: var(--space-2);
        }
        .ref-images-item {
          position: relative;
          width: 48px;
          height: 48px;
          flex-shrink: 0;
        }
        .ref-images-thumb {
          width: 48px;
          height: 48px;
          object-fit: cover;
          border-radius: var(--radius-sm);
          border: 1px solid var(--border-subtle);
          display: block;
        }
        .ref-images-remove {
          position: absolute;
          top: -6px;
          right: -6px;
          width: 16px;
          height: 16px;
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
        .ref-images-remove:hover {
          color: var(--text-primary);
        }
      `}</style>
    </Field>
  );
}
