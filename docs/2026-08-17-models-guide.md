# ToIV 模型说明书(2026-08-17)

> 面向创作者:每个引擎一页「设备卡」。R18 引擎仅在 /nsfw 专区可见。
> 数据口径:生产引擎注册表(`/api/models/engines`,21 条)+ `workflows/model_profiles.py` + `services/h3.py` + `docs/2026-08-16-wan22-i2v-nsfw-recipe.md`。参数范围/默认值以注册表为准。

**引擎总览(21 条)**

| 分区 | 引擎 | 状态 |
|---|---|---|
| 图像 | 文生图 / 图生图 | ✅ |
| 图像 R18 | 文生图(R18)/ 图生图(R18) | ✅ |
| 视频 SFW | LTX 2.5 文生/图生、MiniMax H3 文生/图生 | ✅ |
| 视频 SFW | LongCat 文生/图生/续写、Wan2.2 动作迁移、VACE 多参考、LongCat-Avatar 数字人 | ✅ 在线(忙时探测偶发超时,点「重新检测」即恢复) |
| 视频 R18 | LTX 2.3 系(文生/图生/对口型)、MiniMax H3(R18)×2、Wan2.2 图生视频(R18) | ✅ |
| 音频 | ACE 文生音乐 | ✅ |

---

## 一、图像引擎

### 文生图 / 图生图(txt2img / img2img)

**定位**:ComfyUI 图像工作流,全站出图的万能台。底模/采样器/调度器/风格预设全可选;擅长海报、人像、二次元、概念稿、产品图。图生图在参考图基础上重绘,`重绘幅度(denoise)`控制偏离程度(越小越贴近原图,0.1-1.0,默认 0.6)。

#### 底模族速查表(选对族 = 说对「方言」)

| 族 | 代表底模(平台已装) | 提示词方言要点 |
|---|---|---|
| Pony 系 | ponyDiffusionV6XL_v6、autismmixSDXL_autismmixPony、cyberrealisticPony | **质量分标签**(score_9, score_8_up…)+ danbooru 标签 |
| SDXL 动漫 | animagineXL40、hassakuXL、waiIllustrious、noobaiXL、prefectIllustrious | **danbooru 标签流**(1girl, solo, looking at viewer…),短词堆叠 |
| SDXL 通用 | cyberrealistic_v120、lustifySDXL_apexV8 | danbooru + 自然语言混合,质量词有效 |
| Flux(1.x/2.x) | flux1-dev-fp8、flux2_dev_fp8mixed、flux-2-klein-4b | **自然语言长句**,像写剧本一样描述;忌堆质量词(masterpiece/best quality 无效甚至干扰) |
| Qwen-Image | qwen_image_fp8_e4m3fn | 自然语言;**中文文字渲染**是招牌(海报/商用字) |
| Z-Image | z_image_turbo_bf16 | 简洁自然语言,turbo 低步数出图 |
| SD1.5 | DreamShaper_8、majicMIX realistic_v7、URPM v1.3 | **强质量词**(masterpiece, best quality)+ **解剖负面**(bad hands, extra fingers…) |
| 次世代族通用 | flux2 / qwen_image / z_image | 由服务端强制正确采样(cfg/负向面板不生效),只管写内容 |

#### 参数建议表(甜点位,来自服务端族档案)

| 族 | 采样器 / 调度器 | steps | cfg | 分辨率档 |
|---|---|---|---|---|
| Pony | euler_ancestral / normal | 28 | 6.0 | ~1MP(1024²) |
| SDXL 动漫 | euler_ancestral / normal | 28 | 5.0 | ~1MP |
| SDXL 通用 | dpmpp_2m_sde / karras | 30 | 6.0 | ~1MP,长边 ≤1536 |
| Flux2 | euler / simple(强制) | 25 | 1.0(强制) | ~1.37MP,长边 ≤1536 |
| Qwen-Image | euler / simple(强制) | 20 | 3.5(强制) | ~1.37MP |
| Z-Image | res_multistep / simple(强制) | 8 | 1.0(强制) | ~1.37MP |
| SD1.5 | euler / normal | 20 | 7.0 | **0.4MP,长边 ≤896**(高了出双头) |
| v-pred 底模(noobaiXL_vpred10、waiSHUFFLENOOB_vPred04) | euler / normal | 20-28 | **4.5** | ~1MP |

