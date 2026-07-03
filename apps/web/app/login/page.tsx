"use client";

import { useCallback, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { AuthScreen } from "@/components/auth/AuthScreen";
import { OrbitField } from "@/components/landing/OrbitField";
import { getToken } from "@/lib/api";
import type { AuthResult } from "@/lib/api";

import "@/components/landing/landing.css";
import "./login.css";

export default function LoginPage() {
  const router = useRouter();

  // 已登录直接回创作台,不必再登
  useEffect(() => {
    if (getToken()) router.replace("/");
  }, [router]);

  // 登录成功:承接落地页能力卡的 ?next=<view> 深链,进对应视图,否则回首页
  const onAuthed = useCallback(
    (_result: AuthResult) => {
      const next = new URLSearchParams(window.location.search).get("next");
      router.push(next ? `/?view=${encodeURIComponent(next)}` : "/");
    },
    [router],
  );

  return (
    <div className="lp login-page">
      <div className="lp-cosmos" aria-hidden="true">
        <div className="lp-glow lp-glow--top" />
        <div className="lp-stars" />
        <OrbitField />
        <div className="lp-horizon" />
      </div>
      <Link className="login-back" href="/">
        <span aria-hidden="true">←</span> 返回首页
      </Link>
      <AuthScreen onAuthed={onAuthed} />
    </div>
  );
}
