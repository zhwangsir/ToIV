"use client";

import {
  ArrowUp,
  AlertCircle,
  AlertTriangle,
  BarChart3,
  Box,
  Boxes,
  BrainCircuit,
  Brush,
  Camera,
  Check,
  CheckCircle2,
  Clapperboard,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Contrast,
  Cpu,
  Crop,
  Database,
  Download,
  Eraser,
  Eye,
  FileText,
  FileVideoCamera,
  Film,
  FlipHorizontal2,
  FolderOpen,
  Grid3x3,
  GripVertical,
  Heart,
  History,
  Home,
  Image as ImageIcon,
  Info,
  KanbanSquare,
  Layers,
  LayoutGrid,
  Link as LinkIcon,
  Loader2,
  Lock,
  Maximize,
  Menu,
  MessageSquare,
  Mic,
  Minimize,
  Minus,
  Monitor,
  Moon,
  Music,
  Package,
  Palette,
  PanelRight,
  Pause,
  Phone,
  PhoneOff,
  Play,
  Plus,
  Redo2,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Save,
  Scissors,
  Search,
  Settings,
  Share2,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Square,
  Sparkles,
  Sun,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Tv,
  Type,
  Undo2,
  Upload,
  User,
  Users,
  Video,
  Volume2,
  VolumeX,
  Wand2,
  Workflow,
  X,
  Zap,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";

const ICON_MAP = {
  // 侧栏导航(11)
  chat: MessageSquare,
  create: Sparkles,
  canvas: LayoutGrid,
  manju: Clapperboard,
  drama: Tv,
  dub: Mic,
  train: BrainCircuit,
  library: FolderOpen,
  backlot: KanbanSquare,
  models: Boxes,
  admin: Settings,
  // 设置入口(§4.9 设置视图;与 admin 同图标,语义化别名)
  settings: Settings,
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
  "chevron-left": ChevronLeft,
  "chevron-right": ChevronRight,
  "chevron-up": ChevronUp,
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
  // 短剧工作室 M1/M2/M4 追加:三视图 / 宫格分镜 / 创作过程回放
  user: User,
  users: Users,
  eye: Eye,
  grid: Grid3x3,
  filevideo: FileVideoCamera,
  history: History,
  // 短剧工作室 M2 追加:资产库道具/通用方块
  box: Box,
  // 短剧工作室 M3 追加:导演台拖拽手柄
  drag: GripVertical,
  // 短剧工作室 M5 追加:播放洞察
  barchart: BarChart3,
  alert: AlertTriangle,
  // 主题切换
  sun: Sun,
  moon: Moon,
  monitor: Monitor,
  // 模式切换/布局
  workflow: Workflow,
  "panel-right": PanelRight,
  home: Home,
  plus: Plus,
  // 别名:新设计直接复用已有图标
  clapperboard: Clapperboard,
  // DramaStudio Agent 入口按钮用(语义化别名)
  braincircuit: BrainCircuit,
  // 创作页面提示
  zap: Zap,
  info: Info,
  // 数字人对话
  phone: Phone,
  "phone-off": PhoneOff,
  square: Square,
  // 短剧播放器 W3 追加
  play: Play,
  pause: Pause,
  volume: Volume2,
  mute: VolumeX,
  maximize: Maximize,
  minimize: Minimize,
  heart: Heart,
  replay: RotateCcw,
  share: Share2,
  "thumbs-up": ThumbsUp,
  "thumbs-down": ThumbsDown,
  // 编辑器(M4 图片/视频编辑模块)
  crop: Crop,
  scissors: Scissors,
  sliders: SlidersHorizontal,
  type: Type,
  undo: Undo2,
  redo: Redo2,
  eraser: Eraser,
  wand: Wand2,
  layers: Layers,
  "rotate-cw": RotateCw,
  flip: FlipHorizontal2,
  contrast: Contrast,
  "zoom-in": ZoomIn,
  "zoom-out": ZoomOut,
  save: Save,
  "skip-back": SkipBack,
  "skip-forward": SkipForward,
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
  const Cmp: LucideIcon | undefined = ICON_MAP[name];
  if (!Cmp) {
    console.warn(`[Icon] unknown icon name: ${name}`);
    return <span className={className} style={{ width: size, height: size, display: "inline-block" }} aria-hidden="true" />;
  }
  const isLoading = name === "loading";
  const finalClass = [className, isLoading ? "icon-loading-spin" : null].filter(Boolean).join(" ");
  return <Cmp size={size} className={finalClass || undefined} strokeWidth={strokeWidth} aria-hidden="true" />;
}
