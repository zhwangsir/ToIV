"use client";

import { useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Field } from "@/components/ui/Input";
import { uploadImage } from "@/lib/api";
import type { EngineParam, RefImageHandle } from "@/lib/engines";

/** 已上传驱动音频(服务端句柄 + 本地文件名)。 */
export interface UploadedAudio extends RefImageHandle {
  name: string;
}

// 上传校验:后端 /api/upload 上限 20MB;扩展名白名单与引擎注册表 _audio() 提示一致
const AUDIO_MAX_BYTES = 20 * 1024 * 1024;
const AUDIO_EXT_OK = ["wav", "mp3", "m4a", "ogg", "flac"];

function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

interface RefAudioUploadProps {
  param: EngineParam;
  value: UploadedAudio | null;
  onChange: (v: UploadedAudio | null) => void;
  /** 上传路由 kind(决定后端把音频放到具备对口型模型的 worker)。 */
  uploadKind: string;
  /** 钉到指定 worker(与参考图同机,避免多机路径不一致)。 */
  pinWorker?: string | null;
  disabled?: boolean;
}

/** 驱动音频上传:客户端校验(20MB / 扩展名)→ /api/upload(钉参考图所在 worker)→ 可移除重传。 */
export function RefAudioUpload({ param, value, onChange, uploadKind, pinWorker, disabled }: RefAudioUploadProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (!AUDIO_EXT_OK.includes(fileExt(file.name))) {
      setError("仅支持 wav / mp3 / m4a / ogg / flac 音频");
      return;
    }
    if (file.size > AUDIO_MAX_BYTES) {
      setError("音频超过 20MB 上限");
      return;
    }
    setUploading(true);
    try {
      const r = await uploadImage(file, uploadKind, false, pinWorker ?? undefined);
      onChange({ filename: r.filename, worker: r.worker, name: file.name });
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
        <div className="ref-audio-preview">
          <Icon name="audio" size={16} />
          <span className="ref-audio-name" title={value.name}>
            {value.name}
          </span>
          <Button
            variant="ghost"
            size="sm"
            icon={<Icon name="close" size={13} />}
            aria-label="移除驱动音频"
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
          {uploading ? "上传中…" : "上传音频"}
        </Button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept=".wav,.mp3,.m4a,.ogg,.flac"
        style={{ display: "none" }}
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
      <style jsx>{`
        .ref-audio-preview {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          padding: var(--space-2);
          background: var(--bg-surface-3);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          color: var(--text-secondary);
        }
        .ref-audio-name {
          flex: 1;
          min-width: 0;
          font-size: var(--text-aux);
          color: var(--text-secondary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .ref-audio-preview :global(button) {
          flex-shrink: 0;
        }
      `}</style>
    </Field>
  );
}
