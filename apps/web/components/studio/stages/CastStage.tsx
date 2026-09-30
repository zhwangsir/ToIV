"use client";

import { useRef, useState, type TextareaHTMLAttributes } from "react";
import {
  addStudioCharacter,
  deleteStudioCharacter,
  imageUrl,
  patchStudioCharacter,
  uploadImage,
  type StudioCharacter,
} from "@/lib/api";
import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { Input, Textarea } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { useAutoResize } from "@/hooks/useAutoResize";
import type { useStudioProject } from "@/hooks/useStudioProject";

/**
 * ② 角色阶段:角色卡 CRUD(跨镜一致性锚点)+ Batch2 三视图参考槽(正/侧/全身)。
 * 内联编辑失焦即存;voice_ref_url M4 只读展示,参考音上传后续扩展。
 */

/** 三视图槽位标签(对齐 H3 林夏定妆:正/侧/全身)。 */
const REF_SLOTS = [
  { key: 0, label: "正" },
  { key: 1, label: "侧" },
  { key: 2, label: "全身" },
] as const;

const IMAGE_EXT_OK = ["jpg", "jpeg", "png", "webp"];
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** 上传句柄 → 可回显的 /api/images?… URL(type=input)。 */
function uploadToRefUrl(filename: string, worker: string): string {
  const qs = new URLSearchParams({
    filename,
    type: "input",
    worker,
  });
  return `/api/images?${qs.toString()}`;
}

/**
 * 角色卡描述框(非受控 defaultValue + onBlur 落库):自动增高包装,
 * 初始按已有内容撑开,键入由 hook 的 input 监听即时重算。
 * 基座走 ui/Textarea(统一 .input 样式与 ref 透传)。
 */
function CastTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useAutoResize(ref, String(props.defaultValue ?? ""));
  return <Textarea {...props} ref={ref} />;
}

function RefSlots({
  character,
  onPatch,
  disabled,
}: {
  character: StudioCharacter;
  onPatch: (refs: string[]) => Promise<void>;
  disabled?: boolean;
}) {
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const [uploading, setUploading] = useState<number | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const refs = [...(character.reference_images || [])];
  while (refs.length < 3) refs.push("");

  const setSlot = async (idx: number, url: string | null) => {
    // 固定 3 槽位序(正/侧/全身),空槽用 "" 占位以免错位
    const next = [refs[0] || "", refs[1] || "", refs[2] || ""];
    next[idx] = url ?? "";
    await onPatch(next);
  };

  const onFile = async (idx: number, file: File | undefined) => {
    if (!file) return;
    setLocalError(null);
    if (!IMAGE_EXT_OK.includes(fileExt(file.name))) {
      setLocalError("仅支持 jpg / png / webp");
      return;
    }
    if (file.size > IMAGE_MAX_BYTES) {
      setLocalError("图片超过 20MB 上限");
      return;
    }
    setUploading(idx);
    try {
      // allWorkers=true:角色参考图分发全 worker,供后续分镜跨机
      const r = await uploadImage(file, "img2img", true);
      await setSlot(idx, uploadToRefUrl(r.filename, r.worker));
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "上传失败");
    } finally {
      setUploading(null);
      const el = inputRefs.current[idx];
      if (el) el.value = "";
    }
  };

  return (
    <div className="studio-ref-slots">
      <span className="studio-label">三视图</span>
      <div className="studio-ref-row">
        {REF_SLOTS.map((slot) => {
          const url = refs[slot.key] || "";
          const busy = uploading === slot.key;
          return (
            <div key={slot.key} className="studio-ref-slot">
              <span className="studio-ref-label">{slot.label}</span>
              {url ? (
                <div className="studio-ref-thumb-wrap">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={imageUrl(url)}
                    alt={slot.label}
                    className="studio-ref-thumb"
                    loading="lazy"
                    decoding="async"
                  />
                  <button
                    type="button"
                    className="studio-ref-clear"
                    title="清除"
                    aria-label={`清除${slot.label}`}
                    disabled={disabled || busy}
                    onClick={() => void setSlot(slot.key, null)}
                  >
                    <Icon name="close" size={11} />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="studio-ref-upload"
                  disabled={disabled || busy}
                  onClick={() => inputRefs.current[slot.key]?.click()}
                  title={`上传${slot.label}`}
                >
                  <Icon name={busy ? "loading" : "upload"} size={14} />
                </button>
              )}
              <input ref={(el) => { inputRefs.current[slot.key] = el; }} type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" hidden disabled={disabled || busy} onChange={(e) => void onFile(slot.key, e.target.files?.[0])} />
            </div>
          );
        })}
      </div>
      {localError && (
        <p className="studio-ref-error" role="alert">
          {localError}
        </p>
      )}
    </div>
  );
}

