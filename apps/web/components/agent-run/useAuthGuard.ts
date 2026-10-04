"use client";

/**
 * 独立路由页鉴权守卫:无 token → 登录入口 "/?view=home"(裸 "/" 是官网落地页);
 * 401 由 apiFetch 全局处理(清 token + 跳 "/?view=home")。
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getToken } from "@/lib/api";

export function useAuthGuard(): boolean {
  const router = useRouter();
  const [ok, setOk] = useState(false);
  useEffect(() => {
    if (!getToken()) router.replace("/?view=home");
    else setOk(true);
  }, [router]);
  return ok;
}
