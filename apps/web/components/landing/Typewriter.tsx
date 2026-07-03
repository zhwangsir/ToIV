"use client";

import { useEffect, useState } from "react";

interface TypewriterProps {
  /** 循环打字的词组。 */
  words: readonly string[];
  /** 每字键入间隔 ms。 */
  typeMs?: number;
  /** 每字删除间隔 ms。 */
  deleteMs?: number;
  /** 一个词打完后的停留 ms。 */
  holdMs?: number;
  className?: string;
}

/** 打字机循环:逐字键入一个词 → 停留 → 逐字删除 → 下一个词,带闪烁光标。 */
export function Typewriter({
  words,
  typeMs = 130,
  deleteMs = 60,
  holdMs = 1400,
  className,
}: TypewriterProps) {
  const [wordIdx, setWordIdx] = useState(0);
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<"typing" | "holding" | "deleting">("typing");

  useEffect(() => {
    const word = words[wordIdx % words.length] ?? "";
    let t: ReturnType<typeof setTimeout>;

    if (phase === "typing") {
      if (text.length < word.length) {
        t = setTimeout(() => setText(word.slice(0, text.length + 1)), typeMs);
      } else {
        t = setTimeout(() => setPhase("holding"), holdMs);
      }
    } else if (phase === "holding") {
      t = setTimeout(() => setPhase("deleting"), 0);
    } else {
      if (text.length > 0) {
        t = setTimeout(() => setText(word.slice(0, text.length - 1)), deleteMs);
      } else {
        setWordIdx((i) => (i + 1) % words.length);
        setPhase("typing");
      }
    }
    return () => clearTimeout(t);
  }, [text, phase, wordIdx, words, typeMs, deleteMs, holdMs]);

  return (
    <span className={className}>
      {text}
      <span className="tw-caret" aria-hidden="true" />
    </span>
  );
}
