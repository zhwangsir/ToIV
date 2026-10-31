import { useEffect, useState } from "react";
import { getAppDef } from "@/lib/desktop/catalog";
import { useDesktopStore } from "@/stores/use-desktop-store";
import { DesktopAppIcon } from "@/components/desktop/desktop-app-icon";

type Props = {
  onStart: () => void;
  onTaskClick: (instanceId: string) => void;
  onOpenPinned: (appId: string) => void;
};

export function DesktopTaskbar({ onStart, onTaskClick, onOpenPinned }: Props) {
  const startOpen = useDesktopStore((s) => s.startOpen);
  const stack = useDesktopStore((s) => s.windows.stack);
  const focusedId = useDesktopStore((s) => s.windows.focusedId);
  const taskbar = useDesktopStore((s) => s.taskbar);
  const installed = useDesktopStore((s) => s.installed);
  const [clock, setClock] = useState(() => formatClock(new Date()));

  useEffect(() => {
    const t = window.setInterval(() => setClock(formatClock(new Date())), 30_000);
    return () => window.clearInterval(t);
  }, []);

  // M2：可卸卸载后从任务栏钉选消失；system 隐藏同理
  const visibleIds = new Set(installed.filter((i) => !i.hidden).map((i) => i.id));
  const pinned = taskbar.order.filter((id) => getAppDef(id) && visibleIds.has(id));

  return (
    <footer className="toiv-desktop-taskbar" role="toolbar" aria-label="任务栏">
      <button type="button" className={`toiv-desktop-taskbar__start${startOpen ? " is-on" : ""}`} onClick={onStart} aria-expanded={startOpen}>
        开始
      </button>
      <div className="toiv-desktop-taskbar__apps">
        {pinned.map((appId) => {
          const def = getAppDef(appId)!;
          const win = stack.find((w) => w.appId === appId);
          const active = win && win.instanceId === focusedId && win.state !== "minimized";
          const open = Boolean(win);
          return (
            <button
              key={appId}
              type="button"
              className={`toiv-desktop-taskbar__btn${open ? " is-open" : ""}${active ? " is-active" : ""}${win?.state === "minimized" ? " is-minimized" : ""}`}
              onClick={() => (win ? onTaskClick(win.instanceId) : onOpenPinned(appId))}
              title={def.name}
            >
              <DesktopAppIcon name={def.icon} className="h-3.5 w-3.5" />
              <span>{def.name}</span>
            </button>
          );
        })}
        {stack
          .filter((w) => !pinned.includes(w.appId))
          .map((w) => {
            const def = getAppDef(w.appId);
            const active = w.instanceId === focusedId && w.state !== "minimized";
            return (
              <button
                key={w.instanceId}
                type="button"
                className={`toiv-desktop-taskbar__btn is-open${active ? " is-active" : ""}${w.state === "minimized" ? " is-minimized" : ""}`}
                onClick={() => onTaskClick(w.instanceId)}
                title={def?.name ?? w.title ?? w.appId}
              >
                {def ? <DesktopAppIcon name={def.icon} className="h-3.5 w-3.5" /> : null}
                <span>{def?.name ?? w.title ?? w.appId}</span>
              </button>
            );
          })}
      </div>
      <div className="toiv-desktop-taskbar__clock" aria-hidden>
        {clock}
      </div>
    </footer>
  );
}

function formatClock(d: Date) {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
