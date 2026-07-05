"use client";

import { memo, useCallback } from "react";
import { motion } from "framer-motion";

import { NavIcon } from "@/components/ui/NavIcon";

import { AccountSettings } from "./AccountSettings";
import { useActivity } from "./ActivityContext";

export interface TopbarView {
  key: string;
  label: string;
  icon: string;
}

interface TopbarProps<K extends string> {
  views: readonly TopbarView[];
  current: K;
  onSelect: (key: K) => void;
  account?: string;
  onLogout: () => void;
}

const GROUPS = {
  main: { label: "创作", keys: ["assistant", "create", "canvas", "manju", "dub"] },
  resources: { label: "资源", keys: ["library", "models"] },
  system: { label: "系统", keys: ["admin"] },
};

const TRANSITION = { type: "spring", stiffness: 420, damping: 32 };

const ViewButton = memo(function ViewButton({
  view,
  isActive,
  onSelect,
}: {
  view: TopbarView;
  isActive: boolean;
  onSelect: (key: string) => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      aria-label={view.label}
      title={view.label}
      className={isActive ? "active" : ""}
      onClick={() => onSelect(view.key)}
    >
      {isActive && (
        <motion.span
          className="nav-pill"
          layoutId="nav-pill"
          aria-hidden="true"
          transition={TRANSITION}
        />
      )}
      <NavIcon name={view.icon} />
      <span>{view.label}</span>
    </button>
  );
});

export function Topbar<K extends string>({
  views,
  current,
  onSelect,
  account,
  onLogout,
}: TopbarProps<K>) {
  const { activity } = useActivity();
  const busy = activity?.phase === "running";

  const handleSelect = useCallback((key: string) => onSelect(key as K), [onSelect]);

  const groups = Object.entries(GROUPS)
    .map(([key, group]) => ({
      key,
      label: group.label,
      items: views.filter((v) => group.keys.includes(v.key)),
    }))
    .filter((g) => g.items.length > 0);

  return (
    <header className="topbar">
      <div className="brand">
        To<span className="mark">IV</span>
        <span className="sub">AI STUDIO</span>
      </div>

      <nav className="modal-nav" role="tablist" aria-label="主模块">
        {groups.map((group) => (
          <div key={group.key} className="nav-group" role="group" aria-label={group.label}>
            {group.items.map((view) => (
              <ViewButton
                key={view.key}
                view={view}
                isActive={view.key === current}
                onSelect={handleSelect}
              />
            ))}
          </div>
        ))}
      </nav>

      <div className="topbar-right">
        <div className={`status-pill${busy ? " is-busy" : ""}`}>
          <span className="led" aria-hidden="true" />
          {busy ? "生成中" : "就绪"}
        </div>
        <AccountSettings account={account} onLogout={onLogout} className="topbar-account-btn" />
      </div>
    </header>
  );
}
