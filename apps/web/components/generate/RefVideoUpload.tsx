"use client";

import { useRef, useState } from "react";

import { AssetPicker } from "@/components/generate/AssetPicker";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Field } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { uploadImage } from "@/lib/api";
import type { EngineParam, RefImageHandle } from "@/lib/engines";

/** 已上传驱动视频(服务端句柄 + 本地文件名)。 */
export interface UploadedVideo extends RefImageHandle {
  name: string;
}

// 上传校验:后端 /api/upload 视频类上限 200MB;扩展名与引擎注册表 video 参数提示一致
const VIDEO_MAX_BYTES = 200 * 1024 * 1024;
const VIDEO_EXT_OK = ["mp4", "mov", "webm"];

function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

interface RefVideoUploadProps {
  param: EngineParam;
  value: UploadedVideo | null;
  onChange: (v: UploadedVideo | null) => void;
  /** 上传路由 kind(wan_animate 等,决定后端接收校验与落点)。 */
  uploadKind: string;
  /** 钉到指定 worker(与参考图同机,提交时后端从该 worker 转运到专用实例)。 */
  pinWorker?: string | null;
  disabled?: boolean;
}

/** 驱动视频上传:客户端校验(200MB / 扩展名)→ /api/upload(钉参考图所在 worker)→ 可移除重传。 */
export function RefVideoUpload({ param, value, onChange, uploadKind, pinWorker, disabled }: RefVideoUploadProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const toast = useToast();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  async function onFile(file: File | undefined) {
    if (!file) return;
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
      const r = await uploadImage(file, uploadKind, false, pinWorker ?? undefined);
      onChange({ filename: r.filename, worker: r.worker, name: file.name });
      // 成功显式反馈(原静默入列);失败仍走内联 setError
      toast.success("驱动视频已上传");
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
        <div className="ref-video-preview">
          <Icon name="video" size={16} />
          <span className="ref-video-name" title={value.name}>
            {value.name}
          </span>
          <Button
            variant="ghost"
            size="sm"
            icon={<Icon name="close" size={13} />}
            aria-label="移除驱动视频"
            disabled={disabled}
            onClick={() => onChange(null)}
          />
        </div>
      ) : (
        <div className="ref-video-actions">
          <Button
            variant="secondary"
            size="sm"
            loading={uploading}
            icon={<Icon name="upload" size={14} />}
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            {uploading ? "上传中…" : "上传视频"}
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
      <AssetPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        assetType="video"
        kind={uploadKind}
        pinWorker={pinWorker}
        onPick={(a) => onChange({ filename: a.filename, worker: a.worker, name: a.name })}
      />
      <input
        ref={inputRef}
        type="file"
        accept=".mp4,.mov,.webm"
        style={{ display: "none" }}
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
      <style jsx>{`
        .ref-video-preview {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          padding: var(--space-2);
          background: var(--bg-surface-3);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          color: var(--text-secondary);
        }
        .ref-video-name {
          flex: 1;
          min-width: 0;
          font-size: var(--text-aux);
          color: var(--text-secondary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .ref-video-preview :global(button) {
          flex-shrink: 0;
        }
        .ref-video-actions {
          display: flex;
          gap: var(--space-2);
          flex-wrap: wrap;
        }
      `}</style>
    </Field>
  );
}
