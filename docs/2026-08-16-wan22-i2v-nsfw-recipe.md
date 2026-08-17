# Wan2.2 I2V NSFW 视频生成教学(Civitai 爆款配方复刻)

> 来源:对 Civitai 8 个热门 NSFW 视频(作者 kenpechi / EpochZero / 2929dance 等)的 modelVersionIds 逆向解析,100% 还原其生产配方。
> 框架:ToIV 现有 `wan-i2v` 链路(Workstation ComfyUI)+ NAS 共享模型库。
> 日期:2026-08-16

---

## 一、Wan2.2 I2V 的核心知识:双专家模型

Wan2.2 I2V-A14B 是**双 14B 模型**架构,采样分两段:

| 阶段 | 模型 | 负责 | 类比 |
|---|---|---|---|
| 前 60% 步数 | **高噪专家**(high_noise) | 构图、动作轨迹、大动态 | 导演——定「演什么」 |
| 后 40% 步数 | **低噪专家**(low_noise) | 细节、质感、皮肤纹理 | 精修师——定「画面多细」 |

**所有 LoRA 都分 HIGH / LOW 两版,必须挂到对应专家上**,挂错侧 = 效果全无或画面崩坏。
Civitai 上 LoRA 标题/文件名都会标注 HIGH 或 LOW,下载前先看清楚。

---

## 二、爆款配方全拆解(kenpechi 工作流)

他的每个视频挂 5-7 个组件,固定四层结构:

### 第 0 层:底模(已有,无需下载)

