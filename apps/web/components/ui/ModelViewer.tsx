"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { LoadingBlock } from "./LoadingBlock";

/**
 * <model-viewer> 自定义元素的 JSX 属性声明。
 * React 19 起 IntrinsicElements 挂在 React.JSX 命名空间(全局 JSX 命名空间已移除)。
 */
type ModelViewerJSXProps = React.DetailedHTMLProps<
  React.HTMLAttributes<HTMLElement>,
  HTMLElement
> & {
  src?: string;
  "camera-controls"?: boolean;
  "auto-rotate"?: boolean;
  "shadow-intensity"?: string;
  exposure?: string;
  loading?: "auto" | "lazy" | "eager";
};

declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      "model-viewer": ModelViewerJSXProps;
    }
  }
}

interface ModelViewerProps {
  /** GLB/GLTF 产物 URL(带签名 token,与图片产物同规则) */
  src: string;
  /** 自动环绕旋转,默认开,可关 */
  autoRotate?: boolean;
  className?: string;
}

/**
 * 浏览器内 3D 模型查看器(@google/model-viewer 封装)。
 * - 懒加载:useEffect 里动态 import,model-viewer 代码进独立 async chunk,不进首屏主包;
 *   SSR/未就绪渲染 LoadingBlock(等价 ssr:false 语义,无 hydration 风险);
 * - 尺寸:100% 充满父容器,高度由调用方容器定;
 * - 失败:动态 import 或模型加载 error 事件 → 错误占位,不白屏。
 */
export function ModelViewer({ src, autoRotate = true, className }: ModelViewerProps) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const elRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    import("@google/model-viewer")
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 模型资源加载失败(404/坏文件):model-viewer 派发 error 事件
  useEffect(() => {
    const el = elRef.current;
    if (!ready || !el) return;
    const onError = () => setFailed(true);
    el.addEventListener("error", onError);
    return () => el.removeEventListener("error", onError);
  }, [ready, src]);

  if (failed) {
    return (
      <div className={["ui-model-viewer", "is-error", className].filter(Boolean).join(" ")}>
        <Icon name="error" size={20} strokeWidth={1.4} />
        <span className="ui-model-viewer-error-text">3D 模型加载失败，请下载后用本地查看器打开</span>
      </div>
    );
  }
  if (!ready) {
    return (
      <div className={["ui-model-viewer", "is-loading", className].filter(Boolean).join(" ")}>
        <LoadingBlock variant="block" />
      </div>
    );
  }
  return (
    <div className={["ui-model-viewer", className].filter(Boolean).join(" ")}>
      <model-viewer
        ref={elRef}
        src={src}
        camera-controls
        auto-rotate={autoRotate || undefined}
        shadow-intensity="1"
        exposure="1"
        loading="lazy"
        style={{ width: "100%", height: "100%", display: "block" }}
      />
    </div>
  );
}
