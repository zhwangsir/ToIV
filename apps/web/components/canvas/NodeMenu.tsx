"use client";

import { useEffect, useRef } from "react";

import { NODE_META, type CanvasNodeType } from "./types";

interface NodeMenuProps {
  /** 屏幕坐标(相对画布容器)。 */
  x: number;
  y: number;
  onPick: (type: CanvasNodeType) => void;
  onClose: () => void;
}

/** 基础节点(文本/图片/视频/音频)与结构化高层节点(分镜/角色/打光/3D)分组。 */
const BASIC: CanvasNodeType[] = ["text", "image", "video", "audio"];
const STRUCTURED: CanvasNodeType[] = [
  "storyboard",
  "character",
  "lighting",
  "threed",
];

/** 双击空白处弹出的节点类型菜单。 */
export function NodeMenu({ x, y, onPick, onClose }: NodeMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="cv-menu"
      style={{ left: x, top: y }}
      role="menu"
      aria-label="新建节点"
    >
      <span className="cv-menu__head">基础节点</span>
      {BASIC.map((t) => (
        <button
          key={t}
          type="button"
          className="cv-menu__item"
          role="menuitem"
          onClick={() => onPick(t)}
        >
          <span className="cv-menu__ico" aria-hidden="true">
            {NODE_META[t].icon}
          </span>
          <span className="cv-menu__txt">
            <strong>{NODE_META[t].label}</strong>
            <em>{NODE_META[t].hint}</em>
          </span>
        </button>
      ))}
      <span className="cv-menu__head cv-menu__head--sub">结构化节点</span>
      {STRUCTURED.map((t) => (
        <button
          key={t}
          type="button"
          className="cv-menu__item"
          role="menuitem"
          onClick={() => onPick(t)}
        >
          <span className="cv-menu__ico" aria-hidden="true">
            {NODE_META[t].icon}
          </span>
          <span className="cv-menu__txt">
            <strong>{NODE_META[t].label}</strong>
            <em>{NODE_META[t].hint}</em>
          </span>
        </button>
      ))}
    </div>
  );
}