| 文件 | 位置 | 状态 |
|---|---|---|
| `wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors` | NAS diffusion_models | ✅ 已有 |
| `wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors` | NAS diffusion_models | ✅ 已有 |
| `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | NAS text_encoders | ✅ 已有 |
| `wan_2.1_vae.safetensors` | NAS vae | ✅ 已有(Wan2.2 复用 2.1 VAE) |

### 第 1 层:加速 LoRA(必挂,4 步出片)

| 文件 | 侧 | 作用 |
|---|---|---|
| `wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors` | HIGH | ✅ 已有(旧版 v1) |
| `Wan_2_2_I2V_A14B_HIGH_lightx2v_4step_lora_v1030_rank_64_bf16.safetensors` | HIGH | ⬇️ 新版 v1030(kenpechi 同款,已下载) |
| `wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors` | LOW | ✅ 已有 |

**注意**:挂加速 LoRA 后 steps 降到 4-8,cfg 必须降到 1.0-1.5(否则过饱和)。满血档(不挂加速)steps 20-30、cfg 3.5,质量更高但慢 4 倍。

### 第 2 层:通用 NSFW 概念 LoRA(高噪侧)

| 文件 | 触发词 | 作用 |
|---|---|---|
| `NSFW-22-H-e8.safetensors`(WAN General NSFW v0.08a) | `nsfwsks` | 解锁 NSFW 概念全集:裸体、性行为、体液。Civitai 18 万下载,是 Wan2.2 NSFW 的事实标准 |

### 第 3 层:专项物理/动作 LoRA(按内容选挂)

| 文件 | 侧 | 触发词 | 专精 |
|---|---|---|---|
| `wan22-m4crom4sti4-i2v-20epoc-high-k3nk.safetensors` | HIGH | `m4crom4sti4` | 胸部物理(弹跳/重量感/晃动) |
| `DR34ML4Y_I2V_14B_LOW_V2.safetensors` | LOW | `m15510n4ry` / `bl0wj0b` / `d0gg1e` / `c0wg1rl` / `d0ubl3_bj` | 体位动作五件套(低噪侧细节) |
| `WAN-2.2-I2V-POV-Body-Cumshot-Pullout-HIGH-v1.safetensors` | HIGH | `b0dyshot` + `pull0ut`/`sp0ntaneous`/`s3lf`/`p4rtner` | POV 体精/拔出(高噪侧动作) |
| `56Low-noise-Cumshot-Aesthetics.safetensors` | LOW | (配合 HIGH 词) | 动漫风体液美学(低噪侧质感) |

---

## 三、搭配公式(直接抄作业)

### 公式 A:真人风 POV(kenpechi 主力配方)

```
HIGH 侧:底模 + lightx2v(加速) + WAN General NSFW(nsfwsks) + M4CROM4STI4(m4crom4sti4) [+ POV Cumshot(需要射精镜头时)]
LOW  侧:底模 + lightx2v-low(加速) + DR34ML4Y(体位词) [+ Anime Cumshot LOW(需要时)]
```

提示词骨架(真人风):

```
nsfwsks, m4crom4sti4, d0gg1e, 1girl, 1boy, pov, <动作描述:he is piston fucking
causing her hips into a rocking motion while her breasts bounce from each thrust>,
<镜头:from behind / side view>, <表情:blushing ahegao, heavy breathing>,
<细节:floating hearts, heart-shaped pupils>, 4k, very high quality
```

要点:
- **触发词放最前**,权重最高
- 体位词从 DR34ML4Y 五件套选(m15510n4ry/bl0wj0b/d0gg1e/c0wg1rl/d0ubl3_bj)
- 射精镜头 = `b0dyshot sp0ntaneous pull0ut` 三词组合(拔出+自动射精+落在胸腹)
- 结尾加分镜词(`floating hearts start appearing near the end`)控制节奏

### 公式 B:动漫风(p1x3lStyl3 像素风示例)

```
HIGH 侧:底模 + lightx2v + WAN General NSFW + [风格 LoRA,如 p1x3lStyl3]
LOW  侧:底模 + lightx2v-low + DR34ML4Y + Anime Cumshot LOW
```

动漫风提示词结构不同:先声明画风(`Very high quality 4k drawn animation` / `p1x3lStyl3`),再接 `nsfwsks` + 动作描述。

### 参数速查(加速档 vs 满血档)

| 参数 | 加速档(默认) | 满血档(成片) |
|---|---|---|
| steps | 4-8 | 20-30 |
| cfg | 1.0-1.5 | high 3.5 / low 3.0 |
| 时长 | 5s(121 帧 @24fps) | 同左,超 5s 走分段续写 |
| 分辨率 | 704×1280(竖)/ 1280×704(横) | 同左 |
| 加速 LoRA 强度 | high 0.6-0.8 / low 1.0 | 不挂 |

---

## 四、在 ToIV 里怎么用(NSFW 模式)

> 2026-08-17 已落地为引擎注册表条目 `wan-nsfw-i2v`(路由 POST /api/generate/video,
> pool worker 执行)。R18 上下文(X-NSFW 头)才可见/可用;SFW 请求带 loras 一律静默剔除,
> 注册表外的 LoRA 名直接 422(防任意文件路径注入)。

1. **开启 NSFW**:设置页 → 内容偏好 → R18 开关(需账户开启 + 未成年校验通过),进 /nsfw 专区
2. **进视频工作台**,引擎选 `Wan2.2 图生视频(R18)`(注册名 `wan-nsfw-i2v`)
3. **上传首帧参考图**(I2V 必须;角色/构图由首帧定,prompt 只管动作)
4. **参数面板**:
   - 分辨率预设:832×480(默认)/ 480×832 / 1280×704 / 704×1280(kenpechi 720p 档)
   - 时长预设:3s(49 帧)/ 5s(81 帧,默认)/ 7.5s(121 帧,单段上限);固定 16fps
   - 满血档开关:默认关(加速档 8 步);开后 20 步 + cfg 3.5/3.0,慢 ~4 倍换质量
   - **LoRA 多选区**(带单项强度滑杆 0.3-1.2,后端按注册表自动分 HIGH/LOW 侧):
     - 必选:`NSFW-22-H-e8`(通用概念)+ `DR34ML4Y_I2V_14B_LOW_V2`(体位)
     - 胸部特写加 `wan22-m4crom4sti4`;射精镜头加 `POV-Body-Cumshot-HIGH` + `Anime-Cumshot-LOW`
     - 加速 LoRA 升级:选 `lightx2v v1030` 替代默认 v1(不叠加,kenpechi 同款新版)
5. **提示词**按上面公式 A 骨架写,触发词置前
6. 生成 → 作品库 R18 区回收(产物自动打 nsfw 标,主站不可见)

### 「AI 优化」按钮已接 Wan 配方(2026-08-17,参考 DashBox 提示词 RFC)

视频工作台选中 wan-nsfw-i2v 且勾了 LoRA 后,点提示词条的「优化提示词」:

- **引擎方言**:Wan 骨架模板(触发词置前 → 主体动作 → 镜头 → 神态物理 → 质量收尾),
  不再是通用视频模板(H3 走全正向方言、LTX-2.5 走音画同出方言,按引擎自动切换)
- **触发词确定性注入**(DashBox L0 思想:不交给 LLM 自由发挥):
  - 必选词(concept/physics 类,如 nsfwsks/m4crom4sti4)→ system 告知「全部置前」+ 后处理逐个补齐
  - 候选词(pose/cumshot 类,如 DR34ML4Y 五件套)→ 按种子文本关键词预选 + system 透出全组,
    LLM 可按场景语义改选,后处理校验「组内至少一个在文中」,全缺才补预选词
  - LLM 坏 JSON/漏写 → 输出照样以触发词开头(确定性兜底)
  - **SFW 上下文不注入不补齐**(主站无法被诱导产出 R18 触发词)
- 数据源:`workflows/wan_i2v.py` 的 `WAN_I2V_NSFW_LORAS` 元数据卡
  (side/default_strength/trigger_words/trigger_mode/role,触发词即 Civitai 作者官方 trainedWords)

### 常见翻车点

| 症状 | 原因 | 解 |
|---|---|---|
| 动作不动/微动 | 加速 LoRA 强度过高 | high_lora_strength 降到 0.6-0.8 |
| 画面过饱和/塑料感 | 挂加速 LoRA 但 cfg 没降 | cfg 降到 1.0-1.5 |
| LoRA 挂了没效果 | HIGH/LOW 挂错侧 | 核对该 LoRA 的标注侧 |
| 体位词不生效 | 触发词没放句首 | 触发词置前,权重最高 |
| 5 秒以上断裂 | 单段上限 | 用分段续写(末帧 i2v 链),别硬拉时长 |

---

## 五、本次逆向的 8 个样本底账

| Civitai ID | 底模标签 | 本地可行性 |
|---|---|---|
| 139298567 | MiniMax H3 | ✅ H3 链路(已有) |
| 139490627 | MiniMax H3 | ✅ H3 链路(已有) |
| 139593511 / 139345695 / 139346895 / 139346628 | Wan Video 2.2 I2V-A14B | ✅ 本教学配方 |
| 139329388 | Grok(xAI 闭源 API) | ❌ 不可本地复现 |
| 139465479 | Krea 2(闭源产品) | ❌ 不可本地复现 |

kenpechi 的 Wan2.2 配方 modelVersionIds 全账:
`[2057465 高噪底模] [2361379 lightning v1030] [2073605 WAN General NSFW] [2265575 M4CROM4STI4] [2553271 DR34ML4Y] [2298673 POV Cumshot] [2116027 Anime Cumshot LOW]`
