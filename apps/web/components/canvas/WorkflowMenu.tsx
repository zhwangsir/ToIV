"use client";

import { useEffect, useRef, useState } from "react";

import type { WorkflowSummary } from "./storage";

interface WorkflowMenuProps {
  /** 当前打开的工作流(null = 未命名 / live 草稿)。 */
  currentId: string | null;
  currentName: string | null;
  /** 已存档的工作流摘要(更新时间倒序)。 */
  items: WorkflowSummary[];
  onNew: () => void;
  onSave: () => void;
  onSaveAs: (name: string) => void;
  onOpen: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}

function fmtTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

/** 「工作流」下拉:命名工作流库的新建/保存/另存为/打开/重命名/删除。 */
export function WorkflowMenu({
  currentId,
  currentName,
  items,
  onNew,
  onSave,
  onSaveAs,
  onOpen,
  onRename,
  onDelete,
}: WorkflowMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handleSaveAs = () => {
    const name = window.prompt("另存为工作流名称", currentName ?? "我的工作流");
    if (name && name.trim()) onSaveAs(name.trim());
  };

  const handleRename = (id: string, prev: string) => {
    const name = window.prompt("重命名工作流", prev);
    if (name && name.trim()) onRename(id, name.trim());
  };

  const handleDelete = (id: string, name: string) => {
    if (window.confirm(`删除工作流「${name}」?此操作不可撤销。`)) onDelete(id);
  };

  return (
    <div className="cv-wf" ref={ref}>
      <button
        type="button"
        className="cv-btn cv-wf__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        🗂 工作流{currentName ? `:${currentName}` : ""}
        <span className="cv-wf__caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="cv-wf__panel" role="menu" aria-label="工作流库">
          <div className="cv-wf__ops">
            <button
              type="button"
              className="cv-wf__op"
              role="menuitem"
              onClick={() => {
                onNew();
                setOpen(false);
              }}
            >
              ✚ 新建
            </button>
            <button
              type="button"
              className="cv-wf__op"
              role="menuitem"
              disabled={!currentId}
              onClick={() => {
                onSave();
                setOpen(false);
              }}
              title={currentId ? "覆盖保存当前工作流" : "请先「另存为」"}
            >
              💾 保存
            </button>
            <button
              type="button"
              className="cv-wf__op"
              role="menuitem"
              onClick={() => {
                handleSaveAs();
                setOpen(false);
              }}
            >
              📄 另存为
            </button>
          </div>

          <div className="cv-wf__list-head">已保存({items.length})</div>
          {items.length === 0 ? (
            <p className="cv-wf__empty">还没有命名工作流。用「另存为」存下当前画布。</p>
          ) : (
            <ul className="cv-wf__list">
              {items.map((w) => (
                <li
                  key={w.id}
                  className={`cv-wf__item${w.id === currentId ? " is-current" : ""}`}
                >
                  <button
                    type="button"
                    className="cv-wf__open"
                    role="menuitem"
                    onClick={() => {
                      onOpen(w.id);
                      setOpen(false);
                    }}
                  >
                    <strong>{w.name}</strong>
                    <em>
                      {w.nodeCount} 节点 · {fmtTime(w.updatedAt)}
                    </em>
                  </button>
                  <span className="cv-wf__row-actions">
                    <button
                      type="button"
                      className="cv-wf__mini"
                      onClick={() => handleRename(w.id, w.name)}
                      aria-label={`重命名 ${w.name}`}
                      title="重命名"
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className="cv-wf__mini cv-wf__mini--del"
                      onClick={() => handleDelete(w.id, w.name)}
                      aria-label={`删除 ${w.name}`}
                      title="删除"
                    >
                      ✕
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
