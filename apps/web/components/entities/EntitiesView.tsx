"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AssetPicker } from "@/components/generate/AssetPicker";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Field, Input, Textarea } from "@/components/ui/Input";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { Modal } from "@/components/ui/Modal";
import { Tabs } from "@/components/ui/Tabs";
import { useToast } from "@/components/ui/Toast";
import {
  createEntity,
  deleteEntity,
  generateEntityReference,
  imageUrl,
  listEntities,
  updateEntity,
  uploadImage,
  type EntityImageHandle,
  type EntityImageInput,
  type EntityItem,
  type EntityKind,
} from "@/lib/api";

/**
 * P1 全局主体库(2026-08-26,对标 Vidu Q3 My References):
 * 角色/场景/道具三类主体跨项目复用——三 tab + 卡片网格 + 新建/编辑/删除。
 * 图片上传走 /api/upload 句柄(也可从作品库转运),预览走后端 /api/entities/{id}/images/{slot}。
 * 2026-08-29 重做:kind 域扩 avatar(数字人形象,双轨归并);卡片「AI 三视图」
 * 异步补图(reference_status 轮询);avatar 绿幕徽标。
 * ⚠️ 多组件文件:styled-jsx 作用域类只打在主组件 JSX 上,子组件拿不到 →
 *    一律 <style jsx global> + ent- 前缀(生产事故教训,P-2b)。
 */

const KIND_LABEL: Record<EntityKind, string> = {
  character: "角色",
  scene: "场景",
  prop: "道具",
  avatar: "数字人",
};

const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_EXT_OK = ["jpg", "jpeg", "png", "webp"];

type SlotKey = "ref" | "front" | "side" | "back";

const SLOT_COL: Record<SlotKey, "ref_image" | "reference_front" | "reference_side" | "reference_back"> = {
  ref: "ref_image",
  front: "reference_front",
  side: "reference_side",
  back: "reference_back",
};

function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** 表单态:图片槽 = 已存句柄 / 新上传句柄(带本地预览)/ 空。 */
interface SlotState {
  handle: EntityImageHandle | null;
  previewUrl: string; // 本地 blob 或后端预览 URL
}

const EMPTY_SLOT: SlotState = { handle: null, previewUrl: "" };

interface FormState {
  kind: EntityKind;
  name: string;
  description: string;
  prompt_hint: string;
  slots: Record<SlotKey, SlotState>;
  /** 编辑时原有的字符串形态(URL)图片:未动则原样保留(不进 slots) */
  kept: Record<SlotKey, string>;
  /** avatar 扩展(数字人形象):绿幕标记 / 默认音色 URL */
  green_screen: boolean;
  ref_audio: string;
}

function formFromEntity(e?: EntityItem): FormState {
  const slots: Record<SlotKey, SlotState> = {
    ref: { ...EMPTY_SLOT },
    front: { ...EMPTY_SLOT },
    side: { ...EMPTY_SLOT },
    back: { ...EMPTY_SLOT },
  };
  const kept: Record<SlotKey, string> = { ref: "", front: "", side: "", back: "" };
  if (e) {
    for (const slot of Object.keys(SLOT_COL) as SlotKey[]) {
      const h = e.handles[slot];
      if (h) {
        slots[slot] = { handle: h, previewUrl: imageUrl(e.image_urls[slot] ?? "") };
      } else {
        // URL 字符串形态:保留原值(编辑不丢),预览直接可用
        kept[slot] = e[SLOT_COL[slot]] ?? "";
        if (kept[slot]) {
          slots[slot] = { handle: null, previewUrl: imageUrl(e.image_urls[slot] ?? "") };
        }
      }
    }
  }
  return {
    kind: e?.kind ?? "character",
    name: e?.name ?? "",
    description: e?.description ?? "",
    prompt_hint: e?.prompt_hint ?? "",
    slots,
    kept,
    green_screen: e?.green_screen ?? false,
    ref_audio: e?.ref_audio ?? "",
  };
}

// ---------------------------------------------------------------------------
// 图片槽(单图/三视图共用):预览 + 上传 / 从作品库选 / 清除
// ---------------------------------------------------------------------------
interface ImageSlotProps {
  label: string;
  slot: SlotState;
  disabled?: boolean;
  onChange: (v: SlotState) => void;
}

