"use client";

/**
 * 懒加载视频(P1-14)。
 *
 * 现状问题:作品库/胶片条等列表里每个视频卡都 preload="metadata",
 * 首屏一次性发出几十个 Range 请求(60 卡 = 60 次),挤占首屏带宽。
 *
 * 本组件初始渲染 preload="none"(零请求),仅在以下任一时机一次性切回
 * "metadata" 拉取首帧:
 *   - 进入视口(IntersectionObserver,rootMargin 200px 提前量);
 *   - 鼠标悬停(触屏无 hover,由 IO 覆盖)。
 * 点击播放、controls、跳转灯箱等行为不受影响(播放动作本身会触发加载)。
 */
import { useEffect, useRef } from "react";

export function LazyVideo({
  onMouseEnter,
  ...rest
}: React.VideoHTMLAttributes<HTMLVideoElement>) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const enable = () => {
      if (el.preload === "none") {
        el.preload = "metadata";
        el.load(); // 改 preload 不保证触发加载,显式重启资源选择
      }
    };
    if (typeof IntersectionObserver === "undefined") {
      enable(); // 老浏览器兜底:直接按原行为加载
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          enable();
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <video
      {...rest}
      ref={ref}
      preload="none"
      onMouseEnter={(e) => {
        const el = e.currentTarget;
        if (el.preload === "none") {
          el.preload = "metadata";
          el.load();
        }
        onMouseEnter?.(e);
      }}
    />
  );
}
