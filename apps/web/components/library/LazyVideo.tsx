"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface LazyVideoProps {
  src: string;
  /** 无障碍标签:取作品 prompt。 */
  label: string;
}

/**
 * 懒加载视频瓦片:静息只显首帧海报,IntersectionObserver 临近视口才挂 src(省带宽)。
 * - 悬停自动播放、移出暂停:无声、循环、内联,走 compositor(不动布局)。
 * - 解码出首帧后淡入(避免破图/空白闪烁);左上 ▶ 标记由外层瓦片提供。
 * - preload="metadata" 仅取尺寸/首帧,不预拉整段。
 */
export function LazyVideo({ src, label }: LazyVideoProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [near, setNear] = useState(false);
  const [ready, setReady] = useState(false);

  // 临近视口才挂载 src(IntersectionObserver,单次触发后断开)
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin: "400px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const play = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    // play() 返回 Promise;静默吞掉自动播放被拒(无声 + muted 通常允许)
    void v.play().catch(() => undefined);
  }, []);

  const pause = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    // 回到首帧,下次悬停从头播
    try {
      v.currentTime = 0;
    } catch {
      /* 某些浏览器在未就绪时设置 currentTime 会抛错,忽略 */
    }
  }, []);

  return (
    <div
      ref={wrapRef}
      className="lib-video"
      onPointerEnter={play}
      onPointerLeave={pause}
    >
      {near ? (
        <video
          ref={videoRef}
          className={`lib-lazy${ready ? " is-loaded" : ""}`}
          src={src}
          muted
          loop
          playsInline
          preload="metadata"
          aria-label={label}
          onLoadedData={() => setReady(true)}
        />
      ) : null}
    </div>
  );
}