export function CastStage({
  project,
  onDone,
}: {
  project: ReturnType<typeof useStudioProject>;
  onDone: () => void;
}) {
  const d = project.detail;
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<StudioCharacter | null>(null);
  const [removing, setRemoving] = useState(false);
  const toast = useToast();

  if (!d) return null;

  const add = async () => {
    if (!newName.trim()) return;
    setAdding(true);
    setError(null);
    try {
      await addStudioCharacter(d.id, { name: newName.trim() });
      setNewName("");
      await project.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "新建角色失败");
    } finally {
      setAdding(false);
    }
  };

  const remove = (c: StudioCharacter) => setConfirmRemove(c);

  const doRemove = async () => {
    if (!confirmRemove || removing) return;
    setRemoving(true);
    try {
      await deleteStudioCharacter(confirmRemove.id);
      setConfirmRemove(null);
      await project.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    } finally {
      setRemoving(false);
    }
  };

  const patch = async (cid: string, fields: Parameters<typeof patchStudioCharacter>[1]) => {
    try {
      await patchStudioCharacter(cid, fields);
      await project.refresh();
      toast.success("角色已保存");
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    }
  };

  return (
    <section className="studio-stage studio-stage-cast">
      <div className="studio-cast-grid">
        {d.characters.map((c) => (
          <article key={c.id} className="studio-char">
            <div className="studio-char-head">
              <Icon name="user" size={16} />
              <Input
                className="studio-char-name"
                defaultValue={c.name}
                key={`n-${c.id}-${c.name}`}
                onBlur={(e) =>
                  e.target.value.trim() && e.target.value !== c.name &&
                  void patch(c.id, { name: e.target.value.trim() })
                }
              />
              <button
                type="button"
                className="studio-shot-del"
                title="删除角色"
                onClick={() => remove(c)}
              >
                <Icon name="delete" size={13} />
              </button>
            </div>
            <label className="studio-label">角色描述</label>
            <CastTextarea
              className="input"
              rows={2}
              defaultValue={c.description}
              key={`d-${c.id}-${c.description}`}
              placeholder="中文角色描述(身份/性格/关系)"
              onBlur={(e) =>
                e.target.value !== c.description && void patch(c.id, { description: e.target.value })
              }
            />
            <label className="studio-label">视觉提示词(英文)</label>
            <CastTextarea
              rows={2}
              defaultValue={c.visual_prompt}
              key={`v-${c.id}-${c.visual_prompt}`}
              placeholder="1boy, black hair, worn jacket…(注入分镜 prompt 保跨镜一致)"
              onBlur={(e) =>
                e.target.value !== c.visual_prompt &&
                void patch(c.id, { visual_prompt: e.target.value })
              }
            />
            <RefSlots
              character={c}
              onPatch={async (reference_images) => {
                await patch(c.id, { reference_images });
              }}
            />
            {c.voice_ref_url && (
              <p className="studio-char-voice">
                <Icon name="mic" size={12} /> 参考音已配置(配音自动克隆音色)
              </p>
            )}
          </article>
        ))}

        {/* 新建角色卡 */}
        <article className="studio-char studio-char-new">
          <Input
            value={newName}
            placeholder="新角色名…"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void add()}
          />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={adding || !newName.trim()}
            onClick={() => void add()}
          >
            <Icon name={adding ? "loading" : "plus"} size={13} /> 新建角色
          </button>
        </article>
      </div>

      <ErrorBar message={error} onClose={() => setError(null)} />

      <div className="studio-stage-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={d.characters.length === 0}
          onClick={onDone}
        >
          下一步:分镜 <Icon name="chevron-right" size={14} />
        </button>
      </div>

      {/* 删除角色确认(替代原生 window.confirm) */}
      <Modal
        open={!!confirmRemove}
        onClose={() => setConfirmRemove(null)}
        title="删除角色"
        danger
        preventClose={removing}
        footer={
          <>
            <Button
              variant="secondary"
              disabled={removing}
              onClick={() => setConfirmRemove(null)}
            >
              取消
            </Button>
            <Button
              variant="danger"
              loading={removing}
              icon={<Icon name="delete" size={14} />}
              onClick={() => void doRemove()}
            >
              {removing ? "删除中…" : "确认删除"}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0, color: "var(--text-secondary)", lineHeight: 1.6 }}>
          删除角色「{confirmRemove?.name}」?引用该角色的分镜说话人将失效。
        </p>
      </Modal>
    </section>
  );
}