- 面板范围:宽/高 64-2048(8 对齐,默认 1024²)、steps 1-150(默认 20)、cfg 0-30(默认 7.0)、批量 1-8 张。
- 实际像素由服务端按底模族**自动适配**(前端宽高只定宽高比):SD1.5 压到 0.4MP、SDXL 保持 1MP、次世代放到 1.37MP——这是防崩坏机制,不是 bug。
- **风格预设**(32 个:古风汉服/电影感/商用设计/二次元高品质(v-pred)/极速预览(8步)…)选中后由后端自动套用底模+采样参数;显式手选底模优先于预设。

#### LoRA 用法

`<lora:名称:权重>` 标签**直接写进提示词**,例如 `<lora:add-detail-xl:0.8>`。权重一般 0.5-1.0,多个可叠加。

#### 翻车点

| 症状 | 原因 | 解 |
|---|---|---|
| 出图灰/糊 | v-pred 底模没走 v_prediction 采样 | 选 noobai/waiSHUFFLENOOB 时保持默认;服务端会自动注入 v-pred 修正(zsnr),别手动改调度器 |
| SD1.5 底模出双头/重复肢体 | 分辨率拉太高 | 交给服务端自动压 0.4MP;或手动 ≤896 长边 |
| Flux 出图不受控/元素乱飞 | 堆了质量词 | Flux 只写自然语言场景描述,删掉 masterpiece/8k 类词 |
| 次世代底模负向词「没用」 | flux2/z_image 族负向天然失效(服务端不发负向) | 正常行为;不想要的东西在正向里改写 |
| 面板 cfg 改了没效果 | 次世代族(flux2/qwen_image/z_image)由服务端强制正确采样 | 正常行为,cfg 面板对这几族不生效 |

### 文生图(R18)/ 图生图(R18)(nsfw-txt2img / nsfw-img2img)

**定位**:成人向图像,仅 /nsfw 专区可见。默认 R18 底模为 **URPM v1.3**(Uber Realistic Porn Merge,SD1.5 写实合并);专区底模下拉默认落到 animagineXL40(动漫向)。

**可选 R18 底模清单(13 个)**:

| 底模 | 族 | 擅长 |
|---|---|---|
| uberRealisticPornMerge_urpmv13(URPM v1.3) | SD1.5 | 写实成人向默认,解剖负面词必带 |
| lustifySDXLNSFW_apexV8 | SDXL 写实 | 纯 SDXL 写实成人向 |
| cyberrealistic_v120 / cyberrealisticPony_v180Coreshift | SDXL 写实/Pony | 真实感人像 |
| animagineXL40 | SDXL 动漫 | 通用二次元(专区默认) |
| ponyDiffusionV6XL_v6 / autismmixSDXL_autismmixPony | Pony | 质量分标签体系,姿势/概念覆盖广 |
| noobaiXL_vpred10 / waiSHUFFLENOOB_vPred04 | v-pred 动漫 | 二次元高细节,**必须 v-pred 采样档(cfg 4.5)** |
| hassakuXLIllustrious_v34 / waiIllustriousSDXL_v170 / prefectIllustriousXL_40 | Illustrious 系 | 浓烈 hentai 风,danbooru 标签 |
| nova3DCGXL_ilV90 | SDXL 2.5D | 3DCG 手办质感 |

参数与 SFW 图像引擎相同(宽/高 64-2048、steps 1-150、cfg 0-30、批量 1-8);图生图重绘幅度默认 0.6。LoRA 标签同样写进提示词。R18 风格预设(NSFW二次元/NSFW写真人像/URPM 写实 NSFW/Pony风格NSFW/NoobAI vpred NSFW/WAI ShuffleNoob NSFW)一键套族参数,新手建议先用预设。

---

## 二、视频引擎(SFW)

### LTX 2.5 文生/图生视频(ltx25-t2v / ltx25-i2v)【主力】

