"use client";

import { Icon } from "@/components/ui/Icon";

export type AppMode = "canvas" | "studio";

interface ModeSwitcherProps {
  mode: AppMode;
  onChange: (mode: AppMode) => void;
  className?: string;
}

export function ModeSwitcher({ mode, onChange, className }: ModeSwitcherProps) {
  return (
    <div className={`mode-switcher ${className || ""}`} role="tablist" aria-label="布局模式切换">
      <button
        type="button"
        className={`mode-switcher-btn${mode === "canvas" ? " is-active" : ""}`}
        onClick={() => onChange("canvas")}
        role="tab"
        aria-selected={mode === "canvas"}
        aria-label="画布模式"
        title="无限画布 · 节点工作流"
      >
        <Icon name="workflow" size={14} />
        <span>画布</span>
      </button>
      <button
        type="button"
        className={`mode-switcher-btn${mode === "studio" ? " is-active" : ""}`}
        onClick={() => onChange("studio")}
        role="tab"
        aria-selected={mode === "studio"}
        aria-label="工作室模式"
        title="影视剪辑工作台"
      >
        <Icon name="clapperboard" size={14} />
        <span>工作室</span>
      </button>
    </div>
  );
}
