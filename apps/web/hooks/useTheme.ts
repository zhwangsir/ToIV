"use client";

import { useCallback, useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "auto";
export type Theme = "light" | "dark";

function getSystemTheme(): Theme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function getInitialMode(): ThemeMode {
  if (typeof window === "undefined") return "auto";
  const stored = localStorage.getItem("toiv_theme");
  if (stored === "light" || stored === "dark" || stored === "auto") {
    return stored;
  }
  return "auto";
}

function resolveTheme(mode: ThemeMode): Theme {
  return mode === "auto" ? getSystemTheme() : mode;
}

function applyTheme(mode: ThemeMode) {
  const theme = resolveTheme(mode);
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themeMode = mode;
  localStorage.setItem("toiv_theme", mode);
}

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(getInitialMode);
  const [theme, setTheme] = useState<Theme>(() => resolveTheme(getInitialMode()));

  useEffect(() => {
    applyTheme(mode);
    setTheme(resolveTheme(mode));
  }, [mode]);

  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (mode === "auto") {
        setTheme(getSystemTheme());
        document.documentElement.dataset.theme = getSystemTheme();
      }
    };
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [mode]);

  const cycleTheme = useCallback(() => {
    setMode((prev) => {
      if (prev === "light") return "dark";
      if (prev === "dark") return "auto";
      return "light";
    });
  }, []);

  const setThemeMode = useCallback((next: ThemeMode) => {
    setMode(next);
  }, []);

  return {
    mode,
    theme,
    setMode: setThemeMode,
    cycle: cycleTheme,
    isDark: theme === "dark",
    isLight: theme === "light",
    isAuto: mode === "auto",
  };
}
