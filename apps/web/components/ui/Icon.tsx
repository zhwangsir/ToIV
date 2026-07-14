"use client";

import {
  ArrowUp,
  AlertCircle,
  AlertTriangle,
  Box,
  Boxes,
  BrainCircuit,
  Brush,
  Camera,
  Check,
  CheckCircle2,
  Clapperboard,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  Database,
  Download,
  FileText,
  Film,
  FolderOpen,
  Image as ImageIcon,
  KanbanSquare,
  LayoutGrid,
  Link as LinkIcon,
  Loader2,
  Lock,
  Menu,
  MessageSquare,
  Mic,
  Minus,
  Music,
  Package,
  Palette,
  Play,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Trash2,
  Upload,
  Video,
  X,
  type LucideIcon,
} from "lucide-react";

const ICON_MAP = {
  // 侧栏导航(10)
  chat: MessageSquare,
  create: Sparkles,
  canvas: LayoutGrid,
  manju: Clapperboard,
  dub: Mic,
  train: BrainCircuit,
  library: FolderOpen,
  backlot: KanbanSquare,
  models: Boxes,
  admin: Settings,
  // 通用操作(8)
  send: ArrowUp,
  upload: Upload,
  download: Download,
  delete: Trash2,
  close: X,
  menu: Menu,
  search: Search,
  refresh: RefreshCw,
  // 状态(5)
  success: CheckCircle2,
  error: AlertCircle,
  loading: Loader2,
  playing: Play,
  queued: Clock,
  // 内容类型(6)
  image: ImageIcon,
  video: Video,
  audio: Music,
  model3d: Box,
  file: FileText,
  link: LinkIcon,
  // NSFW 专区(4)
  warning: AlertTriangle,
  lock: Lock,
  "chevron-down": ChevronDown,
  "chevron-right": ChevronRight,
  // 表单/操作(2):ModelPicker 勾选 + OptimizeButton 主图标
  check: Check,
  sparkles: Sparkles,
  // 智能体图标键(11 个内置智能体用):camera/palette/film/brush/cpu/minus/package/mic/database
  camera: Camera,
  palette: Palette,
  film: Film,
  brush: Brush,
  cpu: Cpu,
  minus: Minus,
  package: Package,
  mic: Mic,
  database: Database,
} as const;

export type IconName = keyof typeof ICON_MAP;

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
}

/** 统一图标组件:全项目通过 <Icon name="chat" /> 调用。
 * 底层 lucide-react,完美 tree-shaking,单一线性风格。
 * 全项目唯一图标源,禁止使用 emoji / 其他图标库 / 自定义 SVG。 */
export function Icon({ name, size = 18, className, strokeWidth = 1.75 }: IconProps) {
  const Cmp: LucideIcon = ICON_MAP[name];
  return <Cmp size={size} className={className} strokeWidth={strokeWidth} aria-hidden="true" />;
}
