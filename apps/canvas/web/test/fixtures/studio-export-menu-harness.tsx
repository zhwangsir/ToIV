import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";

import { StudioExportMenu } from "@/components/toiv/studio-export-menu";
import { getAntThemeConfig } from "@/lib/app-theme";

// P2-9 导出下拉 harness:真实 StudioExportMenu + 真实 client(axios)直连测试服务器的
// 本地 mock /api(不连真实后端/GPU);暗色 + 完整 CSS,验证菜单展开与回执文案。
document.documentElement.classList.add("dark");

function Panel({ testId, projectId, shots }: { testId: string; projectId: string; shots: { final_clip_url?: string | null }[] }) {
    return (
        <section
            data-testid={testId}
            style={{
                width: 420,
                borderRadius: 12,
                border: "1px solid var(--border, #26262e)",
                background: "var(--card, #141419)",
                padding: 12,
            }}
        >
            <StudioExportMenu projectId={projectId} shots={shots} />
        </section>
    );
}

createRoot(document.getElementById("root")!).render(
    <ConfigProvider locale={zhCN} theme={getAntThemeConfig(true)}>
        <App>
            <main
                style={{
                    minHeight: "100vh",
                    display: "flex",
                    flexDirection: "column",
                    gap: 16,
                    padding: 16,
                    background: "var(--background, #0b0b0f)",
                }}
            >
                <Panel testId="export-ready" projectId="p-ok" shots={[{ final_clip_url: "/api/studio/files/clip-1.mp4" }]} />
                <Panel testId="export-error" projectId="p-err" shots={[{ final_clip_url: "/api/studio/files/clip-2.mp4" }]} />
                <Panel testId="export-empty" projectId="p-none" shots={[]} />
            </main>
        </App>
    </ConfigProvider>,
);
