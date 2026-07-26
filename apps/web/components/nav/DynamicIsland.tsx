"use client";

import { useState, useRef, useEffect } from "react";
import { Icon, type IconName } from "@/components/ui/Icon";

export interface DynamicIslandView {
  key: string;
  label: string;
  icon: IconName;
  shortcut?: string;
  group?: "main" | "tools" | "resources";
}

interface DynamicIslandProps {
  views: DynamicIslandView[];
  current: string;
  onSelect: (key: string) => void;
}

type IslandState = "dot" | "menu" | "pill";

export function DynamicIsland({ views, current, onSelect }: DynamicIslandProps) {
  const [state, setState] = useState<IslandState>("dot");
  const [isHovering, setIsHovering] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pillTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentView = views.find((v) => v.key === current);

  // 导航切换时:短暂显示 pill(选中反馈),2.5s 后回归 dot(极简默认态)
  useEffect(() => {
    if (pillTimeoutRef.current) clearTimeout(pillTimeoutRef.current);
    setState("pill");
    pillTimeoutRef.current = setTimeout(() => {
      pillTimeoutRef.current = null;
      setState((s) => (s === "pill" ? "dot" : s));
    }, 2500);
    return () => {
      if (pillTimeoutRef.current) clearTimeout(pillTimeoutRef.current);
      pillTimeoutRef.current = null;
    };
  }, [current]);

  const handleMouseEnter = () => {
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
    setIsHovering(true);
    setState("menu");
  };

  const handleMouseLeave = () => {
    setIsHovering(false);
    closeTimeoutRef.current = setTimeout(() => {
      // 离开菜单后:若有 pill 计时未到期则回 pill,否则回 dot
      setState(pillTimeoutRef.current ? "pill" : "dot");
    }, 200);
  };

  const handleSelect = (key: string) => {
    onSelect(key);
    setIsHovering(false);
    // onSelect 会触发 current 变化,useEffect 会将状态设为 pill
    // 这里立即关闭菜单,让 pill 反馈动画显现
    if (pillTimeoutRef.current) clearTimeout(pillTimeoutRef.current);
    setState("pill");
    pillTimeoutRef.current = setTimeout(() => {
      pillTimeoutRef.current = null;
      setState((s) => (s === "pill" ? "dot" : s));
    }, 2500);
  };

  const handleDotClick = () => {
    if (state === "dot" || state === "pill") {
      setState("menu");
    }
  };

  const groups: Record<string, DynamicIslandView[]> = {
    main: [],
    tools: [],
    resources: [],
  };

  for (const v of views) {
    const group = v.group || "tools";
    if (!groups[group]) groups[group] = [];
    groups[group].push(v);
  }

  const groupLabels: Record<string, string> = {
    main: "工作模式",
    tools: "创作工具",
    resources: "资源",
  };

  const groupOrder = ["main", "tools", "resources"] as const;

  return (
    <div
      ref={containerRef}
      className="di-container"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className={`di-island di-state-${state}`}>
        {state === "dot" && (
          <button className="di-dot-button" onClick={handleDotClick} aria-label="打开导航菜单">
            <span className="di-dot-pulse" />
          </button>
        )}

        {state === "pill" && currentView && (
          <button className="di-pill-button" onClick={() => setState("menu")} aria-label={`当前: ${currentView.label}, 点击打开菜单`}>
            <span className="di-pill-icon">
              <Icon name={currentView.icon} size={14} strokeWidth={2} />
            </span>
            <span className="di-pill-text">{currentView.label}</span>
          </button>
        )}

        {state === "menu" && (
          <div className="di-menu">
            <div className="di-menu-header">
              <span className="di-menu-dot" />
              <span className="di-menu-title">导航</span>
            </div>

            {groupOrder.map((g, gi) => {
              const items = groups[g];
              if (!items || items.length === 0) return null;
              return (
                <div key={g} className="di-menu-group">
                  <div className="di-menu-group-label">{groupLabels[g]}</div>
                  {items.map((view) => {
                    const active = view.key === current;
                    return (
                      <button
                        key={view.key}
                        className={`di-menu-item${active ? " is-active" : ""}`}
                        onClick={() => handleSelect(view.key)}
                      >
                        <span className="di-menu-item-icon">
                          <Icon name={view.icon} size={13} strokeWidth={active ? 2 : 1.75} />
                        </span>
                        <span className="di-menu-item-text">{view.label}</span>
                        {view.shortcut && (
                          <span className="di-menu-item-shortcut">{view.shortcut}</span>
                        )}
                      </button>
                    );
                  })}
                  {gi < groupOrder.length - 1 &&
                    groups[groupOrder[gi + 1]]?.length > 0 && (
                      <div className="di-menu-divider" />
                    )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
