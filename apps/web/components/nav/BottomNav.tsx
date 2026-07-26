"use client";

import Link from "next/link";
import { Icon, type IconName } from "@/components/ui/Icon";

export interface BottomNavItem {
  key: string;
  label: string;
  icon: IconName;
  isCta?: boolean;
}

interface BottomNavProps {
  items: BottomNavItem[];
  current: string;
  onSelect: (key: string) => void;
  ctaAction?: () => void;
}

export function BottomNav({ items, current, onSelect, ctaAction }: BottomNavProps) {
  return (
    <nav className="app-bottom-nav" role="navigation" aria-label="底部导航">
      {items.map((item) => {
        const isActive = item.key === current;
        if (item.isCta) {
          return (
            <button
              key={item.key}
              type="button"
              className="bottom-nav-cta"
              onClick={ctaAction}
              aria-label={item.label}
            >
              <Icon name={item.icon} size={22} />
            </button>
          );
        }
        return (
          <Link
            key={item.key}
            href={`/?view=${item.key}`}
            className={`bottom-nav-item${isActive ? " is-active" : ""}`}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.button !== 0) return;
              e.preventDefault();
              onSelect(item.key);
            }}
            aria-current={isActive ? "page" : undefined}
          >
            <Icon name={item.icon} size={20} />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
