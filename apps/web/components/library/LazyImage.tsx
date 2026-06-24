"use client";

import { useState } from "react";

interface LazyImageProps {
  src: string;
  alt: string;
}

/**
 * 懒加载图片瓦片:原生 loading="lazy" 让浏览器在临近视口时才取图,
 * 解码完成后淡入(避免空白闪烁),首屏更轻。
 * - decoding="async":不阻塞主线程。
 * - 已缓存的图也会触发 onLoad,保证 is-loaded 终态。
 */
export function LazyImage({ src, alt }: LazyImageProps) {
  const [loaded, setLoaded] = useState(false);
  return (
    <img
      className={`lib-lazy${loaded ? " is-loaded" : ""}`}
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      onLoad={() => setLoaded(true)}
    />
  );
}