function ImageSlot({ label, slot, disabled, onChange }: ImageSlotProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const toast = useToast();
  const [uploading, setUploading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFile(file: File | undefined) {
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
    setUploading(true);
    try {
      const r = await uploadImage(file, "img2img");
      onChange({
        handle: { filename: r.filename, worker: r.worker },
        previewUrl: URL.createObjectURL(file),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "上传失败");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="ent-slot">
      <span className="ent-slot-label">{label}</span>
      <div className="ent-slot-body">
        {slot.previewUrl ? (
          <div className="ent-slot-thumb-wrap">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={slot.previewUrl} alt={label} className="ent-slot-thumb" />
            <button
              type="button"
              className="ent-slot-clear"
              aria-label={`清除${label}`}
              disabled={disabled}
              onClick={() => onChange({ ...EMPTY_SLOT })}
            >
              <Icon name="close" size={11} />
            </button>
          </div>
        ) : (
          <div className="ent-slot-actions">
            <Button
              variant="secondary"
              size="sm"
              loading={uploading}
              icon={<Icon name="upload" size={13} />}
              disabled={disabled}
              onClick={() => inputRef.current?.click()}
            >
              上传
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={<Icon name="library" size={13} />}
              disabled={disabled}
              onClick={() => setPickerOpen(true)}
            >
              作品库
            </Button>
          </div>
        )}
      </div>
      {error && <span className="ent-slot-error">{error}</span>}
      <AssetPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        assetType="image"
        kind="img2img"
        onPick={(a) => {
          onChange({
            handle: { filename: a.filename, worker: a.worker },
            previewUrl: a.previewUrl,
          });
          toast.success(`已引用作品库图片作为${label}`);
        }}
      />
      <input
        ref={inputRef}
        type="file"
        accept=".jpg,.jpeg,.png,.webp"
        style={{ display: "none" }}
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 新建 / 编辑弹窗
// ---------------------------------------------------------------------------
interface EntityFormModalProps {
  open: boolean;
  editing: EntityItem | null;
  defaultKind: EntityKind;
  onClose: () => void;
  onSaved: (e: EntityItem) => void;
}

function EntityFormModal({ open, editing, defaultKind, onClose, onSaved }: EntityFormModalProps) {
  const toast = useToast();
  const [form, setForm] = useState<FormState>(() => formFromEntity());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm(formFromEntity(editing ?? undefined));
      if (!editing) setForm((f) => ({ ...f, kind: defaultKind }));
      setError(null);
    }
  }, [open, editing, defaultKind]);

  const isCharacter = form.kind === "character" || form.kind === "avatar";

  async function save() {
    if (!form.name.trim()) {
      setError("名称不能为空");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // 图片槽 → 提交值:新句柄 > 显式清除("") > 编辑保留原值(不传)
      const imagePayload = (slot: SlotKey): { key: string; value: EntityImageInput }[] => {
        const s = form.slots[slot];
        if (s.handle) return [{ key: SLOT_COL[slot], value: s.handle }];
        if (editing && form.kept[slot] && !s.previewUrl) {
          // 原有 URL 形态被清除(preview 与 handle 皆空)
          return [{ key: SLOT_COL[slot], value: "" }];
        }
        if (editing && form.kept[slot]) return []; // 未动:保留原 URL 串
        if (editing) return [{ key: SLOT_COL[slot], value: "" }];
        return [];
      };
      const body: Record<string, unknown> = {
        kind: form.kind,
        name: form.name.trim(),
        description: form.description.trim(),
        prompt_hint: form.prompt_hint.trim(),
      };
      if (form.kind === "avatar") {
        body.green_screen = form.green_screen;
        body.ref_audio = form.ref_audio.trim();
      }
      for (const { key, value } of [
        ...imagePayload("ref"),
        ...imagePayload("front"),
        ...imagePayload("side"),
        ...imagePayload("back"),
      ]) {
        body[key] = value;
      }
      const saved = editing
        ? await updateEntity(editing.id, body)
        : await createEntity(body as unknown as Parameters<typeof createEntity>[0]);
      toast.success(editing ? "主体已更新" : "主体已创建");
      onSaved(saved);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? `编辑主体 · ${editing.name}` : "新建主体"}
      width={560}
      preventClose={saving}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            {editing ? "保存" : "创建"}
          </Button>
        </>
      }
    >
      <div className="ent-form">
        <Field label="类别">
          <Tabs
            items={(Object.keys(KIND_LABEL) as EntityKind[]).map((k) => ({
              key: k,
              label: KIND_LABEL[k],
            }))}
            current={form.kind}
            onChange={(k) => setForm((f) => ({ ...f, kind: k as EntityKind }))}
            ariaLabel="主体类别"
          />
        </Field>
        <Field label="名称" hint="生成页/助手按名称识别主体,建议独特易记">
          <Input
            value={form.name}
            maxLength={100}
            placeholder="如:女主林晚 / 旧仓库 / 左轮手枪"
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
        </Field>
        <Field label="描述" hint="中文描述,助手注入提示词时 prompt_hint 为空则回退用它">
          <Textarea
            value={form.description}
            rows={2}
            maxLength={2000}
            placeholder="黑长直,红瞳,学院制服…"
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
        </Field>
        <Field label="提示词描述(prompt_hint)" hint="英文 token 优先;引用主体时自动注入生成提示词">
          <Textarea
            value={form.prompt_hint}
            rows={2}
            maxLength={2000}
            placeholder="1girl, black long hair, red eyes, school uniform"
            onChange={(e) => setForm((f) => ({ ...f, prompt_hint: e.target.value }))}
          />
        </Field>
        {isCharacter ? (
          <Field label="三视图" hint="正面/侧面/背面,锁定角色跨镜一致性;正面优先作为参考图">
            <div className="ent-slots-row">
              {(["front", "side", "back"] as SlotKey[]).map((s) => (
                <ImageSlot
                  key={s}
                  label={s === "front" ? "正面" : s === "side" ? "侧面" : "背面"}
                  slot={form.slots[s]}
                  disabled={saving}
                  onChange={(v) => setForm((f) => ({ ...f, slots: { ...f.slots, [s]: v } }))}
                />
              ))}
            </div>
          </Field>
        ) : null}
        <Field label={isCharacter ? "单图(无三视图时兜底)" : "参考图"}>
          <ImageSlot
            label="参考图"
            slot={form.slots.ref}
            disabled={saving}
            onChange={(v) => setForm((f) => ({ ...f, slots: { ...f.slots, ref: v } }))}
          />
        </Field>
        {form.kind === "avatar" && (
          <>
            <Field label="绿幕素材" hint="绿幕背景的形象素材,后续抠像/合成工作流使用">
              <label className="ent-check">
                <input
                  type="checkbox"
                  checked={form.green_screen}
                  disabled={saving}
                  onChange={(e) => setForm((f) => ({ ...f, green_screen: e.target.checked }))}
                />
                <span>这是绿幕形象</span>
              </label>
            </Field>
            <Field label="默认音色参考" hint="可空;填入参考音频 URL,数字人合成时优先克隆该音色">
              <Input
                value={form.ref_audio}
                maxLength={2000}
                placeholder="/api/drama/voice/voice-xxx.wav"
                onChange={(e) => setForm((f) => ({ ...f, ref_audio: e.target.value }))}
              />
            </Field>
          </>
        )}
        {error && <p className="ent-form-error">{error}</p>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// 主视图
// ---------------------------------------------------------------------------
export function EntitiesView() {
  const toast = useToast();
  const [kind, setKind] = useState<EntityKind>("character");
  const [items, setItems] = useState<EntityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<EntityItem | null>(null);
  const [deleting, setDeleting] = useState<EntityItem | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await listEntities());
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载主体库失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // AI 三视图补图:有主体 generating 时 3.5s 轮询直到全部终态
  const [genBusy, setGenBusy] = useState<string | null>(null);
  const generating = useMemo(
    () => items.some((e) => e.reference_status === "generating"),
    [items],
  );
  useEffect(() => {
    if (!generating) return;
    const t = setInterval(async () => {
      try {
        setItems(await listEntities());
      } catch {
        /* 下轮自愈 */
      }
    }, 3500);
    return () => clearInterval(t);
  }, [generating]);

  async function startGenerateReference(e: EntityItem) {
    setGenBusy(e.id);
    try {
      const updated = await generateEntityReference(e.id);
      upsert(updated);
      toast.info(`「${e.name}」三视图生成中,完成后自动回填…`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "提交三视图生成失败");
    } finally {
      setGenBusy(null);
    }
  }

  const filtered = useMemo(() => items.filter((e) => e.kind === kind), [items, kind]);
  const counts = useMemo(() => {
    const c: Record<EntityKind, number> = { character: 0, scene: 0, prop: 0, avatar: 0 };
    for (const e of items) c[e.kind] = (c[e.kind] ?? 0) + 1;
    return c;
  }, [items]);

  function upsert(saved: EntityItem) {
    setItems((prev) => {
      const i = prev.findIndex((e) => e.id === saved.id);
      if (i >= 0) {
        const next = [...prev];
        next[i] = saved;
        return next;
      }
      return [...prev, saved];
    });
  }

  async function confirmDelete() {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await deleteEntity(deleting.id);
      setItems((prev) => prev.filter((e) => e.id !== deleting.id));
      toast.success(`已删除主体「${deleting.name}」`);
      setDeleting(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "删除失败");
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <div className="ent-view view-shell">
      {/* 页头移除(2026-09-02 W3):类别 Tabs + 新建钮合成一行工具条;
          用途说明收进新建钮 title */}
      <div className="ent-toolbar">
        <Tabs
          items={(Object.keys(KIND_LABEL) as EntityKind[]).map((k) => ({
            key: k,
            label: `${KIND_LABEL[k]} (${counts[k] ?? 0})`,
          }))}
          current={kind}
          onChange={(k) => setKind(k as EntityKind)}
          ariaLabel="主体类别"
        />
        <Button
          variant="primary"
          size="sm"
          icon={<Icon name="upload" size={14} />}
          title="主体跨项目复用:生成页「引用主体」、助手 entity_ids、短剧角色一致性共用此库"
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
        >
          新建主体
        </Button>
      </div>
      {loading ? (
        <LoadingBlock variant="grid" count={6} />
      ) : error ? (
        /* 空态/错误态(2026-09-02 W3):大图标 Empty → 单行 muted 提示 + 行内操作 */
        <div className="ent-empty-row">
          <span className="ent-empty-text">加载失败:{error}</span>
          <Button variant="ghost" size="sm" onClick={() => void load()}>重试</Button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="ent-empty-row">
          <span className="ent-empty-text">
            还没有{KIND_LABEL[kind]}主体——创建后可在生成页「引用主体」与助手中复用
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            新建{KIND_LABEL[kind]}主体
          </Button>
        </div>
      ) : (
        <div className="ent-grid">
          {filtered.map((e) => {
            const cover = e.image_urls.front ?? e.image_urls.ref ?? e.image_urls.side ?? e.image_urls.back;
            return (
              <div key={e.id} className="ent-card">
                <div className="ent-card-cover">
                  {cover ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={imageUrl(cover)} alt={e.name} loading="lazy" decoding="async" />
                  ) : e.reference_status === "generating" ? (
                    <span className="ent-card-noimg ent-card-gen">
                      <Icon name="refresh" size={22} className="ent-spin" />
                      <em>生成中…</em>
                    </span>
                  ) : (
                    <span className="ent-card-noimg">
                      <Icon name={e.kind === "character" || e.kind === "avatar" ? "user" : e.kind === "scene" ? "image" : "box"} size={28} />
                    </span>
                  )}
                  <span className="ent-card-kind">{KIND_LABEL[e.kind]}</span>
                  {e.green_screen && <span className="ent-card-gs">绿幕</span>}
                </div>
                <div className="ent-card-body">
                  <h3 className="ent-card-name" title={e.name}>{e.name}</h3>
                  {(e.description || e.prompt_hint) && (
                    <p className="ent-card-desc" title={e.prompt_hint || e.description}>
                      {e.description || e.prompt_hint}
                    </p>
                  )}
                  {e.reference_status === "error" && e.reference_error && (
                    <p className="ent-card-err" title={e.reference_error}>
                      三视图生成失败:{e.reference_error}
                    </p>
                  )}
                  <div className="ent-card-actions">
                    {(e.kind === "character" || e.kind === "avatar") && (
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<Icon name="sparkles" size={13} />}
                        loading={genBusy === e.id}
                        disabled={e.reference_status === "generating"}
                        onClick={() => void startGenerateReference(e)}
                      >
                        {e.reference_status === "generating"
                          ? "生成中…"
                          : (e.imageCount ?? 0) > 0
                            ? "重新生成三视图"
                            : "AI 三视图"}
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setEditing(e);
                        setFormOpen(true);
                      }}
                    >
                      编辑
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<Icon name="delete" size={13} />}
                      onClick={() => setDeleting(e)}
                    >
                      删除
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <EntityFormModal
        open={formOpen}
        editing={editing}
        defaultKind={kind}
        onClose={() => setFormOpen(false)}
        onSaved={upsert}
      />
      <Modal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`删除主体「${deleting?.name ?? ""}」?`}
        danger
        preventClose={deleteBusy}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)} disabled={deleteBusy}>
              取消
            </Button>
            <Button variant="danger" loading={deleteBusy} onClick={() => void confirmDelete()}>
              确认删除
            </Button>
          </>
        }
      >
        <p className="ent-delete-desc">
          删除后生成页与助手将无法再引用该主体;已生成的历史作品不受影响。此操作不可撤销。
        </p>
      </Modal>

      <style jsx global>{`
        .ent-view {
          display: flex;
          flex-direction: column;
          gap: var(--section-gap, 16px);
        }
        /* 工具条(2026-09-02 W3 页头移除):类别 Tabs 在左,新建钮在右 */
        .ent-toolbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-3, 12px);
          flex-wrap: wrap;
        }
        /* 空态/错误态:单行 muted 提示 + 行内 ghost 操作(at-empty--inline 语言(empty-console-hint 已于 W2A 退役)) */
        .ent-empty-row {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: var(--space-2, 8px);
          padding: var(--space-6, 24px) 0;
        }
        .ent-empty-text {
          font-size: var(--text-aux, 11px);
          color: var(--text-muted);
        }
        .ent-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
          gap: var(--space-3, 12px);
        }
        .ent-card {
          display: flex;
          flex-direction: column;
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control, 10px);
          background: var(--bg-surface-1);
          overflow: hidden;
        }
        .ent-card-cover {
          position: relative;
          aspect-ratio: 1;
          background: var(--bg-surface-3);
        }
        .ent-card-cover img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }
        .ent-card-noimg {
          width: 100%;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--text-muted);
        }
        .ent-card-kind {
          position: absolute;
          top: 6px;
          left: 6px;
          padding: 2px 8px;
          border-radius: 999px;
          font-size: 10px;
          background: var(--scrim, rgba(0, 0, 0, 0.45));
          color: var(--text-on-accent, #fff);
        }
        .ent-card-body {
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: var(--space-2, 8px) var(--space-3, 12px);
        }
        .ent-card-name {
          margin: 0;
          font-size: 13px;
          font-weight: 600;
          color: var(--text-primary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .ent-card-desc {
          margin: 0;
          font-size: 11px;
          color: var(--text-muted);
          overflow: hidden;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
        }
        .ent-card-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-top: 2px;
        }
        .ent-card-gen {
          flex-direction: column;
          gap: 6px;
          color: var(--accent);
        }
        .ent-card-gen em {
          font-style: normal;
          font-size: 11px;
        }
        .ent-spin {
          animation: ent-rotate 1.4s linear infinite;
        }
        @keyframes ent-rotate {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @media (prefers-reduced-motion: reduce) {
          .ent-spin { animation: none; }
        }
        .ent-card-gs {
          position: absolute;
          top: 6px;
          right: 6px;
          padding: 2px 8px;
          border-radius: 999px;
          font-size: 10px;
          background: var(--ok, #16a34a);
          color: #fff;
        }
        .ent-card-err {
          margin: 0;
          font-size: 11px;
          color: var(--err);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .ent-check {
          display: flex;
          align-items: center;
          gap: var(--space-2, 8px);
          font-size: 13px;
          color: var(--text-primary);
          cursor: pointer;
        }
        .ent-form {
          display: flex;
          flex-direction: column;
          gap: var(--space-3, 12px);
        }
        .ent-form-error {
          margin: 0;
          font-size: 12px;
          color: var(--err);
        }
        .ent-slots-row {
          display: flex;
          gap: var(--space-3, 12px);
        }
        .ent-slot {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .ent-slot-label {
          font-size: 10px;
          color: var(--text-muted);
        }
        .ent-slot-thumb-wrap {
          position: relative;
          width: 72px;
          height: 72px;
        }
        .ent-slot-thumb {
          width: 72px;
          height: 72px;
          object-fit: cover;
          border-radius: var(--radius-badge);
          border: 1px solid var(--border-subtle);
          display: block;
        }
        .ent-slot-clear {
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
        .ent-slot-actions {
          display: flex;
          gap: 4px;
        }
        .ent-slot-error {
          font-size: 10px;
          color: var(--err);
        }
        .ent-delete-desc {
          margin: 0;
          font-size: 13px;
          color: var(--text-secondary);
          line-height: 1.6;
        }
      `}</style>
    </div>
  );
}
