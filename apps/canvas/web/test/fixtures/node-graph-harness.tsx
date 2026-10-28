import { createRoot } from "react-dom/client";

import { CanvasNode } from "@/components/canvas/canvas-node";
import { ConnectionPath } from "@/components/canvas/canvas-connections";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

const params = new URLSearchParams(window.location.search);
const light = params.has("light");
document.documentElement.classList.toggle("dark", !light);
useThemeStore.getState().setTheme(light ? "light" : "dark");

const script: CanvasNodeData = { id: "script", type: CanvasNodeType.Text, title: "剧本拆镜", position: { x: 40, y: 100 }, width: 300, height: 190, metadata: { content: "雨夜天台，主角重逢。\n镜头缓慢推近。" } };
const video: CanvasNodeData = { id: "video", type: CanvasNodeType.Video, title: "镜头生成", position: { x: 460, y: 220 }, width: 300, height: 190, metadata: {} };
const connection: CanvasConnection = { id: "script-video", fromNodeId: script.id, toNodeId: video.id };
const shared = { scale: 1, isRelated: false, isFocusRelated: false, isConnectionTarget: false, showImageInfo: false, onMouseDown: () => {}, onHoverStart: () => {}, onHoverEnd: () => {}, onConnectStart: () => {}, onResize: () => {}, onContentChange: () => {}, onContextMenu: () => {} };

createRoot(document.getElementById("root")!).render(
    <main className="canvas-editor-shell" style={{ position: "relative", width: 960, height: 560, overflow: "hidden", background: canvasThemes[light ? "light" : "dark"].canvas.background }}>
        <svg width="960" height="560" style={{ position: "absolute", inset: 0 }}>
            <ConnectionPath connection={connection} from={script} to={video} active onSelect={() => {}} />
        </svg>
        <CanvasNode data={script} {...shared} isSelected={false} />
        <CanvasNode data={video} {...shared} isSelected />
    </main>,
);