**定位**:LTX-2.5 22B 音视频基础模型(Lightricks 开源,nvfp4 蒸馏版,专用实例 :8198)。**音画同出**——提示词直接描述画面和声音,一次产出带音轨的 mp4。蒸馏版 8 步快速出片,是当前 SFW 视频主力。

**参数卡**:

| 参数 | 范围 | 默认 | 说明 |
|---|---|---|---|
| 宽 / 高 | 256-1920 / 256-1088,32 对齐 | 960×544 | 非对齐自动向下取整 |
| 时长 | 0.5-60s | 5s | **任意时长**;超 25s 单段上限自动分段续写并精确裁切 |
| 帧率 | 8-60 | 24 | 官方 conditioning 默认 24fps |
| 步数 | 1-50 | 8 | 蒸馏版默认 8 步,cfg=1 服务端固定 |
| 首帧强度(仅 i2v) | 0.0-1.0 | 0.7 | 1.0 = 完全锁定首帧 |

**提示词方言(音画同出)**:画面描述之外可以直接写声音——「海浪拍岸声由远及近」「她轻声说『……』」「背景爵士乐渐强」都会被生成。「优化提示词」按钮选中本引擎时自动按音画同出方言改写。

### MiniMax H3 文生/图生(h3-t2v / h3-i2v)

**定位**:MiniMax 海螺开源权重,专用实例 :8195。**剧情连续性、精确轨迹控制的首选**(诛仙 25 镜生产验证);原生 32kHz 音画同发。固定 24fps,内部帧数吸附 17k+5 网格。

**参数卡**:

| 参数 | 范围 | 默认 | 说明 |
|---|---|---|---|
| 宽 / 高 | 256-1344,32 对齐 | 1344×768 | 上限 1344×768 |
| 时长 | 0.5-60s | 5s | 超 15s 单段上限自动分段续写并精确裁切 |
| 步数 | 1-50 | 20 | |
| LoRA 叠加 | 最多 3 个,强度 0.5-1.0 | 0.6 | SFW 可选:AI_Girl 虚拟女性系列 30/31、Combat 战斗、Futa Transformations V5.1、RemoteOrgasm、digicam 胶片感、VBVR_attn_only、kiss、epic_cumshots ALPHA、hmpussy_v6、PlagueKind 真实感滑杆、turbo 4 步加速系(4 款) |

**翻车点(实证)**:
- **负向提示词不可靠**:H3 对负向响应差,不想要的东西**用正向改写**(「她保持微笑」而不是负向「不要哭」)。「优化提示词」已内置这套全正向方言。
- 720 不是 32 对齐——想要「720p 档」请用 1280×736 / 736×1280。
- 分段续写的片子,单镜提示词只写该镜内容,跨镜连贯性由续写机制保证。

### LongCat 文生/图生/续写(longcat-t2v / longcat-i2v / longcat-continue)

> ✅ **在线可用**(2026-08-17 真机确认:实例 :8197 active,1265 节点)。注意:实例忙时引擎探测可能 8s 超时暂标「不可用」,点「重新检测」即恢复。

美团 LongCat-Video 13.6B 长视频引擎:**单镜头最长 961 帧(16fps≈60s)**,蒸馏 LoRA 低步数(steps 默认 10);>15s 自动上下文窗口分段采样。宽/高 320-1280(16 对齐,默认 832×480),时长 0.5-60s(默认 7.5s),fps 8-30(默认 16,仅影响成片打包)。续写(longcat-continue)取已有视频末帧接下一段长镜头,缺省宽高/帧率自动向源视频实测值对齐。

### Wan2.2 动作迁移(wan-animate)

> ✅ **在线可用**(与 LongCat 同实例 :8197;忙时探测偶发超时,重新检测即恢复)。

Wan2.2-Animate 14B(Apache 2.0):参考图角色按**驱动视频**动作表演(双轨骨骼+表情迁移)。驱动视频 mp4/webm/mov ≤200MB;时长上限 501 帧(16fps≈31s,默认 7.5s);官方示例 **6 步**(dpm++_sde);宽/高 320-1280(16 对齐,默认 832×480)。

