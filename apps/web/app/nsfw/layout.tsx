import type { Metadata } from "next";

// 隐藏页:不被搜索引擎索引,标题不泄露用途。
export const metadata: Metadata = {
  title: "·",
  robots: { index: false, follow: false },
};

export default function NsfwLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
