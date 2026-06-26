"use client";

import { useCallback, useEffect, useState } from "react";

import {
  createManjuProject,
  deleteManjuProject,
  getManjuProject,
  listManjuProjects,
  saveManjuAssets,
  saveManjuShots,
  updateManjuProject,
  type ManjuAssetInput,
  type ManjuAssetItem,
  type ManjuProjectSummary,
  type ManjuShotInput,
  type ManjuShotItem,
} from "@/lib/api";

import type { CharRow, ShotCard } from "./types";

import "./manju-project-bar.css";

/** 当前导演台状态快照(保存进项目)。 */
export interface ProjectSnapshot {
  title: string;
  premise: string;
  style: string;
  ckpt: string;
  shots: ShotCard[];
  chars: CharRow[];
}

/** 打开项目后回填导演台的数据。 */
export interface ProjectLoaded extends ProjectSnapshot {
  id: string;
}

interface ManjuProjectBarProps {
  snapshot: ProjectSnapshot;
  onLoad: (data: ProjectLoaded) => void;
  /** 新建空项目(清空导演台)。 */
  onNew: () => void;
  /** 受控:当前项目 id(供导演台在生成分镜后自动落库)。 */
  currentId: string | null;
  onCurrentIdChange: (id: string | null) => void;
}

// 前后端镜头字段映射:前端 description ↔ 后端 prompt
export const shotCardToInput = (s: ShotCard): ManjuShotInput => ({
  scene: s.scene,
  prompt: s.description,
  characters: s.characters,
  camera: s.camera,
  dialogue: s.dialogue,
  duration_sec: s.duration_sec,
});

const toShotCard = (s: ManjuShotItem): ShotCard => ({
  id: s.id,
  scene: s.scene,
  description: s.prompt,
  characters: s.characters,
  camera: s.camera,
  dialogue: s.dialogue,
  duration_sec: s.duration_sec,
  status: "idle",
});

// 角色登记 ↔ 项目资产(kind=character):名字必填者方持久化
const toAssetInput = (c: CharRow): ManjuAssetInput => ({
  kind: "character",
  name: c.name,
  description: c.desc,
  ref_image: c.refImage ?? "",
});

const toCharRow = (a: ManjuAssetItem): CharRow => ({
  name: a.name,
  desc: a.description,
  ...(a.ref_image ? { refImage: a.ref_image } : {}),
});

export function ManjuProjectBar({
  snapshot,
  onLoad,
  onNew,
  currentId,
  onCurrentIdChange,
}: ManjuProjectBarProps) {
  const [projects, setProjects] = useState<ManjuProjectSummary[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setProjects(await listManjuProjects());
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleSave = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const body = {
        title: snapshot.title,
        premise: snapshot.premise,
        style: snapshot.style,
        ckpt_name: snapshot.ckpt,
      };
      const id = currentId
        ? (await updateManjuProject(currentId, body)).id
        : (await createManjuProject(body)).id;
      await saveManjuShots(id, snapshot.shots.map(shotCardToInput));
      // 角色登记落库为可复用资产(只存有名字的)
      await saveManjuAssets(
        id,
        snapshot.chars.filter((c) => c.name.trim()).map(toAssetInput),
      );
      onCurrentIdChange(id);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [busy, currentId, snapshot, refresh, onCurrentIdChange]);

  const handleOpen = useCallback(
    async (pid: string) => {
      if (busy) return;
      setBusy(true);
      setErr(null);
      try {
        const p = await getManjuProject(pid);
        onLoad({
          id: p.id,
          title: p.title,
          premise: p.premise,
          style: p.style,
          ckpt: p.ckpt_name,
          shots: p.shots.map(toShotCard),
          chars: p.assets.filter((a) => a.kind === "character").map(toCharRow),
        });
        onCurrentIdChange(p.id);
        setOpen(false);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [busy, onLoad, onCurrentIdChange],
  );

  const handleDelete = useCallback(
    async (pid: string, e: React.MouseEvent) => {
      e.stopPropagation();
      if (busy || !window.confirm("删除该项目?其分镜与资产一并清除,不可撤销。")) return;
      setBusy(true);
      try {
        await deleteManjuProject(pid);
        if (currentId === pid) onCurrentIdChange(null);
        await refresh();
      } catch (err2) {
        setErr((err2 as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [busy, currentId, refresh, onCurrentIdChange],
  );

  const handleNew = useCallback(() => {
    onCurrentIdChange(null);
    setOpen(false);
    onNew();
  }, [onNew, onCurrentIdChange]);

  return (
    <div className="mpb">
      <div className="mpb-row">
        <button type="button" className="mpb-btn" onClick={handleNew} disabled={busy}>
          ✨ 新建
        </button>
        <button type="button" className="mpb-btn primary" onClick={handleSave} disabled={busy}>
          {busy ? "保存中…" : currentId ? "💾 保存" : "💾 保存为项目"}
        </button>
        <div className="mpb-dd">
          <button
            type="button"
            className="mpb-btn"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
          >
            📂 项目库{projects.length ? ` (${projects.length})` : ""}
          </button>
          {open && (
            <div className="mpb-panel" role="menu">
              {projects.length === 0 ? (
                <p className="mpb-empty">还没有保存的项目</p>
              ) : (
                projects.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`mpb-item${currentId === p.id ? " is-on" : ""}`}
                    onClick={() => handleOpen(p.id)}
                  >
                    <span className="mpb-item-title">{p.title || "未命名漫剧"}</span>
                    <span
                      className="mpb-del"
                      role="button"
                      aria-label="删除项目"
                      title="删除"
                      onClick={(e) => handleDelete(p.id, e)}
                    >
                      ✕
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
        {currentId && <span className="mpb-tag">已存盘</span>}
      </div>
      {err && <p className="mpb-err">⚠ {err}</p>}
    </div>
  );
}