### VACE 多参考视频(wan-vace)

> ✅ **在线可用**(与 LongCat 同实例 :8197;忙时探测偶发超时,重新检测即恢复)。

Wan2.1-VACE 14B(Apache 2.0):**1-4 张参考图**(角色/物体/场景)+ 可选首尾帧 → 一致性视频,也支持局部编辑。时长上限 241 帧(16fps≈15s,默认 5s);官方示例 **20 步**(unipc);宽/高 320-1280(16 对齐,默认 832×480)。

### LongCat-Avatar 数字人(avatar-talk)

> ✅ **在线可用**(与 LongCat 同实例 :8197;忙时探测偶发超时,重新检测即恢复)。

LongCat-Avatar v1.5:人像首帧 + 说话音频 → 口型同步视频(音频编码 whisper-large-v3,人声分离 MelBand RoFormer)。默认竖屏 480×832;**默认 25fps**;>3.7s 自动按 93 帧窗口续段,上限 2500 帧(≈100s);steps 默认 12(dmd 蒸馏);驱动音频经上传接口提交(wav/mp3 ≤20MB)。

---

## 三、视频引擎(R18,仅 /nsfw 专区)

### LTX 2.3 系(ltx-nsfw-t2v / ltx-nsfw-i2v / ltx-nsfw-lipsync)

**定位**:LTX-Video 2.3 + **10Eros v14** 底模(Civitai 社区训练的 LTX2.3 成人向专用 UNET,已内置为默认视频 UNET)。文生/图生/对口型三种玩法:对口型(lipsync)= 人物参考图 + 驱动音频(wav/mp3/m4a/ogg/flac ≤20MB)→ 口型同步视频,可加 **ID LoRA**(身份保持,强度 0-2,默认 0.8)。

**参数卡**:

| 参数 | 选项/范围 | 默认 |
|---|---|---|
| 分辨率 | 480p 横(864×480)/ 720p 横(1280×720)/ 1080p 横(1920×1080)/ 480p 竖(480×864)/ 720p 竖(720×1280) | 1280×720 |
| 时长 | 4 / 6 / 8 / 10 / 15 秒 | 6 秒 |
| 帧率 | 4-30 | 16 |
| 步数 | 1-50 | 20 |
| CFG | 0-20 | **1.0**(LTX distilled 建议保持 1.0) |
| 高清放大(2 阶段) | 开关 | 关 |
| RIFE 补帧 | 开关 | 关 |

时长按帧率换算后吸附 8k+1 网格,秒差大时生成后精确裁切。成片交付建议开「高清放大」;想要丝滑慢动开 RIFE。

### MiniMax H3(R18 版)(h3-nsfw-t2v / h3-nsfw-i2v)

与 SFW H3 同一实例、同一链路(固定 24fps,17k+5 网格,>15s 分段续写),R18 能力由社区 LoRA 提供。分辨率预设:480p 横(832×480)/ 720p 横(1280×736)/ 768p 横(1344×768)/ 480p 竖(480×832)/ 720p 竖(736×1280)/ 768p 竖(768×1344),默认 1280×736;时长 4/6/8/10/15 秒(默认 6);steps 默认 20。

**R18 LoRA 清单**(多选最多 3 个,强度 0.5-1.0,默认 0.6;来自 services/h3.py):

