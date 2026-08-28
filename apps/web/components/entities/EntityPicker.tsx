"use client";

import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import { imageUrl, listEntities, type EntityItem, type EntityKind } from "@/lib/api";

/**
 * 主体库多选器(生成页「引用主体」):
 * 勾选角色/场景/道具主体,确认后由调用方把主体图注入参考图链、
 * prompt_hint 注入提示词。与 AssetPicker 同 UX(一次性选择动作)。
 */

const KIND_LABEL: Record<EntityKind, string> = {
  character: "角色",
  scene: "场景",
  prop: "道具",
  avatar: "数字人",
};

/** 主体封面图槽位优先级(与后端 best_image_value 一致)。 */
export function entityCover(e: EntityItem): string {
  return e.image_urls.front ?? e.image_urls.ref ?? e.image_urls.side ?? e.image_urls.back ?? "";
}

interface EntityPickerProps {
  open: boolean;
  onClose: () => void;
  /** 已引用的主体 id(回显勾选态) */
  selectedIds: string[];
  /** 确认回调:本次勾选的完整主体列表 */
  onConfirm: (entities: EntityItem[]) => void;
}

export function EntityPicker({ open, onClose, selectedIds, onConfirm }: EntityPickerProps) {
  const [items, setItems] = useState<EntityItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());

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
    if (open) {
      setChecked(new Set(selectedIds));
      void load();
    }
  }, [open, selectedIds, load]);

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function confirm() {
    onConfirm(items.filter((e) => checked.has(e.id)));
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="引用主体"
      width={640}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={checked.size === 0} onClick={confirm}>
            引用 {checked.size > 0 ? `(${checked.size})` : ""}
          </Button>
        </>
      }
    >
      {loading ? (
        <p className="entity-picker-empty">加载中…</p>
      ) : error ? (
        <p className="entity-picker-empty">{error}</p>
      ) : items.length === 0 ? (
        <p className="entity-picker-empty">
          主体库为空——先到「主体库」页创建角色/场景/道具主体
        </p>
      ) : (
        <div className="entity-picker-grid">
          {items.map((e) => {
            const cover = entityCover(e);
            const on = checked.has(e.id);
            return (
              <button
                type="button"
                key={e.id}
                className={`entity-picker-item${on ? " is-on" : ""}`}
                aria-pressed={on}
                title={e.description || e.prompt_hint || e.name}
                onClick={() => toggle(e.id)}
              >
                {cover ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={imageUrl(cover)} alt={e.name} loading="lazy" decoding="async" width={112} height={112} />
                ) : (
                  <span className="entity-picker-icon">
                    <Icon name={e.kind === "character" ? "user" : e.kind === "scene" ? "image" : "box"} size={22} />
                  </span>
                )}
                <span className="entity-picker-name">{e.name}</span>
                <span className="entity-picker-kind">{KIND_LABEL[e.kind]}</span>
                {on && (
                  <span className="entity-picker-check">
                    <Icon name="check" size={12} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
      <style jsx>{`
        .entity-picker-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
          gap: var(--space-2, 8px);
          max-height: 56vh;
          overflow: auto;
        }
        .entity-picker-item {
          position: relative;
          display: flex;
          flex-direction: column;
          gap: 4px;
          padding: 4px;
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control, 8px);
          background: var(--bg-surface-3, transparent);
          cursor: pointer;
        }
        .entity-picker-item:hover {
          border-color: var(--accent);
        }
        .entity-picker-item.is-on {
          border-color: var(--accent);
          box-shadow: inset 0 0 0 1px var(--accent);
        }
        .entity-picker-item :global(img) {
          width: 100%;
          aspect-ratio: 1;
          object-fit: cover;
          border-radius: 6px;
          display: block;
        }
        .entity-picker-icon {
          width: 100%;
          aspect-ratio: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--text-muted);
        }
        .entity-picker-name {
          font-size: 10px;
          color: var(--text-secondary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .entity-picker-kind {
          position: absolute;
          top: 8px;
          left: 8px;
          padding: 1px 6px;
          border-radius: 999px;
          font-size: 9px;
          background: var(--scrim, rgba(0, 0, 0, 0.45));
          color: var(--text-on-accent, #fff);
        }
        .entity-picker-check {
          position: absolute;
          top: 8px;
          right: 8px;
          width: 18px;
          height: 18px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 50%;
          background: var(--accent);
          color: var(--text-on-accent, #fff);
        }
        .entity-picker-empty {
          margin: 0;
          padding: 28px 0;
          text-align: center;
          color: var(--text-muted);
          font-size: 13px;
        }
      `}</style>
    </Modal>
  );
}
