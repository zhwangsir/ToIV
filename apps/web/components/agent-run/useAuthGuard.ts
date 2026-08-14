"use client";

/**
 * 独立路由页鉴权守卫:无 token → 回首页(登录态在 "/");
 * 401 由 apiFetch 全局处理(清 token + 跳 "/")。
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getToken } from "@/lib/api";

export function useAuthGuard(): boolean {
  const router = useRouter();
  const [ok, setOk] = useState(false);
  useEffect(() => {
    if (!getToken()) router.replace("/");
    else setOk(true);
  }, [router]);
  return ok;
}