| LoRA | 用途(来源 Civitai) |
|---|---|
| riding_pose_H3_i2v_v1.0 | 骑乘位 POV(I2V) |
| H3_footjob_v0_step1000_fixed | 足交动作 |
| h3_musubi_v4-000040 | 外阴特写形态修正 |
| deepthroat_v1 | 深喉动作(Daring's) |
| minimax_vag_000002500 | 阴部细节 v0.2 |
| SexGod-NaughtyTimes-lora-MINIMAXH3 | NaughtyTimes 综合场景 |
| HMNSFW_AIO_V2 | 成人向全能包(I2V/T2V,1.9w 下载) |
| vagassist_e40 | HMPussy v0.5(阴部/肛门细节) |
| stomach_bulge_H3_i2v_v1.0 | 腹部隆起形变(I2V,3.6w 下载) |

### Wan2.2 图生视频(R18)(wan-nsfw-i2v)【重点】

**定位**:Wan2.2 I2V-A14B 双专家 14B(阿里开源)+ Civitai 爆款 NSFW LoRA 配方逆向复刻(kenpechi 等工作流 100% 还原)。参考图首帧定角色/构图,提示词只管动作。

#### 双专家架构(一切的前提)

采样分两段,挂错侧 = 效果全无或画面崩坏:

| 阶段 | 模型 | 负责 | 类比 |
|---|---|---|---|
| 前 60% 步数 | 高噪专家(HIGH) | 构图、动作轨迹、大动态 | 导演——定「演什么」 |
| 后 40% 步数 | 低噪专家(LOW) | 细节、质感、皮肤纹理 | 精修师——定「画面多细」 |

平台侧别**由后端注册表自动判定**(前端只选名字+拉强度,不用管 HIGH/LOW),但理解侧别有助于排障。

#### LoRA 六件套全表

| LoRA 文件 | 侧 | 触发词 | 专精 | 默认强度 |
|---|---|---|---|---|
| NSFW-22-H-e8(通用 NSFW 概念) | HIGH | `nsfwsks` | 解锁成人概念全集:裸体、性行为、体液;Civitai 18 万下载事实标准 | 0.8 |
| wan22-m4crom4sti4-i2v-20epoc-high-k3nk | HIGH | `m4crom4sti4` | 胸部物理(弹跳/重量感/晃动) | 0.7 |
| WAN-2.2-I2V-POV-Body-Cumshot-Pullout-HIGH-v1 | HIGH | `b0dyshot`(+`pull0ut`/`sp0ntaneous`/`s3lf`/`p4rtner`) | POV 体精/拔出(高噪侧动作) | 0.7 |
| Wan_2_2_I2V_A14B_HIGH_lightx2v_4step_lora_v1030(加速 v1030) | HIGH | 无 | 加速 LoRA 新版(kenpechi 同款),选中替代默认 v1 加速,不叠加 | 0.8 |
| DR34ML4Y_I2V_14B_LOW_V2(体位五件套) | LOW | `m15510n4ry` / `bl0wj0b` / `d0gg1e` / `c0wg1rl` / `d0ubl3_bj` | 体位动作五件套(低噪侧细节) | 0.8 |
| 56Low-noise-Cumshot-Aesthetics | LOW | 无(配合 HIGH 词) | 动漫风体液美学(低噪侧质感,beta,强度宁低) | 0.6 |

强度滑杆范围 0.3-1.2,推荐 0.6-0.8,最多叠 4 个。

#### 搭配公式(直接抄作业)

**公式 A:真人 POV(kenpechi 主力)**

```
HIGH:底模 + lightx2v(加速) + 通用NSFW(nsfwsks) + M4CROM4STI4 [+ POV Cumshot(需要射精镜头时)]
LOW :底模 + lightx2v-low(加速) + DR34ML4Y(体位词) [+ 体液美学 LOW(需要时)]
```

提示词骨架:

```
nsfwsks, m4crom4sti4, d0gg1e, 1girl, 1boy, pov,
<动作描述>, <镜头:from behind / side view>,
<表情:blushing ahegao, heavy breathing>,
<细节:floating hearts, heart-shaped pupils>, 4k, very high quality
```

要点:触发词放句首权重最高;体位词从五件套按场景选一;射精镜头 = `b0dyshot sp0ntaneous pull0ut` 三词组合;结尾加分镜词控制节奏。

**公式 B:动漫风**

```
HIGH:底模 + lightx2v + 通用NSFW + [风格 LoRA]
LOW :底模 + lightx2v-low + DR34ML4Y + 体液美学 LOW
```

动漫风先声明画风(`Very high quality 4k drawn animation`),再接 `nsfwsks` + 动作描述。

#### 参数卡

| 参数 | 选项 | 默认 |
|---|---|---|
| 分辨率 | 480p 横(832×480)/ 480p 竖(480×832)/ 720p 横(1280×704,kenpechi 档)/ 720p 竖(704×1280) | 832×480 |
| 时长 | 3s(49 帧)/ 5s(81 帧)/ 7.5s(121 帧,单段上限) | 5s |
| 满血档(成片) | 开关 | 关 |

固定 16fps,帧数须 4n+1 且 ≤121。**满血档开关语义**:关 = 加速档(挂 lightx2v,8 步,cfg high 3.0/low 1.0);开 = 不挂加速 LoRA,20 步 + cfg high 3.5/low 3.0,质量更高但**慢约 4 倍**。更长的片子走作品库末帧续写,别硬拉时长。

#### 「优化提示词」按钮:触发词确定性注入

选中本引擎且勾了 LoRA 后,点提示词条的「优化提示词」:

- **引擎方言**:Wan 骨架模板(触发词置前 → 主体动作 → 镜头 → 神态物理 → 质量收尾),不是通用模板。
- **必选词**(concept/physics 类,如 `nsfwsks`/`m4crom4sti4`)→ 全部置前,后处理逐个补齐,LLM 漏写也会被补上。
- **候选组**(pose/cumshot 类,如 DR34ML4Y 五件套)→ 按你的种子文本关键词预选,LLM 可按场景语义改选;后处理校验「组内至少一个在文中」,全缺才补预选词。
- LLM 输出坏了也有确定性兜底:输出照样以触发词开头。
- **SFW 上下文不注入不补齐**——主站无法被诱导产出 R18 触发词。

#### 翻车点表

| 症状 | 原因 | 解 |
|---|---|---|
| 动作不动/微动 | 加速 LoRA 强度过高 | HIGH 侧加速强度降到 0.6-0.8 |
| 画面过饱和/塑料感 | 挂加速 LoRA 但 cfg 没降 | 保持加速档默认(服务端已锁 cfg);手动链路才需 cfg 1.0-1.5 |
| LoRA 挂了没效果 | HIGH/LOW 挂错侧 | 平台自动分侧;核对该 LoRA 是否勾上且触发词在句首 |
| 体位词不生效 | 触发词没放句首 | 触发词置前,权重最高(或交给「优化提示词」注入) |
| 5 秒以上断裂 | 单段上限 121 帧 | 用作品库末帧续写,别硬拉时长 |

---

## 四、音频引擎

### ACE 文生音乐(ace-music)

**定位**:ACE-Step v1.5 3.5B(ACE Studio × 阶跃星辰开源):风格标签 + 歌词 → MP3。「优化提示词」可把自然语言优化为音乐标签。

**参数卡**:

| 参数 | 范围 | 默认 | 甜点位 |
|---|---|---|---|
| 时长(秒) | 5-240 | 30 | 完整歌曲 90-180;片段 30-60 |
| 步数 | 10-150 | 50 | 默认即甜点;快速试听可 30 |
| CFG | 0-20 | 5.0 | 默认 5.0;想更「自由」降到 3-4 |

**提示词写法**:标签式——`pop, female vocals, emotional, 120bpm, piano, strings`。歌词留空 = 纯音乐;填歌词可用 `[verse]` / `[chorus]` 结构标签分段:

```
[verse]
月光落在旧窗台
[chorus]
我们都不再回来
```

---

## 五、通用参数词典

| 参数 | 含义 | 要点 |
|---|---|---|
| steps(采样步数) | 去噪迭代次数 | 越高越细但越慢;蒸馏模型(LTX2.5 8 步 / Wan 加速 8 步 / LongCat 10 步 / Z-Image 8 步)**低步数是设计值,加步不提质** |
| cfg(引导强度) | 提示词约束力 | 高=贴词但易过饱和;蒸馏/次世代模型普遍 cfg=1 由服务端固定,面板改了不生效 |
| seed(随机种子) | 复现钥匙 | 留空随机;填整数 + 同参数 = 复现同一结果(改提示词找感觉时固定 seed 对照) |
| 分辨率对齐 | 8 / 16 / 32 对齐 | 图像 8 对齐;LongCat/Animate/VACE 16 对齐;LTX2.5/H3 32 对齐。非对齐**自动向下取整**,不会报错 |
| **宽高比安全域** | 视频 9:16~16:9;图像 1:2~2:1 | 🔒 2026-08-17 起:超出安全域的宽高(如 1920×256)**自动纠正**——保长边、抬短边(前端输入时联动纠正 + 后端静默归一,双层防线),防止极端比例导致主体被裁/文字溢出画面。想出竖版请直接用竖版预设或填 9:16~16:9 内的尺寸 |
| 时长分段续写 | 超单段上限自动拆段 | LTX2.5 >25s、H3 >15s、LongCat >15s(上下文窗口);分段后**精确裁切**到你点的秒数,接缝由末帧续写保证 |
| 时长网格 | 帧数合法值 | LTX 8k+1、H3 17k+5、Wan 4n+1——非网格时长自动吸附再裁切,看到秒数微调是机制不是 bug |
| 「优化提示词」按钮 | 按引擎切模板 | LTX2.5 → 音画同出方言(可写声音);H3 → 全正向方言(负向不可靠实证);Wan R18 → 触发词确定性注入;图像 → 按底模族说方言(Pony 质量分/danbooru 标签/Flux 自然语言忌质量词) |

---

## 六、翻车点速查总表(跨引擎)

| 引擎 | 症状 | 根因 | 解 |
|---|---|---|---|
| 图像 | 出图灰/糊 | v-pred 底模走错采样 | 保持默认,服务端自动注入 v-pred 修正(zsnr) |
| 图像 | SD1.5 出双头 | 分辨率超架构档 | 交给服务端自动压 0.4MP(长边 ≤896) |
| 图像 | Flux 元素乱飞 | 堆质量词 | 只写自然语言场景,删 masterpiece/8k |
| 图像 | 负向「失效」 | 次世代族(flux2/z_image)不发负向 | 正常行为,正向改写 |
| 图像 | 底模族选错方言 | Pony 写长句/Flux 堆标签 | 查第一节族速查表,或用风格预设 |
| LTX 2.5 | 面板 cfg 找不到 | 蒸馏版 cfg=1 服务端固定 | 正常,不写负向堆料 |
| H3 | 负向写了没效果 | H3 负向不可靠(实证) | 全正向写法,交给「优化提示词」 |
| H3 | 「720p」选项没有 | 720 非 32 对齐 | 用 1280×736 / 736×1280 |
| LTX 2.3(R18) | 过饱和 | cfg 调高 | 保持 1.0(distilled 设计值) |
| Wan2.2(R18) | 动作不动 | 加速 LoRA 强度过高 | HIGH 侧降到 0.6-0.8 |
| Wan2.2(R18) | LoRA 无效 | 触发词没在句首 | 触发词置前,或用「优化提示词」注入 |
| Wan2.2(R18) | 7.5s 还想更长 | 单段上限 121 帧 | 作品库末帧续写 |
| LongCat 系 | 引擎偶发灰色 | 实例忙时探测 8s 超时(执行中 /object_info 响应阻塞) | 点引擎旁「重新检测」强制重探测即恢复 |
| ACE | 歌词不分段 | 缺结构标签 | 用 [verse]/[chorus] 分段 |
| 通用 | 秒数被微调 | 帧数网格吸附 + 精确裁切 | 机制行为,成片即所点时长 |
| 通用 | 产物 404 | 产物 URL 带签名/归属校验 | 从作品库内点击,不手写产物链接 |

---

> 附:本说明书引擎 id 与注册表一一对应(txt2img / img2img / nsfw-txt2img / nsfw-img2img / ltx25-t2v / ltx25-i2v / h3-t2v / h3-i2v / longcat-t2v / longcat-i2v / longcat-continue / wan-animate / wan-vace / avatar-talk / ltx-nsfw-t2v / ltx-nsfw-i2v / ltx-nsfw-lipsync / h3-nsfw-t2v / h3-nsfw-i2v / wan-nsfw-i2v / ace-music)。Wan2.2 R18 配方深度教学见 `docs/2026-08-16-wan22-i2v-nsfw-recipe.md`。
