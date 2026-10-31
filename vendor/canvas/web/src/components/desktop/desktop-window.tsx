import type { ReactNode } from "react";
import { Minus, Square, X } from "lucide-react";

import type { WindowInstance } from "@/lib/desktop/types";
import { getAppDef } from "@/lib/desktop/catalog";
import { cn } from "@/lib/utils";

type Props = {
  win: WindowInstance;
  focused: boolean;
  activeContent: boolean;
  children?: ReactNode;
  onFocus: () => void;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
};

export function DesktopWindowFrame({
  win,
  focused,
  activeContent,
  children,
  onFocus,
  onMinimize,
  onToggleMaximize,
  onClose,
}: Props) {
  const def = getAppDef(win.appId);
  const title = win.title ?? def?.name ?? win.appId;
  const maximized = win.state === "maximized";
  const style =
    maximized || !win.bounds
      ? undefined
      : {
          left: win.bounds.x,
          top: win.bounds.y,
          width: win.bounds.w,
          height: win.bounds.h,
          zIndex: win.z,
        };

  return (
    <div
      className={cn(
        "toiv-desk-window",
        focused && "is-focused",
        maximized && "is-maximized",
        win.state === "minimized" && "is-minimized",
      )}
      style={style ?? { zIndex: win.z }}
      onMouseDown={onFocus}
      role="dialog"
      aria-label={title}
    >
      <div className="toiv-desk-window__titlebar" onDoubleClick={onToggleMaximize}>
        <div className="toiv-desk-window__title">{title}</div>
        <div className="toiv-desk-window__controls">
          <button type="button" aria-label="最小化" onClick={onMinimize}>
            <Minus className="h-3.5 w-3.5" />
          </button>
          <button type="button" aria-label={maximized ? "还原" : "最大化"} onClick={onToggleMaximize}>
            <Square className="h-3 w-3" />
          </button>
          <button type="button" className="is-close" aria-label="关闭" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="toiv-desk-window__body">
        {activeContent ? children : <div className="grid h-full place-items-center text-xs text-[var(--desk-muted)]">后台挂起 · 点任务栏还原</div>}
      </div>
    </div>
  );
}
