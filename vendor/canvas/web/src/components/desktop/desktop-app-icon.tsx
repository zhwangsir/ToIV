import type { ComponentType } from "react";
import {
  BarChart3,
  Bot,
  Clapperboard,
  Image,
  LayoutGrid,
  Library,
  ListChecks,
  Mic,
  Plug,
  PlusSquare,
  Settings2,
  Store,
  WandSparkles,
  Wrench,
} from "lucide-react";

const MAP: Record<string, ComponentType<{ className?: string; strokeWidth?: number }>> = {
  wand: WandSparkles,
  clapperboard: Clapperboard,
  "list-checks": ListChecks,
  wrench: Wrench,
  settings: Settings2,
  library: Library,
  store: Store,
  layout: LayoutGrid,
  "plus-square": PlusSquare,
  bot: Bot,
  chart: BarChart3,
  plug: Plug,
  image: Image,
  mic: Mic,
};

export function DesktopAppIcon({ name, className }: { name: string; className?: string }) {
  const Icon = MAP[name] ?? LayoutGrid;
  return <Icon className={className} strokeWidth={1.75} />;
}
