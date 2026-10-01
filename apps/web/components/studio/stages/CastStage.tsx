"use client";

import { useEffect, useRef, useState, type TextareaHTMLAttributes } from "react";
import {
  addStudioCharacter,
  deleteStudioCharacter,
  generateStudioCharacterSheet,
  imageUrl,
  patchStudioCharacter,
  patchStudioProject,
  uploadImage,
  type StudioCharacter,
  type StudioCharacterSheetStyle,
} from "@/lib/api";
import { AssetPicker } from "@/components/generate/AssetPicker";
import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { Input, Textarea } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { useAutoResize } from "@/hooks/useAutoResize";
import type { useStudioProject } from "@/hooks/useStudioProject";
import {
  clearLookPick,
  fillThreeViewSlots,
  peekLookPick,
  type StudioLookPick,
} from "@/lib/studioLookPick";

/**
 * ② 角色阶段:角色卡 CRUD + 三视图 + Batch3 场景图绑定 / 一键定妆。
 */

/** 三视图槽位标签(对齐 H3 林夏定妆:正/侧/全身)。 */
const REF_SLOTS = [
  { key: 0, label: "正" },
  { key: 1, label: "侧" },
  { key: 2, label: "全身" },
] as const;

const IMAGE_EXT_OK = ["jpg", "jpeg", "png", "webp"];
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const SCENE_MAX = 4;

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

function CastTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useAutoResize(ref, String(props.defaultValue ?? ""));
  return <Textarea {...props} ref={ref} />;
}

function RefSlots({
  character,
  onPatch,
  disabled,
  pendingLook,
  onApplyLook,
}: {
  character: StudioCharacter;
  onPatch: (refs: string[]) => Promise<void>;
  disabled?: boolean;
  pendingLook?: StudioLookPick | null;
  onApplyLook?: () => Promise<void>;
}) {
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const lookFileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState<number | null>(null);
  const [lookBusy, setLookBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const refs = [...(character.reference_images || [])];
  while (refs.length < 3) refs.push("");

  const setSlot = async (idx: number, url: string | null) => {
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

  /** 一键定妆:1~3 张图按序填正/侧/全身。 */
  const applyUrls = async (urls: string[]) => {
    setLookBusy(true);
    setLocalError(null);
    try {
      await onPatch(fillThreeViewSlots(urls));
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "定妆失败");
      throw e;
    } finally {
      setLookBusy(false);
    }
  };

  const onLookFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setLocalError(null);
    const list = Array.from(files).slice(0, 3);
    for (const f of list) {
      if (!IMAGE_EXT_OK.includes(fileExt(f.name))) {
        setLocalError("仅支持 jpg / png / webp");
        return;
      }
      if (f.size > IMAGE_MAX_BYTES) {
        setLocalError("图片超过 20MB 上限");
        return;
      }
    }
    setLookBusy(true);
    try {
      const urls: string[] = [];
      for (const f of list) {
        const r = await uploadImage(f, "img2img", true);
        urls.push(uploadToRefUrl(r.filename, r.worker));
      }
      await applyUrls(urls);
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "定妆失败");
    } finally {
      setLookBusy(false);
      if (lookFileRef.current) lookFileRef.current.value = "";
    }
  };

  const filled = refs.filter(Boolean).length;
  const lookReady = filled >= 1;
  const lookDone = filled >= 3;

  return (
    <div className="studio-ref-slots">
      <div className="studio-ref-head">
        <span className="studio-label">三视图</span>
        <span
          className={`studio-look-state${lookDone ? " is-ready" : lookReady ? " is-partial" : ""}${localError ? " is-error" : ""}`}
          data-testid="studio-look-state"
        >
          {localError ? "失败" : lookDone ? "就绪" : lookReady ? `${filled}/3` : "未定妆"}
        </span>
      </div>
      <div className="studio-ref-row">
        {REF_SLOTS.map((slot) => {
          const url = refs[slot.key] || "";
          const busy = uploading === slot.key || lookBusy;
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
              <input
                ref={(el) => {
                  inputRefs.current[slot.key] = el;
                }}
                type="file"
                accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
                hidden
                disabled={disabled || busy}
                onChange={(e) => void onFile(slot.key, e.target.files?.[0])}
              />
            </div>
          );
        })}
      </div>
      <div className="studio-look-actions" data-testid="studio-look-actions">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={disabled || lookBusy}
          title="从作品库选图定妆"
          onClick={() => setPickerOpen(true)}
        >
          <Icon name={lookBusy ? "loading" : "image"} size={12} />
          定妆
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={disabled || lookBusy}
          title="上传 1~3 张填正/侧/全身"
          onClick={() => lookFileRef.current?.click()}
        >
          <Icon name="upload" size={12} />
          上传
        </button>
        {pendingLook && onApplyLook && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={disabled || lookBusy}
            data-testid="studio-look-apply-pending"
            title="应用出图卡定妆"
            onClick={() => void onApplyLook()}
          >
            <Icon name="check" size={12} />
            应用
          </button>
        )}
        <input
          ref={lookFileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
          multiple
          hidden
          disabled={disabled || lookBusy}
          onChange={(e) => void onLookFiles(e.target.files)}
        />
      </div>
      {localError && (
        <p className="studio-ref-error" role="alert">
          {localError}
        </p>
      )}
      <AssetPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        assetType="image"
        kind="img2img"
        onPick={(a) => {
          setPickerOpen(false);
          void applyUrls([uploadToRefUrl(a.filename, a.worker)]).catch(() => undefined);
        }}
      />
    </div>
  );
}

