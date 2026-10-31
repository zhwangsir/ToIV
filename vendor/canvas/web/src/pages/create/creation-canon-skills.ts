import { publicAsset } from "@/lib/app-base";
import type { CreationMode } from "./creation-types";

/**
 * F10 技能 tab:ToIV 正典技能直出目录。
 *
 * 真源是服务端正典注册表 apps/api/app/skills/<name>/SKILL.md(YAML frontmatter)。
 * 该注册表当前没有 HTTP 列表端点(仅服务端内部 render),且 F10 波次冻结
 * apps/api,所以这里按 frontmatter 1:1 静态镜像(name/kind/version/author/
 * triggers),后续 api 开出 GET /api/skills 后应改为动态拉取(P-14:静态清单
 * 会随注册表增长过期,新增正典技能须同步本文件)。
 *
 * 「直出」= 点击卡片把该技能的直出提示词模板填入创作输入框,用户补齐
 * 槽位后直接生成;模板文案与各 SKILL.md 的 inputs 槽位一一对应。
 */
export type CreationCanonSkill = {
    id: string;
    name: string;
    /** 精简展示描述(源自 frontmatter description,截短) */
    description: string;
    /** frontmatter kind 的中文标签 */
    kindLabel: string;
    triggers: string[];
    version: string;
    author: string;
    /** 直出落到的创作模式 */
    mode: CreationMode;
    /** 直出提示词模板(含待补槽位) */
    prompt: string;
    image: string;
};

export const creationCanonSkills: CreationCanonSkill[] = [
    {
        id: "editorial-mg-pv",
        name: "editorial-mg-pv",
        description: "纯二维日系硬边赛璐璐 × 高级时装杂志 Editorial MG 风格宣传 PV 的完整分段提示词模板",
        kindLabel: "模板",
        triggers: ["Editorial MG", "MG PV", "游戏宣传PV", "杂志风", "赛璐璐", "标题落版"],
        version: "1.0.0",
        author: "dgmt",
        mode: "video",
        prompt: "按 editorial-mg-pv 正典技能(纯二维硬边赛璐璐 × 时装杂志 Editorial MG 风宣传 PV)直出:武器/道具驱动的二维视觉系统、母题变形链转场、多段缝合、三段式标题落版。角色设定:【发型/眼睛/服装/气质】;标志性道具:【道具】;主色 5 色+单强调色:【hex】;落版标题:【文案】;时长 30 秒,画幅 16:9。",
        image: publicAsset("/short-drama-styles/cyberpunk-neon.jpg"),
    },
    {
        id: "h3-prompt-writer",
        name: "h3-prompt-writer",
        description: "为 MiniMax H3 编写可直接粘贴的中文视频提示词(6/10/15 秒、文戏/武戏/九宫格三流程)",
        kindLabel: "提示词编写",
        triggers: ["MiniMax H3", "H3提示词", "视频提示词", "文戏", "武戏", "九宫格"],
        version: "1.0.0",
        author: "dgmt",
        mode: "text",
        prompt: "按 h3-prompt-writer 正典技能(H3 6/10/15 秒视频提示词,文戏/武戏/九宫格三流程)为下面的故事写一份可直接粘贴进 MiniMax H3 的紧凑成品提示词(时长:【6|10|15】秒;画幅:【16:9|9:16】;流程:【drama|action|grid】):",
        image: publicAsset("/short-drama-styles/suspense-noir.jpg"),
    },
    {
        id: "h3-multi-ref",
        name: "h3-multi-ref",
        description: "H3 @图片N 多参考图标准模板:角色三视图/场景/装备/九宫格母版的绝对开头引用行",
        kindLabel: "模板",
        triggers: ["参考图", "多参考图", "图片引用", "三视图", "角色一致性"],
        version: "1.0.0",
        author: "dgmt",
        mode: "text",
        prompt: "按 h3-multi-ref 正典模板生成 H3 多参考图提示词开头块:绝对开头用一整行连续 @图片N 引用(格式 @图片1作为XX @图片2作为XX…),参考图顺序即编号顺序,随后进入正文。我的参考图与角色/场景分配:",
        image: publicAsset("/short-drama-styles/urban-live-action.jpg"),
    },
    {
        id: "h3-seam-polish",
        name: "h3-seam-polish",
        description: "分镜接缝丝滑增强 modifier:「预备—交接—缓冲」三阶段 + 速度继承,消除生硬跳切",
        kindLabel: "修改器",
        triggers: ["转场", "接缝", "matchcut", "匹配剪辑", "丝滑转场", "叠化"],
        version: "1.0.0",
        author: "dgmt",
        mode: "text",
        prompt: "按 h3-seam-polish 正典 modifier,把下面的本镜生成提示词末尾追加转场约束段落(预备—交接—缓冲三阶段、速度继承、单主导机制、人物跨镜连续、12-18 帧过渡窗口)。共享视觉锚体:【如 太刀刀刃/圆环/瞳孔/色块】;主运动方向:【横向|纵向】。本镜提示词:",
        image: publicAsset("/short-drama-styles/retro-hong-kong.jpg"),
    },
    {
        id: "h3-app-catalog",
        name: "h3-app-catalog",
        description: "MiniMax H3 市场应用速查:文生/图生/首尾帧/多参考/15 秒加速/声音克隆的选型与必填参数",
        kindLabel: "速查",
        triggers: ["MiniMax H3", "H3视频", "海螺", "文生视频", "图生视频", "首尾帧", "15秒加速"],
        version: "1.0.0",
        author: "dgmt",
        mode: "text",
        prompt: "按 h3-app-catalog 正典速查,为下面的需求选出最合适的 MiniMax H3 市场应用并列出必填参数(优先 list_apps/run_app 口径,submit_generation 只作进阶兜底)。需求:",
        image: publicAsset("/short-drama-styles/real-life.jpg"),
    },
    {
        id: "img2threejs",
        name: "img2threejs",
        description: "参考图 → 高质量可动画的程序化 Three.js 模型(纯代码重建,分阶段雕刻管线 + 质量门控)",
        kindLabel: "模板",
        triggers: ["img2threejs", "图生3D", "图转3D", "参考图重建", "Three.js模型", "程序化建模", "3D重建"],
        version: "2.0.0",
        author: "dgmt(改编自 img2threejs v2.0.0,Apache-2.0)",
        mode: "text",
        prompt: "按 img2threejs 正典技能(参考图 → 程序化 Three.js 模型,纯代码重建而非摄影测量)重建附带的参考图:输出 ObjectSculptSpec JSON(组件树/材质/转轴/插槽/动作锚点)+ createXxxModel(spec, options) TypeScript 工厂函数(返回带 rig 的 THREE.Group)+ 各阶段渲染对比与诚实保真度声明。目标类别:【道具/角色/植物/机械,可从图判断】;质量档位:standard;导出:【缺省只交付 Three.js 代码,可选 glb】。请先添加一张物体/角色参考图,再发送。",
        image: publicAsset("/short-drama-styles/fantasy-3d.jpg"),
    },
];

export function findCreationCanonSkill(id: string): CreationCanonSkill | undefined {
    return creationCanonSkills.find((skill) => skill.id === id);
}
