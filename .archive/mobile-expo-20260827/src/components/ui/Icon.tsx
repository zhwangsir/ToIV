/**
 * 全局唯一图标入口（🔒 用户硬性规则 + 开发规范禁令 1）
 * - 唯一图标源 lucide-react-native；白名单注册表保证 tree-shaking 与可审计
 * - 新增图标 = 在 registry 加一行，禁止组件内直接 import lucide
 * - 用法：<Icon name="Sparkles" size={24} />
 */
import {
  ArrowUp,
  AudioLines,
  Bot,
  Box,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  Clock,
  Download,
  Eye,
  EyeOff,
  File,
  Film,
  FolderOpen,
  GitFork,
  Heart,
  History,
  Image,
  ImagePlus,
  Images,
  Info,
  Layers,
  ListVideo,
  LoaderCircle,
  Lock,
  LogOut,
  Mail,
  MessageCircle,
  Minus,
  Moon,
  Music,
  Palette,
  Paperclip,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  SendHorizontal,
  Settings,
  Share2,
  SlidersHorizontal,
  Sparkles,
  Square,
  Sun,
  SunMoon,
  Trash2,
  Upload,
  User,
  UserRound,
  Video,
  Wand2,
  WifiOff,
  X,
  type LucideIcon,
} from 'lucide-react-native';

import { useAppTheme } from '@/hooks/use-app-theme';

const registry = {
  ArrowUp,
  AudioLines,
  Bot,
  Box,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  Clock,
  Download,
  Eye,
  EyeOff,
  File,
  Film,
  FolderOpen,
  GitFork,
  Heart,
  History,
  Image,
  ImagePlus,
  Images,
  Info,
  Layers,
  ListVideo,
  LoaderCircle,
  Lock,
  LogOut,
  Mail,
  MessageCircle,
  Minus,
  Moon,
  Music,
  Palette,
  Paperclip,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  SendHorizontal,
  Settings,
  Share2,
  SlidersHorizontal,
  Sparkles,
  Square,
  Sun,
  SunMoon,
  Trash2,
  Upload,
  User,
  UserRound,
  Video,
  Wand2,
  WifiOff,
  X,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof registry;

export interface IconProps {
  name: IconName;
  /** 指南推荐 20/24 两档；TabBar 等系统回调场景可传任意值 */
  size?: number;
  /** 默认取主题 text 色，禁止裸写 hex */
  color?: string;
  /** 指南：描边 1.5-2 */
  strokeWidth?: number;
  testID?: string;
  accessibilityLabel?: string;
}

export function Icon({
  name,
  size = 24,
  color,
  strokeWidth = 1.75,
  testID,
  accessibilityLabel,
}: IconProps) {
  const { colors } = useAppTheme();
  const Cmp: LucideIcon = registry[name];
  return (
    <Cmp
      size={size}
      color={color ?? colors.text}
      strokeWidth={strokeWidth}
      testID={testID}
      accessibilityLabel={accessibilityLabel}
    />
  );
}
