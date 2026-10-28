import { DESKTOP_APP_CATALOG, getAppDef } from "@/lib/desktop/catalog";
import { downloadJson } from "@/lib/desktop/backup";
import { useDesktopStore } from "@/stores/use-desktop-store";
import { DesktopAppIcon } from "@/components/desktop/desktop-app-icon";

type Props = {
  onOpen: (appId: string) => void;
  onOpenStore: () => void;
};

export function DesktopStartMenu({ onOpen, onOpenStore }: Props) {
  const installed = useDesktopStore((s) => s.installed);
  const exportBackup = useDesktopStore((s) => s.exportBackup);
  const importBackup = useDesktopStore((s) => s.importBackup);
  const setStartOpen = useDesktopStore((s) => s.setStartOpen);

  const items = installed
    .filter((i) => !i.hidden)
    .map((i) => getAppDef(i.id))
    .filter(Boolean)
    .sort((a, b) => a!.name.localeCompare(b!.name, "zh"));

  const onExport = () => {
    const data = exportBackup();
    downloadJson(`toiv-desktop-backup-${data.exportedAt.slice(0, 10)}.json`, data);
    setStartOpen(false);
  };

  const onImport = async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const raw = JSON.parse(text) as unknown;
        const result = importBackup(raw);
        if (!result.ok) window.alert(result.error);
      } catch {
        window.alert("导入失败：无法解析 JSON");
      }
      setStartOpen(false);
    };
    input.click();
  };

  return (
    <div className="toiv-desktop-start" role="menu" aria-label="开始菜单">
      <div className="toiv-desktop-start__head">ToIV</div>
      <div className="toiv-desktop-start__list">
        {items.map((def) => (
          <button key={def!.id} type="button" className="toiv-desktop-start__item" role="menuitem" onClick={() => onOpen(def!.id)}>
            <DesktopAppIcon name={def!.icon} className="h-4 w-4 opacity-80" />
            <span>{def!.name}</span>
          </button>
        ))}
        {items.length === 0 ? (
          <div className="toiv-desktop-start__item" style={{ color: "var(--desk-muted)" }}>
            尚未安装应用 — 打开应用商店
          </div>
        ) : null}
      </div>
      <div className="toiv-desktop-start__foot">
        <button type="button" onClick={onImport}>
          导入
        </button>
        <button type="button" onClick={onExport}>
          导出
        </button>
        <button type="button" className="primary" onClick={onOpenStore}>
          应用商店
        </button>
      </div>
      {/* catalog length sanity: {DESKTOP_APP_CATALOG.length} */}
      <span className="sr-only">{DESKTOP_APP_CATALOG.length} catalog apps</span>
    </div>
  );
}
