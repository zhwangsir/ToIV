"use client";

import { Icon } from "@/components/ui/Icon";

/** 风格卡(存于 localStorage `toiv_style_cards`)。 */
export interface StyleCard {
  id: string;
  name: string;
  /** 作品图 URL;音频等无产物作品为空串,渲染占位图标 */
  thumb: string;
  /** 该作品的 prompt 截取(≤500 字),注入优化管线用 */
  hint: string;
}

interface StyleBarProps {
  cards: StyleCard[];
  /** 点击卡片:把 hint 注入优化提示词管线(由父级写 localStorage + toast) */
  onApply: (card: StyleCard) => void;
  onDelete: (card: StyleCard) => void;
}

/**
 * 作品库顶部的风格库横条(WS4)。
 * 空态不渲染整条;卡片 = 缩略图 + 名称 + 删除小叉,横向滚动。
 * 视觉样式在 app/styles/library.css(.lib-style-*)。
 */
export function StyleBar({ cards, onApply, onDelete }: StyleBarProps) {
  if (cards.length === 0) return null;
  return (
    <div className="lib-style-bar" role="region" aria-label="风格库">
      <span className="lib-style-bar-kicker">风格库</span>
      <div className="lib-style-track">
        {cards.map((c) => (
          <div key={c.id} className="lib-style-card">
            <button
              type="button"
              className="lib-style-card-hit"
              title={`注入风格「${c.name}」`}
              aria-label={`注入风格「${c.name}」`}
              onClick={() => onApply(c)}
            >
              {c.thumb ? (
                <img
                  className="lib-style-thumb"
                  src={c.thumb}
                  alt=""
                  loading="lazy"
                />
              ) : (
                <span
                  className="lib-style-thumb lib-style-thumb-empty"
                  aria-hidden="true"
                >
                  <Icon name="palette" size={15} strokeWidth={1.6} />
                </span>
              )}
              <span className="lib-style-name">{c.name}</span>
            </button>
            <button
              type="button"
              className="lib-style-delete"
              title={`删除风格「${c.name}」`}
              aria-label={`删除风格「${c.name}」`}
              onClick={() => onDelete(c)}
            >
              <Icon name="close" size={11} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
