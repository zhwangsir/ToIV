import { DESKTOP_APP_CATALOG } from "@/lib/desktop/catalog";
import { useDesktopStore } from "@/stores/use-desktop-store";
import { DesktopAppIcon } from "@/components/desktop/desktop-app-icon";
import { useNavigate, useSearchParams } from "react-router";

/** OS 应用商店 — id app-store · 路由 /desktop/store · ≠ 工具台 / ≠ 工作流 wf: */
export default function DesktopAppStorePage() {
  const installed = useDesktopStore((s) => s.installed);
  const installApp = useDesktopStore((s) => s.installApp);
  const uninstallApp = useDesktopStore((s) => s.uninstallApp);
  const openApp = useDesktopStore((s) => s.openApp);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const focusAppId = params.get("app");

  const rows = DESKTOP_APP_CATALOG.filter((a) => a.catalog);

  return (
    <div className="toiv-app-store">
      <h1>应用商店</h1>
      <p className="sub">安装到桌面 · 卸载后图标消失（系统应用仅隐藏）· 已安装。工作流（Comfy/RH）走「工作流」分轨，不在此上架。</p>
      <div className="toiv-app-store__grid">
        {rows.map((app) => {
          const row = installed.find((i) => i.id === app.id);
          const isInstalled = Boolean(row && !row.hidden);
          const focused = focusAppId === app.id;
          return (
            <article key={app.id} className={focused ? "toiv-app-store__card is-focus" : "toiv-app-store__card"} data-app-id={app.id} data-focus={focused ? "1" : undefined}>
              <div className="flex items-center gap-2">
                <span className="toiv-desktop-icon__glyph">
                  <DesktopAppIcon name={app.icon} className="h-5 w-5" />
                </span>
                <h3>{app.name}</h3>
              </div>
              <p>{app.description ?? ""}</p>
              <div className="toiv-app-store__meta">
                {app.system ? "系统应用" : "可卸载"} · {app.entry}
                {focused && !isInstalled ? " · 未安装（深链未装回）" : ""}
              </div>
              <div className="toiv-app-store__actions">
                {isInstalled ? (
                  <>
                    <button
                      type="button"
                      className="primary"
                      onClick={() => {
                        openApp(app.id, app.entry);
                        navigate(app.entry);
                      }}
                    >
                      打开
                    </button>
                    <button type="button" onClick={() => uninstallApp(app.id)}>
                      {app.system ? "隐藏" : "卸载"}
                    </button>
                  </>
                ) : (
                  <button type="button" className="primary" onClick={() => installApp(app.id)}>
                    安装
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
