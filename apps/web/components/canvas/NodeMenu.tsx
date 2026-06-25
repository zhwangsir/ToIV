"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { NODE_META, type CanvasNodeType } from "./types";

interface NodeMenuProps {
  /** 屏幕坐标(相对画布容器)。 */
  x: number;
  y: number;
  onPick: (type: CanvasNodeType) => void;
  onClose: () => void;
}

/** 节点分类:基础 / 图像处理 / 结构化。右键或双击空白弹出。 */
const CATEGORIES: { title: string; items: CanvasNodeType[] }[] = [
  { title: "基础", items: ["text", "image", "video", "audio"] },
  { title: "图像处理", items: ["img2img", "controlnet", "ipadapter", "upscale"] },
  { title: "结构化", items: ["storyboard", "character", "lighting", "threed"] },
];

const ALL_TYPES: CanvasNodeType[] = CATEGORIES.flatMap((c) => c.items);

/** 右键 / 双击空白处弹出的节点面板:分类 + 可搜索。 */
export function NodeMenu({ x, y, onPick, onClose }: NodeMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");

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

  // 搜索:命中 label / hint 子串(忽略大小写)。空查询 → 不过滤(走分类)。
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return ALL_TYPES.filter((t) => {
      const m = NODE_META[t];
      return (m.label + m.hint).toLowerCase().includes(q);
    });
  }, [query]);

  const Item = (t: CanvasNodeType) => (
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
  );

  return (
    <div ref={ref} className="cv-menu" style={{ left: x, top: y }} role="menu" aria-label="新建节点">
      <input
        className="cv-input nodrag"
        type="text"
        autoFocus
        placeholder="搜索节点…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="cv-menu__scroll" style={{ maxHeight: "44vh", overflowY: "auto" }}>
        {matches ? (
          matches.length ? (
            matches.map(Item)
          ) : (
            <p className="cv-wf__empty">无匹配节点</p>
          )
        ) : (
          CATEGORIES.map((cat, i) => (
            <div key={cat.title}>
              <span className={`cv-menu__head${i > 0 ? " cv-menu__head--sub" : ""}`}>
                {cat.title}
              </span>
              {cat.items.map(Item)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