function SheetActions({
  character,
  onDone,
  onError,
}: {
  character: StudioCharacter;
  onDone: () => Promise<void>;
  onError: (msg: string | null) => void;
}) {
  const [busy, setBusy] = useState<StudioCharacterSheetStyle | null>(null);
  const toast = useToast();
  const sheetUrl = (character.reference_images || []).find((u) => u.includes("char_sheet_"));

  const run = async (style: StudioCharacterSheetStyle) => {
    setBusy(style);
    onError(null);
    try {
      await generateStudioCharacterSheet(character.id, { style });
      await onDone();
      toast.success(style === "ancient_realistic" ? "古风卡就绪" : "二次元卡就绪");
    } catch (e) {
      onError(e instanceof Error ? e.message : "设定卡失败");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="studio-sheet-actions" data-testid="studio-sheet-actions">
      <span className="studio-label">
        <Icon name="image" size={12} /> 设定卡
      </span>
      <div className="studio-look-actions">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          data-testid="studio-sheet-ancient"
          disabled={!!busy}
          title="古风写实设定卡"
          onClick={() => void run("ancient_realistic")}
        >
          <Icon name={busy === "ancient_realistic" ? "loading" : "sparkles"} size={12} />
          古风
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          data-testid="studio-sheet-anime"
          disabled={!!busy}
          title="二次元设定卡"
          onClick={() => void run("anime")}
        >
          <Icon name={busy === "anime" ? "loading" : "sparkles"} size={12} />
          二次元
        </button>
      </div>
      {sheetUrl && (
        <a
          className="studio-sheet-thumb-link"
          href={imageUrl(sheetUrl)}
          target="_blank"
          rel="noreferrer"
          data-testid="studio-sheet-preview"
          title="查看设定卡"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageUrl(sheetUrl)} alt="设定卡" className="studio-sheet-thumb" />
        </a>
      )}
    </div>
  );
}


