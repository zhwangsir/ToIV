import { DESKTOP_APP_CATALOG, getAppDef } from "@/lib/desktop/catalog";
import { useDesktopStore } from "@/stores/use-desktop-store";
import { DesktopAppIcon } from "@/components/desktop/desktop-app-icon";

type Props = {
  onOpen: (appId: string) => void;
};

export function DesktopIcons({ onOpen }: Props) {
  const installed = useDesktopStore((s) => s.installed);
  const placements = useDesktopStore((s) => s.placements);

  const visible = installed
    .filter((i) => !i.hidden)
    .map((i) => {
      const def = getAppDef(i.id) ?? DESKTOP_APP_CATALOG.find((a) => a.id === i.id);
      const place = placements.find((p) => p.targetId === i.id);
      return { id: i.id, def, row: place?.row ?? 999, col: place?.col ?? 0 };
    })
    .filter((x) => x.def)
    .sort((a, b) => a.col - b.col || a.row - b.row);

  return (
    <div className="toiv-desktop-icons" aria-label="桌面图标">
      {visible.map((item) => (
        <button
          key={item.id}
          type="button"
          className="toiv-desktop-icon"
          onDoubleClick={() => onOpen(item.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onOpen(item.id);
          }}
          title={item.def!.name}
        >
          <span className="toiv-desktop-icon__glyph" aria-hidden>
            <DesktopAppIcon name={item.def!.icon} className="h-5 w-5" />
          </span>
          <span className="toiv-desktop-icon__label">{item.def!.name}</span>
        </button>
      ))}
    </div>
  );
}