function SceneBind({
  projectId,
  scenes,
  onChanged,
}: {
  projectId: string;
  scenes: string[];
  onChanged: () => Promise<void>;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const persist = async (next: string[]) => {
    setBusy(true);
    setError(null);
    try {
      await patchStudioProject(projectId, { scene_images: next.slice(0, SCENE_MAX) });
      await onChanged();
      toast.success("场景已绑定");
    } catch (e) {
      setError(e instanceof Error ? e.message : "场景绑定失败");
    } finally {
      setBusy(false);
    }
  };

  const addUrl = async (url: string) => {
    if (scenes.includes(url)) {
      toast.info("场景图已存在");
      return;
    }
    if (scenes.length >= SCENE_MAX) {
      setError(`最多 ${SCENE_MAX} 张场景图`);
      return;
    }
    await persist([...scenes, url]);
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (!IMAGE_EXT_OK.includes(fileExt(file.name))) {
      setError("仅支持 jpg / png / webp");
      return;
    }
    if (file.size > IMAGE_MAX_BYTES) {
      setError("图片超过 20MB 上限");
      return;
    }
    setBusy(true);
    try {
      const r = await uploadImage(file, "img2img", true);
      await addUrl(uploadToRefUrl(r.filename, r.worker));
    } catch (e) {
      setError(e instanceof Error ? e.message : "上传失败");
      setBusy(false);
    }
  };

  return (
    <div className="studio-scene-bind" data-testid="studio-scene-bind">
      <div className="studio-ref-head">
        <span className="studio-label">
          <Icon name="image" size={12} /> 场景
        </span>
        <span className="studio-look-state">
          {scenes.length}/{SCENE_MAX}
        </span>
      </div>
      <div className="studio-scene-row">
        {scenes.map((url) => (
          <div key={url} className="studio-scene-slot">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imageUrl(url)} alt="场景" className="studio-scene-thumb" loading="lazy" />
            <button
              type="button"
              className="studio-ref-clear"
              title="解绑"
              aria-label="解绑场景图"
              disabled={busy}
              onClick={() => void persist(scenes.filter((u) => u !== url))}
            >
              <Icon name="close" size={11} />
            </button>
          </div>
        ))}
        {scenes.length < SCENE_MAX && (
          <>
            <button
              type="button"
              className="studio-ref-upload"
              disabled={busy}
              title="上传场景图"
              onClick={() => fileRef.current?.click()}
            >
              <Icon name={busy ? "loading" : "upload"} size={14} />
            </button>
            <button
              type="button"
              className="studio-ref-upload"
              disabled={busy}
              title="从作品库选场景"
              onClick={() => setPickerOpen(true)}
            >
              <Icon name="image" size={14} />
            </button>
          </>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
        hidden
        disabled={busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          void onFile(f);
        }}
      />
      {error && (
        <p className="studio-ref-error" role="alert">
          {error}
        </p>
      )}
      <AssetPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        assetType="image"
        kind="img2img"
        onPick={(a) => {
          setPickerOpen(false);
          void addUrl(uploadToRefUrl(a.filename, a.worker));
        }}
      />
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
  const [pendingLook, setPendingLook] = useState<StudioLookPick | null>(null);
  const toast = useToast();

  useEffect(() => {
    setPendingLook(peekLookPick());
  }, []);

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
      throw e;
    }
  };

  const applyPendingTo = async (c: StudioCharacter) => {
    const look = pendingLook || peekLookPick();
    if (!look?.url) return;
    const next = fillThreeViewSlots([look.url]);
    // 保留已有侧/全身,只覆盖正(出图卡默认定妆正面)
    const cur = [...(c.reference_images || [])];
    while (cur.length < 3) cur.push("");
    next[1] = cur[1] || next[1];
    next[2] = cur[2] || next[2];
    await patch(c.id, { reference_images: next });
    clearLookPick();
    setPendingLook(null);
    toast.success(`已定妆「${c.name}」`);
  };

  const scenes = d.scene_images || [];

  return (
    <section className="studio-stage studio-stage-cast">
      <SceneBind projectId={d.id} scenes={scenes} onChanged={() => project.refresh()} />

      {pendingLook && (
        <div className="studio-look-banner" data-testid="studio-look-banner" role="status">
          <Icon name="image" size={14} />
          <span>出图待定妆</span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageUrl(pendingLook.url)} alt="待定妆" className="studio-look-banner-thumb" />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              clearLookPick();
              setPendingLook(null);
            }}
          >
            丢弃
          </button>
        </div>
      )}

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
                  e.target.value.trim() &&
                  e.target.value !== c.name &&
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
              placeholder="身份/性格"
              onBlur={(e) =>
                e.target.value !== c.description && void patch(c.id, { description: e.target.value })
              }
            />
            <label className="studio-label">视觉提示词</label>
            <CastTextarea
              rows={2}
              defaultValue={c.visual_prompt}
              key={`v-${c.id}-${c.visual_prompt}`}
              placeholder="1boy, black hair…"
              onBlur={(e) =>
                e.target.value !== c.visual_prompt &&
                void patch(c.id, { visual_prompt: e.target.value })
              }
            />
            <RefSlots
              character={c}
              pendingLook={pendingLook}
              onApplyLook={() => applyPendingTo(c)}
              onPatch={async (reference_images) => {
                await patch(c.id, { reference_images });
              }}
            />
            <SheetActions
              character={c}
              onDone={async () => {
                await project.refresh();
              }}
              onError={setError}
            />
            {c.voice_ref_url && (
              <p className="studio-char-voice">
                <Icon name="mic" size={12} /> 参考音已配置
              </p>
            )}
          </article>
        ))}

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
