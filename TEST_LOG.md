# TEST_LOG.md — ToIV

- 2026-08-30 fb78872 (local, not pushed, not live): Job.nsfw follows explicit intent, not X-NSFW. X-NSFW is adult-page view/create gate only; Job.nsfw / H3 10Eros only when body nsfw:true (h3-nsfw-*/wan-nsfw-*) or pinned R18 LoRA. is_nsfw(ckpt) explicit adult tokens only; pony/wai/illustrious/realisticvision/animagine/noobai/cyberrealistic/lazymix/nova3dcg no longer auto 18+. engines.ts sends nsfw:true. Prod DB 3 mislabels set nsfw=false (4K upscale d79ca9cf…, try-on t2v_00183_/t2v_00184_ = e07b0cb4/71cf52cc). Local main ahead 58, not pushed. Deploying to core; do not write as live until ToIV 开发 reports done.

- 2026-08-29 晚二 七项体验治理包 (5 commits, deployed to core): 86a94e8 Studio01-04 退役出 fleet + L2/L3 收拢 spark02;6c69b6f 灵动岛收短剧 + 融合五子页「返回融合」;fae48dc 剧本拆解异步化(Job+轮询,根治 120s 前端墙,生产实证真实剧本 4 镜 done);05f7703 14 个非 H3 视频引擎 advanced 沉底(SFW 只剩 H3 三件套)+entity_ids 上限对齐官方 9;aefea45 AssetPicker 双源(作品库|主体库)+MultiShotEditor 主体引用+三编辑器轮询改 /api/jobs/lookup+AssistantView 渲染窗口 80。回归:后端 2777、web 694、tsc 0 全过。注意:会话中用户 IDE 缓冲区多次回滚编辑,已记 AGENTS 教训。

- 2026-08-29 35b8b87 + 60d6168 (deployed to core): 任务中心中止按钮 + hidden 引擎。`POST /api/jobs/{id}/cancel` 仅本人/终态 409/审计;DB 先落 canceled 再尽力清场 worker(pending 删队列/running interrupt/占位跳过/不可达不阻塞)。tracker 视 canceled 为终态不回退;wait_for_jobs 抛「已被用户取消」。ltx-nsfw-t2v 标 hidden,选择器不展示但 API 422 仍在;R18 默认优先 nsfw H3。回归:后端 pytest 2772,web 693,小程序 598 全过。生产实证:txt2img 提交→任务中心可见→cancel `worker_action=interrupted`→列表消失→DB canceled。

- 2026-08-29 42dba0c (deployed to core): 视频路径锁 + B3 多主体注入。R18 LTX-2.3 t2v 无首帧塌色块(生产事故)→ `/api/generate/ltx-t2v` 与 `/api/ltx2/t2v`(10eros)一律 422 引导 i2v 上传首帧;LtxVideoGenerator NSFW 无 image_url 直拒;SFW LTX t2v 不受影响。注册表 H3 标 ordinary_default,LTX/Wan R18 标 advanced;web/小程序进阶沉底+徽标。B3:agent 对 H3 透传 entity_ids(此前丢弃);h3-multishot 补 entity_ids+引用注入;engines.ts 补 phantom-s2v 分支。回归:后端 pytest 2765 全过,web tsc 0/测试 690 全过。生产实证:SFW h3-t2v ordinary_default=true;R18 ltx-nsfw-*/wan-nsfw-i2v advanced=true;R18 ltx-t2v 422 含「请上传一张首帧」。

- 2026-08-28 a5e04ea (local, not pushed): long-chat auto-fold, no new-session required. Follow-up uploads only this-turn user; runner rebuilds from AgentMessage then folds. Error copy 「这一条太长，请缩短本轮输入」. 32k GPU hard cap remains. Production lacks this.

- 2026-08-28 e833f33 (local, not pushed): assistant context overflow. Working-copy tool body cap 1800 chars; chat() no longer injects 17 mcp__ schemas every round. On 400, retry once at half budget; still-fail copy later changed by a5e04ea to 「这一条太长，请缩短本轮输入」 (no new-session ask) NSFW+main same endpoint no double call. Persisted AgentMessage still full. Production lacks this.

- 2026-08-28 58cf643 (local, not pushed): assistant SSE timeout replay. MiniProgram timeout 180s→10min. After timeout Web/MiniProgram GET session; if assistant AgentMessage already persisted, show it instead of 「回复失败:连接中断或超时」/「请求超时」。4xx/5xx, empty session, user-stop still use old errors. Production lacks this.

- 2026-08-28 20:46 CST 设备管家: core deploy/.env TOIV_WEB_SEARCH_PROXY now http://192.168.71.9:7897 (MateBook Clash LAN); toiv-api restarted. Old .123 unreachable from core. Clash :7897 works on box and Tailscale 100.74.15.34; TS URL not written to env (websearch accepts one proxy). AGENTS SoT updated, not pushed.

- 2026-08-28 e1f856e (local, not pushed): lora_picker R18 auto falls back to first motion card when engine has no concept card (LTX). Prompt "a" attaches ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors (0.8, r18-default-motion). H3/Wan still prefer concept cards. Only lora_picker.py + test_lora_picker.py. Production still lacks this. Ovi/MCP not included.

- 2026-08-28 93c275e (local, not pushed): H3/LTX/Wan submit-time AI picks LoRA from catalog, no free NAS mix. loras omit/null=auto; explicit []=off; nonempty=pin (catalog filename or 422). Empty frontend control omits field so blank=auto. Catalog: Wan 6 all NSFW keep HIGH/LOW; H3 13 R18+some SFW (turbo accel not auto-picked); LTX 2 motion+dolly. R18 empty prompt inserts engine concept cards (H3 HMNSFW_AIO_V2, Wan NSFW-22-H-e8). Wan auto prepends pick_trigger_words. LTX may pick 0 with no concept card (10Eros UNET already NSFW). Production still lacks this. Ovi/MCP not included.

- 2026-08-28 859b60f (local, not pushed): LtxT2VRequest.height le 1080→1920 so 720×1280 NSFW preset no longer Pydantic 422. Regression test_ltx_t2v_accepts_vertical_720p_preset. Only video.py + test_video.py. Production still le=1080. Empty positive also 422; missing X-NSFW is 403 not 422. Ovi/MCP not included. Phase 4 stack still unpushed.

- 2026-08-28 wording fix in AGENTS: do not write AIGCPannel empty-shot as Wan2.2. SFW main=H3; AIGCPannel empty/preview=LTX-2.5; Wan2.2 I2V + LTX-2.3+10Eros stay ToIV R18. f2885ee VACE comment aligned. Five-doc only, not pushed.

- 2026-08-28 0f6e723 (local, no model swap, not pushed): engine_registry H3 source→MiniMaxAI/MiniMax-H3; LTX-2.3 comments R18-only; VACE comments edit/transition; apps/api + deploy .env.example aligned. H3=Hailuo 3.0, not Hailuo 2.3. Follow-up f2885ee: Wan2.2/LTX-2.3 written as R18, SFW main only H3. Dirty Ovi/MCP workspace not included. Dual-push would take Phase 4 stack, so not pushed.

- 2026-08-28 evening ToIV 开发 repo check: do not swap video/image mains. H3=Hailuo 3.0 main; Wan2.2 empty/motion; R18 intentional LTX-2.3+10Eros; Wan2.1-VACE edit/transition only; image default FLUX.2 + Qwen-Image/Z-Image. Stale copy not stale models (0f6e723 aligned env comments). Hunyuan video/SkyReels not mounted. AIGCPannel must not change ToIV. Five-doc only, Phase4 stack still unpushed.

- 2026-08-28 cf79e39 (on 9f4f08b, not pushed): fleet_registry OpenClaw hardware Mac mini M2 → Mac mini M4 16GB. Only that file. Dirty Ovi files not included. Local main still ahead of origin by the Phase4 stack + these docs. Did not dual-push.

- 2026-08-28 16:47 openclaw01 profiler: Mac mini M4 16GB 10-core (4P+6E), hw.model=Mac16,10 (02-04 same hw.model last round, RAM only verified on 01). pc02 LAN curl :8193/:8194 200 in 17/15ms. SoT table now says TS≠LAN. No serial in docs. fleet_registry was M2 then; now cf79e39 Mac mini M4 16GB (not pushed).

- 2026-08-28 16:45 设备管家 LAN SSH（只读）：openclaw01-04 hw.model=Mac16,10 M4 not M2, :18789 200. pc02 .114 :8193/:8194 HTTP 200 (TS not tested). studio01-04 SSH timeout still fully offline. LTX inactive+disabled, no :8198. MateBook LAN 192.168.71.9, ~/NAS mounted. core :8100/:3501 not listening (AIGCPannel on MateBook Colima :8080/:8100). Noted not changed: workstation swap 8Gi 100%; toiv-tts NRestarts=6363 unstable. Did not push the local unpushed ToIV code stack.

- 2026-08-27 evening Gitee main 25cdc6a; GitHub still a8ac995 (push blocked). ACE-Step 41ea514+997a387 on remote. lipsync 74dd896. library df09aee+25cdc6a buckets. MiniProgram 591; web 660. Do not treat Mobile as live.

- 2026-08-27 项目管家文档治理：根目录收敛为 5 件套。

# ToIV · 测试日志（TEST_LOG）

---

## P3B-P3C-2026-08-28 · Nunchaku + SeedVR2 + flux2/TeaCache 清理（三线并行）

**时间**: 2026-08-28
**类型**: 全模型优化第四波（Phase 3B/3C + 遗留清理）

### Phase 3B Nunchaku（SVDQuant 4bit，技术就绪达成）

- 三端插件（ComfyUI-nunchaku）+ 后端 + 权重（svdq-fp4 flux.1-dev 6.55GB / qwen-image 11.1GB，NAS 平铺）全就绪
- **ABI 教训**：官方 release wheel 止于 torch 2.12；Linux 预编译轮在 torch 2.13 全报 `undefined symbol: c10::impl::cow::materialize_cow_storage`（2.13 改 COW 内联实现）；Windows v1.2.1 轮因 DLL 延迟绑定幸存；workstation 走源码编译（main + cutlass `set_slice3x3`→`set_slice_3x3` 拼写补丁 ×4，nvcc 借 hunyuan3d venv nvidia/cu13，**editable 安装指向 /home/merlin/nunchaku-src 勿删**）
- e2e（5090 同 prompt/seed/20 步）：**fp4 热跑 2.1s vs fp8 3.1s（1.48x）**；显存 6.55GB vs 16.06GB=2.45x、vs BF16 23.8GB=**3.63x**；三端出图目检无黑图/伪影；Qwen svdq 同通（18.3s）
- 整合建议（待主控决策）：**新引擎 id（flux1-nunchaku / qwen-image-nunchaku）**——专用 DiT Loader+TE Loader 与现有 graph 不共用模板；worker pinning 防与 flux2 混排反复换模（30-60s/次）

### Phase 3C SeedVR2 超分（commit 0a5bb31）

- **原生节点全实例可用（0.27.0 已内置 `comfy_extras.nodes_seedvr` 五节点，无需 numz 包）**；3B 6.32G+7B 15.35G fp16+VAE 落 NAS
- core 集成：`video_upscale` 链路 engine 参数（classic 默认兼容 / seedvr2_3b / seedvr2_7b），builder 与官方模板同构（ImageScale→Preprocess→VAEEncodeTiled→Conditioning→**KSampler 1 步**→DecodeTiled→PostProcessing lab 校正）；engine 穿透 spawn→pipeline→reconcile
- e2e 图像（1536×880 人脸→3072×1760）：classic 12.5s 偏软 / **3B 67.2s 发丝眼神细节显著增强+身份零漂移** / 7B 143.1s 精品档；视频 124 帧 1344×768→2688×1536 生产 API done（281s 含首载）
- 测试 8 例新，test_video_upscale 36 绿，全量 **2635 passed**
- 分层：classic=吞吐主力（批量帧）/ 3B=保真首选（人像产品 4K 化）/ 7B=精品单条（UI 标「慢」）

### 清理（17）：flux2 迁库 + TeaCache 补丁 + pc01 任务重建

- **flux2_dev_fp8mixed 根因**：文件在 diffusion_models/（UNETLoader 类目，33GB），旧路径走 CheckpointLoaderSimple（只扫 checkpoints/）→ pc 端 `ckpt_name not in list` 400；复制至 checkpoints/（字节一致），三端枚举 30→31，**LB 三后端各落一条全 done 零 400**；生产 flux2 实际走 UNETLoader 链（mistral_3_small+flux2-vae），checkpoints/ 副本为旧路径保险
- **TeaCache**：0.33 同款守卫补丁（.bak-20260828 备份），:8189/pc01:8188/pc02:8193/:8194 四实例恢复加载；ltxv 克隆前向与 0.33 全面不兼容（LTX 已退役，不回滚无碍）
- **pc01 StartComfyUI 手动 /run 失效**（LastTaskResult=1）→ `/create /f` 重建恢复（onlogon+HIGHEST）
- **情报修正**：pc 端实际可访问 toiv 库（flux1-dev-fp8 等在枚举中）——此前「ACL 拒绝 toiv」是误报：**SSH 登录会话无 NAS 凭据（cmdkey 网络会话禁存）而 ComfyUI 进程会话有 bat net use 凭据**，dir 测试失败≠进程访问失败

## P2B-P3A-2026-08-28 · Phase 2B + Phase 3A + 助手全格式 + cache 调优（四线并行）

**时间**: 2026-08-28（跨 08-27 深夜启动）
**类型**: 全模型优化第三波（四线并行）

### Phase 2B-1 VACE MagCache（commit 5de709f）

- 兼容修复：ComfyUI-MagCache/TeaCache 与 ComfyUI 0.33 的 `precompute_freqs_cis` 死导入（0.33 改名实例方法 `_precompute_freqs_cis`）→ try/except 守卫补丁（符号仅 import 行使用），MagCache 节点三 worker 恢复加载
- 链路事实：VACE 走 WanVideoWrapper（:8197），用 wrapper 内置 WanVideoMagCache（官方 14B 校准数组一致）；builder 加 accel=off/magcache（cache_thresh 0.06/k=2 官方 Wan2.1 校准），路由 /api/wan/vace、/api/generate/video-edit 透传
- e2e（832×480/17 帧/20 步同 seed）：**采样段 69s→30s = 2.30x**（论文 2.68x@50 步口径）；SSIM All=0.9648、PSNR 36.2dB，抽帧无差异
- 测试 11 例新，全量 2615 绿

### Phase 2B-2 LongCat Avatar 8 NFE（commit be38e42）

- 摸底更正：v1.5 早已上线（08-08，whisper-large-v3 + DMD2 rank128 LoRA + GGUF Q8_0 19GB——INT8/FP8 均 diffusers-quanto 格式 ComfyUI 不认，GGUF 已是唯一 8bit 形态，零资产下载）
- 真实缺口：默认 steps=12 未对齐官方 DMD2 **8 NFE** → 四处同步改 8（builder/路由/注册表/前端 AvatarGenPanel）；回退=显式 steps=12
- e2e（同图同音同 seed，93 帧单段）：**181.0s vs 224.0s = -19.2%**（采样段恰 1.5×，固定开销 ~95s）；抽帧口型/牙齿/身份无差
- 测试 34 例绿，全量 2627 绿

### Phase 3A Qwen Lightning + CacheDiT（commit 1433ba7）

- 资产：Lightning 4/8 步 LoRA V2.0 bf16（平铺 loras/ 根目录）；CacheDiT v2.0.0 三 worker 装（ComfyUI 0.27/0.28/0.33 核心 API WrappersMP 兼容实证，无需补丁）
- builder（workflows/nextgen.py）：accel 三档 off/turbo(4步)/turbo_cache(8步+CacheDiT warmup2 skip2)；非 qwen_image 显式请求加速档 422；**附带根治存量 P0：文本编码器候选 qwen3vl_4b(2560 维)→qwen_2.5_vl_7b(3584 维)——修复前 qwen_image txt2img 必然维度错失败**
- e2e（「新年快乐」海报同 seed）：off 30.9s / turbo 6.3s（**7.0x**）/ turbo_cache 6.3s（**7.6x**，8 步质量还比 4 步快）；文字渲染三档全保留，底部小字加速档退化（蒸馏固有，hint 已引导）
- 测试 20 例新，全量 2627 绿

### AI 助手全格式文件识别（commit 441fac0）

- 原仅 pdf/docx/txt/md → 扩展：xlsx（openpyxl 逐 sheet markdown 表）/ pptx（逐页提取）/ csv（摘要+30 行样本）/ json（结构摘要）/ 40+ 代码文本直读 / **图片经 reverse 链 Qwen3-VL 中文反推**（tiff/bmp PIL 转 PNG；VLM 失败 502 透传不伪装）；扫描件 PDF 标注「不可提取文本」不再 422
- 统一 parse_document 入口 → 既有 split_chunks→Qwen3-Embedding-4B→余弦 top-6 RAG 注入体系零契约改动；新依赖 openpyxl/python-pptx（pyproject+requirements 双登记，core 已装）
- 前端：DOC_ACCEPT 全格式 + lucide 类型图标（fileimage/filecode/sheet/filejson/slides，无 emoji）
- 测试：后端 39 绿（+19）、前端 674 绿（+6）、tsc 0

### cache 调优（commit 26b8f28）

- cache_threshold 路由透出（video.py+generate.py，0.05-0.40 可选；空=默认 0.15）
- 网格实验（高动态 i2v turbo_cache 热态）：0.15=50.5s / 0.20=45s / 0.25=45s——**短链（8 步）收益饱和，默认 0.15 维持**；交付=参数场景化可调（高动态 0.10 保守/静态 0.20+ 激进）
- 四线全部部署生产（deploy.sh 全量 + core pip 装新依赖）

## PHASE2-2026-08-27 · Wan 系加速矩阵（基线→资产→builder→e2e 验收→三 worker 打通）

**时间**: 2026-08-27
**类型**: 全模型优化第二波（Phase 2）

### 基线（P0.2/0.3，scripts/bench/）

- 基建：prompts.json（3 场景×4 引擎）+ run_bench.py（lane 双泳道串行、热身独立 prompt 防执行缓存假加速、held 换名追踪、ffprobe 规格、JSONL 断点续跑）
- 对照分母（12 正测全 done，seed=42）：longcat-t2v **136.1s** / longcat-i2v **136.4s** / h3-t2v **186.6s** / h3-i2v **205.2s**；抖动 ±0.5% 适合作分母
- 坑位：执行缓存污染（热身须独立 prompt + /free）、GPU0 flux2 驻留触发 held、held 放行换名致轮询丢失

### 资产（LightX2V/SageAttention/节点）

- Seko Lightning LoRA 4 枚（T2V V2.0 + I2V V1 高低噪，各 1.14GiB，sha256 与 HF LFS 一致）；Wan2.2 FP8 scaled 底模四枚已在库（无缺口）
- SageAttention 2.2 全 venv：workstation 源码编译（sm_120 官方 main 已恢复支持；vs SDPA max_err=0.0165，FP8 PV 后端同过）+ pc01/pc02 woct0rdho Windows 轮 + triton-windows；**PyPI 无 2.2.0**（最新 1.0.6）须源码/社区轮
- KJNodes + EasyCache/LazyCache（原生）全实例加载；TeaCache/MagCache 独立节点与 ComfyUI 0.33 LTX API 不兼容（precompute_freqs_cis ImportError，KJ 版顶替，遗留修兼容）

### builder 三档（commits f0afb3d + 4b0ce32，测试 20 例新/全量 2578）

- `accel`: off（满血 20 步）/ turbo（Seko 成对挂+4 步+cfg1.0 草稿档）/ turbo_cache（8 步+EasyCache×2 成片档，threshold 0.15/start 0.15/end 0.95）
- 路由映射：显式 accel 优先；/api/generate/video 缺省 full_quality=True→off/False→turbo_cache；t2v 缺省满血；wan_t2v 默认 UNET 切真 t2v 双专家权重（修 i2v 错配）

### e2e 验收（18/18 全 done，0 degraded）

| 档 | t2v 墙钟（加速比） | i2v 墙钟（加速比） | VLM 评分 |
|---|---|---|---|
| off | 50.7s（1×） | 198.3s（1×） | 0.911/0.950 |
| turbo（草稿） | 6.8s（**7.46×**） | 25.4s（**7.81×**） | 0.920/0.949 |
| turbo_cache（成片） | 10.4s（**4.88×**） | 43.8s（**4.53×**） | 0.907/0.943 |

- 目检：turbo 档人脸稳定/ID 一致/运动幅度充足；turbo_cache 首中末帧零 ID 漂移、无 EasyCache 软化——**双档验收通过投产**
- 意外发现：t2v 高动态 off 档评分最低（0.817，满血 cfg3.5 运动模糊过重），蒸馏 cfg1.0 反而更锐利

### 三 worker 打通（Seko/VHS/ffmpeg）

- **Seko LoRA 仅 :8189 可见**：NAS SMB 对新建子目录（loras/lightx2v/）不继承授权（绿联子树级 ACL，POSIX chmod 无效）→ **平铺 loras/ 根目录改简名**（builder 常量同步，教训入注释：NAS 新模型勿入新建子目录）
- pc01/pc02 补装 VideoHelperSuite + imageio-ffmpeg（VHS 视频合成依赖；**运行中进程会缓存 imageio_ffmpeg 导入失败，装包后必须重启实例**）
- 最终验证：pc01 turbo i2v 生产 done（产物 ToIV_vid_00003.mp4）；三 worker（:8189/pc01:8188/pc02:8193）Seko+VHS+Sage+EasyCache 全就位
- **遗留**：flux2_dev_fp8mixed 在 toiv 库 pc 端不可见（同 ACL 问题，LB 分发 flux2 到 pc 会 400——待迁主库 checkpoints/）；mihomo 代理不可达（已走 ghfast.top，待网络负责人核查）；cache_threshold 0.15→0.20-0.25 调优空间；:8199 animate2 节点未装

## NAS-FIX-2026-08-27 · pc01/pc02 NAS 挂载根治（模型枚举 0→恢复）

**时间**: 2026-08-27
**类型**: 设备运维（Phase 2 前置：worker 可用性修复）

### 故障链（两台同病）

- 现象：Z: 映射存在但 `Unavailable`，ComfyUI object_info 的 checkpoints/UNET 枚举全 0，ckpt 类任务实际全落 workstation（ACE-Step 升级时实证）
- 根因三层：①**cmdkey 无任何已存凭据**——凭据从未持久化，会话过期即断；②`start_comfyui.bat` 的 `net use Z: ... 2>nul` **盲吞错误**——持久化 Unavailable 占位致 85 冲突，映射静默失败；③`\MountNAS` 计划任务仅登录触发且参数单反斜杠疑似无效
- 加深一层：Windows 盘符映射是**会话级**——SSH 每次登录新会话、计划任务各自独立会话，用户态映射对服务进程天然不可靠；cmdkey 又被安全策略拦截（`Credentials cannot be saved from this logon session`，网络登录会话禁写持久凭据）

### 修复（两台同法，备份 .bak-20260827）

1. `extra_model_paths.yaml` 盘符路径改 **UNC**：`Z:/Windows/...` → `//192.168.71.7/NAS/Windows/...`、`Z:/toiv/...` → `//192.168.71.7/NAS/toiv/...`（ComfyUI 不再依赖盘符）
2. 启动 bat 自愈化：`net use Z: /delete`（清占位防 85）→ **无盘符 net use 建 SMB 会话**（UNC 访问的凭据基础，与 ComfyUI 进程同会话生效）→ Z: 映射（仅便于人工）→ 错误落 `nas-mount.log`（不再盲吞）；pc01×1 bat、pc02×3 bat（:8193/:8194/辅助）
3. 队列空闲确认（running=0/pending=0）后重启实例

### 验证

- pc01 :8188：ckpt **30** / UNET **49** / LoRA **162**（修复前全 0）；nas-mount.log 双成功
- pc02 :8193 + :8194：各 ckpt **30**；双实例 ready
- **ace_step_1.5_turbo_aio.safetensors 三 worker 全部可见**（F 线遗留项闭环）
- 教训固化（已入设备指南）：**Windows 服务化场景禁依赖盘符映射，一律 UNC + 启动脚本建会话**

## HOTFIX-2026-08-27 · 灯箱关闭钮遮挡 + 助手 422「回复失败:[object Object]」（commit 3856bb1）

**时间**: 2026-08-27（用户报障，紧急处理）
**类型**: 前端双 hotfix

### 问题一：作品库预览关闭钮被账户按钮盖住

- **根因（层叠上下文陷阱）**：`.view-stage { view-transition-name: main-stage }`（motion.css:64）强制创建层叠上下文且自身层级 auto≈0；`.lib-lightbox`（fixed, z-modal 300）直接渲染于其中被"困住"，对外只算 0；根层级的 `.accountbtn`（fixed, z-sticky 100）反压灯箱，右上角关闭钮（位置与账户头像重叠）被遮挡，仅 Esc 可关
- **修复**：LibraryLightbox 改 `createPortal(..., document.body)`，逃脱祖先层叠上下文，z-modal(300) 在根级生效压住账户按钮(100)
- **测试**：portal 源码断言（react-dom import/createPortal/document.body 三锚点）

### 问题二：AI 助手长会话 422，错误显示 [object Object]

- **根因（两层）**：①前端把全部会话历史**无截断**上送，超后端契约（messages≤40 条 / 单条 content≤8000 字符，agent.py:118-127）即整体 422——长会话必现；②agentChat/agentChatStream/agentChatResume 三处错误处理 `new Error(detail?.detail ?? …)` 把 FastAPI 422 的 detail **数组**直接字符串化 → `[object Object]`
- **修复**：
  - `buildApiMessages` 纯函数（AssistantView）：过滤 error 卡/非对话角色、保留最近 30 条（MAX_API_MESSAGES）、单条超 7900 截断带标记（MAX_API_MESSAGE_CHARS）
  - `apiErrorMessage`（lib/api.ts 导出）：422 detail 数组逐项「字段路径(去 body 前缀): 消息」拼接，空/非法回退「兜底 (status)」，三处 SSE 调用点接入
- **测试**：新增 9 例（apiErrorMessage 5 + buildApiMessages 3 + portal 1）；前端 **668 全绿**、tsc 0 错误、构建通过
- **部署**：已 deploy.sh 上 core（api 200 / web 200，BUILD_ID 20260827-114415 含本修复）
- **注意**：终端并行会话串扰（chromakey 会话）两度截断 heredoc commit——教训：多会话同仓工作时用 `git commit -F 文件` 替代 heredoc

## OPT-P0P1-2026-08-27 · 全模型优化 Phase 0+1+T0（六线并行）

**时间**: 2026-08-27
**类型**: 全模型矩阵优化第一波（硬件核实 + 零风险加速 + 安全红线）

### Phase 0 硬件实况核实（设备管家）

- 全设备 SSH 只读核实；**spark01 悬案定论**：:8000 = Qwen3-VL-32B-Instruct-FP8（vLLM 容器 qwen3vl32b），llama-3.3-70b-abliterated 已于 08-08 下线（权重留盘 spark-models 可回滚）；设备指南过时、项目记录正确
- workstation 9 个 ComfyUI 实例全活（:8188LB/8189/8195H3/8197LongCat→实绑GPU0/8199Animate2/8200Hunyuan3D/8261-8263超分）；29 个 toiv-*/comfyui-* systemd 全 active；GPU3 仅剩 7G 空闲（FlashTalk 50.7G+i2l+animate2）
- STATE.json infra 六段纠偏（vlm_server/llm_brain/llm_nsfw_routing/trainer/tts/comfyui_cluster+pc01/pc02）

### T0 安全红线（commits 0cde7f6 + a2b1462，八项）

- **SSRF**：/api/score 两 endpoint 接入白名单；7 处白名单副本去 127.0.0.1 全端口通配（仅放行 api_base 自身端口）；11 个下载点加重定向复验 `_check_redirect`
- **门控**：generate/raw 递归扫描全部 inputs 中模型扩展名字符串过 is_nsfw（堵 unet_name/lora_name 绕过）；model_profiles NSFW hints 补 `10eros`（10Eros R18 UNET 文件名此前任何门控命不中——绕过根因）
- **认证**：studio/files、opentalking/status 补 get_current_user
- **限流**：XFF 仅可信代理采纳（新配置 TOIV_TRUSTED_PROXY_IPS，默认空=不信任）；train 5 写端点限流（start/i2l count=3）
- **nsfw 继承**：二次加工链五分支反查源 Job 继承 nsfw，查不到保守置 True
- 新测 127+89 例全绿；**生产部署提醒**：core .env 须配 TOIV_TRUSTED_PROXY_IPS=127.0.0.1,::1

### P1 零风险加速（五项，全部量化实证）

| 项 | 改动 | 收益 |
|---|---|---|
| P1.1 LatentSync | DDIM 40 步 → DPM-Solver++ 10 步（steps_offset 清零+帧批重置两坑修复）；core 默认步数贯通（74dd896） | 10s 视频 71.2s→48.4s（**-32%**），抽帧目检质量一致 |
| P1.4 IndexTTS | BigVGAN CUDA kernel 首次编译生效（nvcc-shim gcc-14 + CUDA_HOME，此前生产一直静默 fallback torch） | 声码器段 0.06-0.09s→0.02s（**-67~78%**） |
| P1.2 spark01 VLM | max-num-seqs 8→16 + gpu-util 0.70→0.80 + chunked-prefill + async-scheduling（新容器 qwen3vl32b-v2，旧容器保留可 30s 回滚） | KV 池 49.95→62.25GiB（**+25%**），core 反推 e2e 过 |
| P1.5 spark02 LLM | +kv-cache-dtype fp8 + max-num-seqs 16→24（vllm_node-v2；MTP 投机/双 parser 全保留） | KV 池同显存 638K→944K tok（**+48%**）；工具调用冒烟逐字一致、长上下文 12.4K tok 正常 |
| P1.3 ACE-Step 1.5 | turbo AIO 8 步草稿 / base split 50 步成品 / legacy 1.0 三档；秒数上限 240→600；三 worker 节点原生具备 | 热态 10s 歌 **0.93s vs 26.4s ≈ 28x**；60s 长音乐 4.42s；41ea514 合回 main（997a387）并已 deploy.sh 上生产 |

### 主控收尾（commit 74dd896）

- **真 bug**：video_lipsync 端点 `_resolve_video_source(...) or _resolve_audio_source(...)` 的 or 短路——video 源继承 nsfw=True 时 audio 白名单校验被整段跳过（SSRF 绕过），两源校验改为各自执行；test_submit 断言对齐保守置 True 新语义
- 教训：F 线 agent stash 工作区切分支致主控修改入 stash（wip-lipsync-dub），已 pop 恢复；**并行 agent 禁止 stash 含他人改动的工作区**
- 全量回归：**2558 passed / 0 failed**（96.83s）

## MOBILE-MERGE-2026-08-27 · 移动端合并为 MiniProgram

**时间**: 2026-08-27
**类型**: 仓库治理（用户拍板只留 uni-app）

- 原 `Mobile/`（Expo/RN）`git mv` 至 `.archive/mobile-expo-20260827/`
- `MiniProgram/` 为唯一移动端（微信为主，App 必要时再出）
- 能力审计：两边页面集合一致（创作/作业/作品库/我的/登录/资产/助手/Agent）；小程序已有微信登录、助手附图、资产预填。本期不移植 Expo 专有原生模块，不宣称真机走查完成。
- 根 README / DEVELOPMENT §9 已改身份；未改 AGENTS.md 集群清单


## LIPSYNC-2026-08-27 · M4 通用对口型(LatentSync 裸机复活 + core 链路 + 生产 e2e)

**时间**: 2026-08-27
**类型**: 深度完善「M4 通用对口型模型矩阵」(aigcpanel 对标项收官)

### 服务复活(7 坑攻坚,workstation 7-25 Docker 遗产裸机化)

- 遗产:`/home/merlin/deploys/latentsync`(serve_api.py + checkpoints 4.8G + LatentSync 仓库)
- 坑:①torch 2.5.1 无 sm_120 内核 → **torch 2.8.0+cu128**(flash_attn 轮放弃,零引用无损)②serve_api 与 predict.py 签名不匹配(video/audio 形参)③cog Input() 默认值 FieldInfo 须显式 seed=0 ④predict 调 `python -m scripts.inference` 须 `sys.executable` ⑤checkpoints 软链 + insightface buffalo_l 手动归子目录 ⑥漏 ffmpeg-python ⑦pkill 误杀 root Docker 旧容器(:8600 遗留,未处置)
- 落位:`toiv-lipsync.service` active+enabled(GPU0 :9103,Restart=always,MemoryMax=48G);推理峰值 ~6G,子进程退出显存回落零泄漏

### core 链路

- `POST /api/video/lipsync {video_url,audio_url,inference_steps,guidance_scale}`:来源白名单+归属+R18 门控复用 video_upscale;上传 agent→submit→Job(processing)→5s 轮询→succeeded 且 degraded=false 落产物 done;**degraded=true → error「推理降级,产物为原视频副本」零产物不造假**;reconcile_interrupted 重启重挂
- **契约修正**:submit 字段名是 `video`/`audio`(非 video_filename,生产 400 实证);音频白名单补 `/api/manju/voice/`、`/api/audio/orch/files/`、`/api/audio/files/`
- ⚠️ 测试基建发现:starlette TestClient 每请求建毁事件循环,多轮轮询后台任务测试假死——`blocking_portal` fixture 解法(仓库通用)

### 生产 e2e(全链实证)

- t2v_00146_.mp4(H3 产物,有人脸)+ drive.wav(IndexTTS 合成)→ `job done` → 产物 `lipsync-9b951580….mp4` **1.27MB MP4 下载复核**(200)
- R18 门控实证:SFW 上下文访问 R18 源 403「R18 产物需在专区内操作」,X-NSFW 头放行

### 测试/回归

- 新增 22 例;全量后端 **2425 passed**;LatentSync 服务冒烟:25 步 ~80s,产物 h264+aac 音轨(degraded=false 判真:降级副本无音轨)

---

## DIGIHUMAN2-2026-08-27 · 直播助手融合(M5)+ 绿幕抠像(M6)

**时间**: 2026-08-27
**类型**: 用户诉求「产品方向不同但功能可以融合,继续更深度完善」

### M5 直播助手(融合 aigcpanel 智能直播的知识库/违禁词/互动记录,不做平台弹幕抓取)

- **数据模型**(新表 create_all):LiveKB(触发词/回复 text|video/优先级/enabled)、LiveEvent(摄入事件+播报状态)、LiveBannedWord
- **摄入流水线** `POST /api/live/ingest`:违禁词双向拦截(输入+回复)→ KB 优先级匹配(大小写不敏感子串)→ LLM 兜底(≤80 字口语化+KB 摘要,异常固定文案不 5xx)→ 落库 → 活跃会话则 speak 播报
- **播报状态机**:banned|replied(video 回复)|no_session|spoken|speak_failed;会话用户级单例(重启即清回落 no_session 语义安全);OpenTalking 不可达 502 明确文案
- **端点**:KB CRUD / banned CRUD / ingest / session start|stop|status / events?limit(全部属主隔离,他人 404 防枚举)
- **前端**:AvatarTalkView 第三模式「直播助手」(不动全局导航)——控制台(形象复用 M1 模板库+开始/结束+状态点+弹幕摄入+事件流 4s 轮询+五色状态徽标)/ 知识库管理(enabled 即时开关+新建+删除确认)/ 违禁词标签增删

### M6 绿幕抠像合成(M1 green_screen 标记真启用)

- `POST /api/video/chromakey`:ffmpeg `chromakey=<key_color>:<similarity>:<blend>` + overlay(纯色 lavfi color|背景图 loop 充满裁边,音轨透传前景);key_color 严格 `0xRRGGBB` 防 filtergraph 注入;来源白名单+归属校验复用 video_upscale;产物 Job(kind=chromakey,params 溯源,nsfw 继承源)可再入链(二次抠像/超分)
- **真 ffmpeg e2e**:绿视频抠到红底,出片 ffprobe 64×64 实证
- **前端**:AvatarGenPanel 结果区「绿幕合成」折叠区(纯色/背景图互斥、similarity/blend 滑块、选中绿幕模板自动展开提示、结果就地播放)

### 测试/回归

- 后端:M6×18 + M5×17;全量 **2403 passed**(M6 树)/ **2385 passed**(M5 树,并行基线)
- 前端:+12(659 passed + tsc 0)

---

## DIGIHUMAN-2026-08-27 · aigcpanel 调研 + 数字人完善 M1-M3 落地

**时间**: 2026-08-27
**类型**: 用户诉求「调研 modstart-lib/aigcpanel + 数字人功能完善,方案自定」

### aigcpanel 调研摘要(Electron 桌面面板,697 commits)

- **数字人合成**:口型同步模型矩阵(MuseTalk/LatentSync/Wav2Lip/Heygem)切换,文本(TTS)或音频双驱动,**绿幕形象模板管理**
- **语音**:多模型 TTS(CosyVoice/FishSpeech/IndexTTS/SparkTTS/GPT-SoVITS)、克隆、**ASR 时间戳+SRT 字幕导出**、声音替换
- **工具箱 25+**(长文本转音频/字幕转音频/智能剪辑/字幕/变速/压缩/合并/格式/ffmpeg 自定义)
- **可视化工作流**(VIP:LLM/JS/分支/MCP 节点拖拽编排)、**智能直播**(VIP:五平台弹幕+知识库问答)、AI 模型管理面(一键启停+日志)

**借鉴映射**:ToIV 已有 Agent Team(langgraph 图编排≈工作流)、音频编排(tts/separate/concat/mix/variant≈工具箱音频半区)、模型引擎注册表(≈模型管理);**真缺口**=形象模板管理/文本直通驱动/ASR 字幕导出 → 即 M1/M2/M3。通用对口型模型矩阵(Wav2Lip 系)列 M4 后续评估;智能直播不采纳(产品方向不同)。

### M1 数字人形象库(对标「我的形象」)

- ReferenceAsset `kind="avatar"` + `green_screen`(BOOLEAN DEFAULT FALSE,过 PG 守卫)+ `ref_audio`(默认音色参考)两列,幂等迁移
- 前端 AvatarGenPanel「形象模板」区:模板卡网格(绿幕 Badge)、点击免上传填充、「存为模板」、空列表引导、手动改图解除选中
- 生产实证:创建「冒烟形象0827」(green_screen=true) → `kind=avatar` 过滤列表命中;PG 两列在(reference_assets)

### M2 avatar-talk TTS 直通(文本→IndexTTS→驱动一单)

- `POST /api/avatar/talk` 新增 `drive_text`(≤2000)/`voice`(音色参考音 URL,SSRF 白名单复用)/`speed`(0.5-2.0→duration_factor);与 audio **互斥**(都给/都不给 400);TTS 不可达 **502 零半成品**(实例零写入零 Job);params 自动溯源;NSFW/hold/预检零绕行
- 前端驱动源段控:上传音频|文本驱动(textarea 字数提示+音色输入+语速滑块),`buildAvatarTalkPayload` 纯函数保证互斥
- 生产实证:drive_text 提交 → TTS wav `toiv-tts-8940ee7d…wav`(165KB)**实证落 LongCat 实例 input** → hold 预检正常拦截(GPU0 余量 15.5G<26G,排队自动放行,环境容量非代码问题)

### M3 ASR→SRT 字幕导出(对标工具箱「声音识别含时间戳/字幕导出」)

- `GET /api/dub/transcribe/{id}?format=srt`(json 默认不变):未完成 409、无时间戳 400(不造假)、`application/x-subrip` 附件下载
- 上游(faster-whisper :9210 / OpenAI 兼容 verbose_json / 内置 faster-whisper)**原生带 segments 时间戳**,零上游改动

### 测试/回归

- 后端新增 29 例(M1×6/M2×5/M3×18),全量 **2368 passed**;前端新增 6 例,**647 passed + tsc 0**
- 已全量部署(API+Web,BUILD_ID 20260826-205917)

---

## SCORER-SFX-2026-08-27 · 评分器灰度缺口修复 + sfx 引擎选型

**时间**: 2026-08-27
**类型**: 用户诉求「修复评分器灰度降级问题 + 排查 sfx 音效引擎选型」

### ① 评分器灰度缺口修复

**核实结论(先实证后动手)**:灰度开启后无视频作业完成,生产零点火;手动点火 total=0.94 全链路正常——降级非机制故障,真缺口为三处:
1. **超时可疑**:VideoScorer 30s + 外层 wait_for 30s,对 32B VLM 长视频评分系统性降级 → `TOIV_VIDEO_SCORER_TIMEOUT` 默认 **120s**(外层 +10s)
2. **降级静默**:degraded 直返 None 无任何记录 → 每次点火(含 degraded/超时/异常)结构化日志 `quality_eval job=%s total=%.3f quality_score=%d degraded=%s reason=%s dur_ms=%d`
3. **评分不落库**:quality_warning 纯 SSE 瞬态 → job 表新增 `quality_total/quality_degraded/quality_issues` 三列(降级率 SQL 可统计:`count(*) FILTER (WHERE quality_degraded)*1.0/count(*)`)

**部署攻坚战(PG 迁移 bug)**:
- 首次部署 toiv-api 启动失败:`column job.quality_degraded does not exist`——迁移 DDL `BOOLEAN NOT NULL DEFAULT 0` **PG 不认整型布尔默认**(SQLite 认),该列未应用而 ORM 已引用
- 修复:`DEFAULT 0`→`DEFAULT FALSE`(3 处:job.quality_degraded + 存量 user.nsfw_enabled/job.nsfw 同类隐患一并修)
- 防回归守卫:`test_boolean_migrations_pg_safe_default`——`_SQLITE_MIGRATIONS` 所有 BOOLEAN 必须 TRUE/FALSE
- 终验:三列齐上 PG(quality_degraded boolean default false),API healthy,真实评分 degraded=False total=0.94

**测试**:新增 6 例(超时接线/degraded 落库+日志/低分落库/超时 reason/迁移幂等/BOOLEAN 守卫);全量 **2339 passed**

### ② sfx 音效引擎选型(调研结论)

| 候选 | 参数 | 许可 | 关键特性 | 结论 |
|---|---|---|---|---|
| **MOSS-SoundEffect v2.0**(OpenMOSS,2026-05) | 1.3B DiT+Flow Matching,Qwen3-1.7B TE,DAC VAE | **Apache 2.0** | **48kHz**、≤30s 可控时长、**中英双语**、影视音效定位(拟音/环境/材质区分);SGLang 3× 加速/GGUF 轻量路径 | ✅ **首选** |
| Stable Audio 3.0 Small-SFX(Stability,2026-05) | 433M | Community(<$1M 商用) | **CPU 可跑零 GPU 争用**、≤120s、官方 LoRA 文档 | 备选(降级路径) |
| Stable Audio Open 1.0 | ~2.5G | 同上 | 44.1kHz/47s,被 3.0 取代 | 不选 |
| MMAudio/AudioLDM2 | — | — | 上一代,质量落后 | 不选 |

**落地建议**(下轮实施):`toiv-sfx.service`(workstation :9102,i2l 同构 HTTP agent,~3-4G VRAM 放 GPU3 或 CPU offload)→ audio_orchestrate sfx 步调用(48kHz 经 aresample 入 24kHz 链)→ 501 解除。验证项:OpenMOSS-Team HF 权重 hf-mirror 可下、真实出音冒烟、时长对齐、采样率链。

---

## FLYWHEEL-2026-08-27 · H3 数据飞轮接线(trainer h3 支持 + 编排脚本,真训练实证)

**时间**: 2026-08-27
**类型**: 遗留推进「E_data_flywheel 在线训练回环未接线(依赖 D)」

### 落地

- **trainer agent h3 族支持**(arch=minimax_h3,模板按 8-23 实证 example.yaml):num_frames 17n+5 网格向上吸附(5/22/39/56,warning 透传)、cache_text_embeddings、MODELS_PATH 注入(仅 h3)、H3_LORAS_DIR 独立产物目录、跳过 ckpt 拼接(name_or_path 只取 tokenizer)
- **飞轮编排** `scripts/h3/h3_flywheel.py`:h3_lora_dataset 导出 winner 数据集 → 软链进 trainer DATASETS_DIR → `--free-h3` 驱逐推理缓存 → POST /train → GET /train/{id}(新增状态端点)轮询 → LoRA 路径报告
- **agent 新增** `GET /train/{id}` JSON 状态端点(飞轮轮询依赖,未知 id 404)

### 真机攻坚(4 连败 → 实证通过,全部转化为模板修正+回归测试)

1. **KeyError batch_size**(空回复断连):可选参数无默认值 → 全量默认值对齐 core TrainStartRequest,必填缺失 ValueError→400 不断连
2. **OOM 物理 GPU0**:YAML `device: cuda:2` 与 CUDA_VISIBLE_DEVICES 单卡视图冲突回退物理 GPU0 → 模板恒 `device: cuda:0`(物理卡由 subprocess env 指定,H3 实证范式)
3. **OOM GPU2 余量不足**(low_vram 仍差 74MB):GPU2 多租户(H3 推理 :8195 常驻 39G)→ low_vram 默认 true + 训练前 `POST :8195/free` 驱逐(56.3G→17.2G,推理自动重载)
4. **resume 误捡 + DONE 空路径**:共享 loras 根被 ai-toolkit resume 发现误捡 smoke4 的 optimizer.pt(torch.load 崩) → training_folder 每作业独立;ai-toolkit 自附加 name 层致产物双嵌套 → `_find_lora_file` 递归发现最新 safetensors

### 实证

- `h3_flywheel_smoke6_20260827.safetensors` **310MB rank16**(与 8-23 冒烟同规格),30 步 1:37(loss 0.137),DONE 路径正确回填
- ⚠️ **生产飞轮真实 e2e 待数据**:core evalbatch/evalscore 当前为空(核实 0 行),需先跑 best-of-n 评测批次累积 winner;编排脚本数据集为空时明确报错引导

### 测试/回归

- trainer agent 测试 21→**39 例**(h3 模板/吸附/device cuda:0/默认值/必填 400/每作业隔离/递归发现/状态端点)
- 全量:后端 **2333 passed**(144s)

---

## I2L-2026-08-27 · i2L 风格 LoRA 产品化(D_finetune → done)

**时间**: 2026-08-27
**类型**: 遗留推进「i2L API 产品化(剩上传流转+常驻服务)」

### 落地

- **agent**:`deploy/i2l-service/server.py`(标准库 http.server 与 toiv-trainer 同风格,torch/diffsynth 惰性 import 首调加载常驻显存 bf16 ~26G);流程逐行对齐 8-24 实证脚本(ZImagePipeline base+turbo TE/VAE → ZImage-i2L-v2 元模型一次前向 → 键名转 ComfyUI 兼容);multipart 自实现解析(cgi 已于 3.13 移除);单并发忙 409、同名 400(overwrite=true 除外)
- **部署**:`toiv-i2l.service` active+enabled(workstation GPU3 :9101,MemoryMax=48G);/health 双模型探测 true
- **core**:`POST /api/train/i2l`(multipart 1-8 图+lora_name,httpx 透传 600s;503 未配置/409 busy/400 透传/502/504 映射表;不写 TrainJob——单次前向无状态机,产物直落 NAS loras 自动发现);`TOIV_I2L_URL=http://192.168.71.127:9101`;已 deploy.sh 部署

### e2e 冒烟(真实链路)

- 3 张平涂矢量风 PNG → core `/api/train/i2l` → agent GPU3 → **1:59 出 LoRA**(首调含 NAS 模型加载)
- 产物核验:`i2l_smoke_20260827.safetensors` 19.9MB / **476 张量 rank4**(与 8-24 demo 一致)/ 键名 `diffusion_model.*.lora_A.weight` **0 坏键**;demo.png 438KB 落 NAS
- ⚠️ 教训:core 端新端点必须 deploy.sh 后才可 e2e(首跑 Method Not Allowed 系远端旧代码)

### 测试/回归

- 新增:agent 25 例(health/lora_name 清洗/busy 409/同名/multipart 解析/env)+ core 14 例(错误映射+成功链路+401)
- 全量:后端 **2315 passed**(88s)

---

## BACKLOG-2026-08-27 · 遗留盘点四连:评分器灰度 + trainer 部署 + 音频 mix/variant + 快速清理包

**时间**: 2026-08-27
**类型**: 用户诉求「推送后找未完成/低完成度内容继续推进」(四项全选;MacStudio 全线已下线不采纳,studio04 退役项跳过)

### ① 视频评分器生产灰度开启(B_eval 90%→100%)

- core `TOIV_VIDEO_SCORER_ENABLED=false→true`(阈值 0.65 不变),备份 `.env.bak-20260827-scorer`,toiv-api 重启 active,/api/health ok
- ⚠️ 旧硬约束「生产必须 false」经用户本轮明确授权变更(灰度观察降级率,异常秒回滚)
- **附带发现修复**:COMFY_WORKERS pc01 死节点 `192.168.71.115:8188`(DHCP 漂移残留,curl 000)→ `.116:8188`(200),重启后 workers 三活

### ② LoRA trainer :9100 常驻部署(D_finetune 40%→70%)

- `deploy/toiv-trainer.py` 移植 Linux:路径常量 env 化(Windows 默认值向后兼容)+ family 映射修正 + 不支持族 400 拒绝(禁静默套 sdxl 模板)
- **arch 字符串实测核验**(workstation ai-toolkit `extensions_built_in/diffusion_models/*/`,此前代码全错):
  flux2→`flux2` / klein→`flux2_klein_9b` / qwen*→`qwen_image` / z_image*→`zimage`(无下划线) / flux,flux1→内置 `flux`(is_flux) / sdxl*→`sdxl`
- **run.py 调用修复**:配置文件是位置参数(config_file_list),原 `--config` 会被当文件名解析
- 部署:`toiv-trainer.service` active+enabled(workstation);merged ckpt 视图 `/home/merlin/toiv-trainer/checkpoints/`(NAS checkpoints+diffusion_models 符号链接 12 文件);LoRA 产出落 NAS loras(ComfyUI 自动发现);`HF_ENDPOINT=hf-mirror`
- core `TOIV_TRAINER_URL=http://192.168.71.127:9100` 接通,/health `{"ok":true,"jobs":0}`
- 测试:`test_toiv_trainer_agent.py` 21 例(family→arch 参数化/400 拒绝/env 覆盖/Windows 默认兼容)
- **i2L 产品化评估**(下轮实施):需常驻 DiffSynth-Studio ZImage-i2L-v2 服务(3.6G,GPU2 余量 ~41G 可承载)+ 风格图上传流转 + LoRA 注册进资产库

### ③ 音频编排 mix/variant 落地(C_audio partial→mostly_done)

- **mix**:ffmpeg `aresample=24000` 归一 + `amix normalize=0 duration=longest` 真实混音;`inputs` 显式引用前序步骤产物,空输入/单输入/引用无产物 422,ffmpeg 失败 500 带 stderr
- **variant**:对最近 tts 步骤按 `duration_factors`(0.5-2.0,1-5 个)重跑真实合成(IndexTTS 2.5 支持语速扰动);无前序 tts 422、多语言源(ja/ko/yue 不支持语速)422 拒绝,不产相同文件冒充
- **sfx**:保持 501,文案改为明确引导(需音效引擎;列出当前可用 tts/separate/concat/mix/variant)
- 测试:`test_audio_orchestrate.py` 14/14(新增 8 例,真 ffmpeg 验证混音时长)

### ⑤+P2 快速清理包

- **IndexTTS2 systemd 化**:`toiv-indextts.service` active+enabled(替代 uv run nohup 裸进程,pid 396467/396471→539708),health ok(model_loaded=true,cuda:0);核实 emo_text=true 与旧进程一致(2.5 已稳定,STATE 2.0 时代 issue 核销)
- **contentpolicy 孤儿表**:核实 toiv 库 public schema 不存在(下线时零残留),核销
- **avatar-talk 瑕疵核销**:前端 641 全过(enginesAvatarTalk 用例在列),8-23 abort 修复有效,STATE known_issue 关闭

### 回归验证

- 后端 `pytest tests -q`:**2276 passed**(139s,较上轮 +28:trainer 21 + audio 7 净增)
- 前端 `tsc --noEmit` 0 错误 + `npm test` **641 passed**
- 生产:core toiv-api active、workstation toiv-indextts/toiv-trainer 双 service active

---

## REPO-RESTRUCTURE-2026-08-27 · 仓库结构系统性重组

**时间**: 2026-08-27
**类型**: 用户诉求「全面检查项目结构,识别混乱,按行业最佳实践重组并验证引用正确性」

### 变更清单

**删除(垃圾/陈旧)**:
- 根目录 `toiv.db`(误从仓库根启动 uvicorn 产生的 SQLite;正主 `apps/api/toiv.db` 不受影响)
- `apps/web/pnpm-lock.yaml` + `pnpm-workspace.yaml`(双包管理器陈旧轨,CI/构建统一 npm)
- `apps/web/responsive-test.js` + `scripts/` 内 9 个一次性调试脚本(debug_*×8/recon_login/_dump_metrics,零引用,Playwright spec 已覆盖)
- `apps/web/tmp/`、`test-results/`、`test-results-prod/`(未追踪实验/产物)
- `apps/api/.coverage` 移出 git 追踪(`.gitignore` 补 `.coverage`)

**移出仓库**:
- `opentalking/`(2.7G 嵌套 git 独立项目)→ 兄弟目录 `../opentalking`;代码仅经 URL `127.0.0.1:4403` 引用,移动前 `lsof +D` 确认无进程占用;`.gitignore` 保留 `opentalking/` 作防回潮守卫

**git mv 重组(保历史)**:
- `deploy/e2e_{audio,comprehensive,drama,h3,prod}_check.py` → `scripts/e2e/`(5 个 docstring 用法行同步更新)
- `scripts/` 26 个扁平脚本按职能四分:`e2e/`(冒烟链路 13)、`eval/`(评估 6)、`h3/`(LoRA 训练/恢复 4)、`ops/`(运维/探测/工具 9)

**引用更新**:
- AGENTS.md 3 处(超分 fleet/i2L 脚本/H3 LoRA 仓库脚本)
- 代码 docstring/注释 4 处:`workflows/video_upscale.py`、`workflows/longcat_video.py`、`workflows/model_wiki.py`(usage 用户可见串)、`routes/longcat_studio.py`
- `.gitignore` 修剪 16 条已不存在文件的陈旧条目,opentalking 注释更新
- 生产引用不动的部分:`deploy/deploy.sh`、`bare-metal/`、`*-service/`、`docker-compose.yml`、`drama/`(代码+compose 挂载引用)

### 验证结果

- 旧路径 grep 全仓扫描:**零残留**(`scripts/video_4k_upscale|scripts/longcat_smoke|deploy/e2e_|...` 16 个旧路径模式)
- 后端:`apps/api/.venv/bin/python -m pytest tests -q` → **2248 passed**(137s)
- 前端:`tsc --noEmit` **0 错误** + `npm test` **641 passed**
- 文档:DEVELOPMENT.md 新增「9. 仓库结构与命名规范」(顶层布局/边界规则/deploy 约定/scripts 四分组/命名规范)

---

## VIDEO-PIPELINE-2026-08-26 · 视频创作四模块落地 + 兼容性修复

**时间**: 2026-08-26
**类型**: 用户诉求「多镜头单次生成/关键帧链式转场/视频到视频编辑/Motion Brush 四模块无缝衔接」

### 四模块落地

**①多镜头单次生成(H3「镜头一…镜头二…」协议)**
- `services/multishot_protocol.py`:ShotSpec/MultiShotPlan + build_multishot_prompt 协议组装
- `POST /api/h3/multishot`(2-4 镜头,总时长 ≤15s,均分/自定义)
- 生产实证:多镜头 prompt 协议正确组装(「生成一段10秒...全片共两个镜头...镜头一(约5秒)...镜头切换:匹配切口...镜头二(约5秒)...」)

**②视频到视频编辑(Runway Aleph 式 in-context)**
- `WanVaceEditParams`+`build_wan_vace_edit_graph`(源视频帧序列→VACEEncode.input_frames,关键帧锚点 mask=0 保留/其余重生成)
- `POST /api/generate/video-edit`(五模式:object_replace/object_remove/style_transfer/relight/camera_change;关键帧 ≤5;preserve_mask 区域控制)
- ⚠️ motion_mask 继承但不消费,__post_init__ 显式拒绝(防静默无效)

**③Motion Brush 局部动效标记**
- `services/motion_brush.py`:BrushStroke/MotionBrushMask + generate_mask(RGBA:R=G=B 强度,A 方向角)
- `POST /api/motion-brush/mask`(源图+笔画→mask PNG)
- 生产实证:mask 生成成功(motion-brush-032a9860339e.png)

**④关键帧链式转场(≤5 帧,Pikaframes 指标)**
- 已完成(commit 20dca29):2-5 帧/段 1-10s/总长 ≤25s

### 兼容性修复(集成测试发现)

**修复 1**:`WanVaceEditParams.motion_mask` 显式拒绝(节点 50 已被源视频占用,编辑区域控制唯一通道是 preserve_mask)

**修复 2**:keyframe-chain 端点段级 motion_mask 透传接通:
- `KeyframeChainRequest.motion_mask` 字段补齐
- 段循环 `WanVaceParams.motion_mask=mask_name` 传入
- `seg_req.motion_mask=req.motion_mask` 快照存 Job params

### 集成测试(18 例)

| 场景 | 验证点 | 结果 |
|---|---|---|
| A | 多镜头→视频编辑(产物直作 source_video) | ✅ |
| B | Motion Brush mask→视频编辑(preserve_mask 区域控制) | ✅ |
| C | 关键帧链→视频编辑(三类 Job 共存) | ✅ |
| D | Motion Brush mask→转场链(段层+链端点双路径) | ✅ |

### 生产 e2e 最终验证

| 模块 | 验证点 | 结果 |
|---|---|---|
| 多镜头 | h3-multishot 引擎上架;协议组装正确 | ✅ |
| 视频编辑 | vace-edit 引擎上架;端点存在 | ✅ |
| Motion Brush | mask 生成成功 | ✅ |
| mask→关键帧链 | 段级透传;数据库实证 params motion_mask 完全正确 | ✅ |

**关键发现**:API `/api/jobs` 列表不返回 params 内容(设计如此,只有 `has_params: bool` 标记);数据库直接查询实证 `motion_mask='motion-brush-032a9860339e.png'` 完全正确。

### 回归与部署

- 后端 **2248 passed**(多镜头 29/视频编辑 31/Motion Brush 39/集成 18)
- 前端 **641 passed**(多镜头 9/视频编辑 20/Motion Brush 15)
- tsc 0 错误
- 部署:deploy.sh 全量;BUILD_ID 20260826-093929-c9e5cf9

**commit**: c9e5cf9

---

## VIDEO-PIPELINE-INTEGRATION-2026-08-26 · 视频创作管线四模块兼容性与无缝衔接验证

**时间**: 2026-08-26
**类型**: 集成验证(多镜头单次生成 × 关键帧链式转场 × 视频到视频编辑 × Motion Brush)

### 模块边界(输入/输出契约)

| 模块 | 端点 | 请求模型特有参数 | 产物 Job kind | 算力落点 |
|---|---|---|---|---|
| 多镜头单次生成 | `POST /api/h3/multishot` | `shots`(2-4 镜头)/`total_duration` | `h3_multishot` | H3 :8195(GPU2) |
| 关键帧链式转场 | `POST /api/generate/keyframe-chain` | `keyframes`(2-5)/`prompts`/`durations` | `keyframe_chain`(合并)+ `transition`(段) | VACE :8197(GPU0) |
| 视频到视频编辑(Aleph) | `POST /api/generate/video-edit` | `source_video`/`edit_prompt`/`edit_mode`/`keyframe_indices`(≤5)/`preserve_mask` | `video_edit` | VACE :8197(GPU0) |
| Motion Brush | `POST /api/motion-brush/mask` | `source_image`/`strokes`(≤64) | (mask PNG,不产生 Job) | 任意 worker(input 目录) |

### 模块间数据流(集成点)

- **产物 → 编辑源**:多镜头/关键帧链成片落 worker input 目录,文件名直传 `video-edit.source_video`(端点内 `transfer_drive_video` 同机直达/跨机转运;无音轨自动补静音轨,原声经 `audio=[50,2]` 回打包)
- **Motion Brush mask → 消费方**(PNG 文件名,三条通路):
  - `wan-vace`/`transition` 的 `motion_mask` 入参 → 生成图节点 50/51(`ImageToMask channel=red`,⚠️ alpha 是方向角编码不可直接当 MASK),与首尾帧并存时 52 `MaskComposite multiply` 取交集
  - `video-edit` 的 `preserve_mask` 入参 → 编辑图节点 62-66(`LoadImage→ImageToMask(red)→InvertMask`,白=保留→0 锚点语义;⚠️ 与 motion_mask 语义相反:brush 灰度=运动,preserve 白=静止)
  - `keyframe-chain` 端点段级透传 **未接通(已知缺口)**,替代路径=逐段 transition 已可用

### 兼容性矩阵

| 组合 | 状态 | 集成点/说明 |
|---|---|---|
| 多镜头 → 视频编辑(场景 A) | ✅ 可组合 | `h3_multishot` 产物文件名直作 `source_video`;e2e 断言编辑图 50 节点 `VHS_LoadVideo` |
| Motion Brush → 视频编辑(场景 B) | ✅ 可组合 | `preserve_mask` 与 `edit_prompt` 同参共存;图支路 62-66 + 出口 90 |
| 关键帧链 → 视频编辑(场景 C) | ✅ 可组合 | `keyframe_chain` 合并产物直作 `source_video`;`keyframe_indices` 锚点整帧保留向全片传播;三类 Job(段/合并/编辑)共存建档无 kind 冲突 |
| Motion Brush → 转场(场景 D 段层) | ✅ 可组合 | `transition.motion_mask` 已接通;与首尾帧 masks 经 `MaskComposite multiply` 交集(两约束同时生效) |
| Motion Brush → 关键帧链(场景 D 链层) | ⚠️ 缺口 | `KeyframeChainRequest` 无 `motion_mask` 字段(段 seg_req 按 TransitionRequest 构造,链路具备透传能力,接通需端点+段透传两行改动) |
| 多镜头 × 关键帧链 | ⛔ 互斥(设计) | 单段内切镜(H3 单 prompt 协议)vs 多段独立转场拼接(VACE),语义正交不同时使用 |
| 视频编辑 × 超分/时长链 | ✅ 可组合 | video-edit 复用 `_attach_duration_chain`(trim 策略)+ `resolution_target` 超分链 |

### 冲突点验证(全部通过)

- **参数命名空间**:四模块请求模型特有字段两两不相交(`keyframes/prompts/durations` vs `shots/total_duration` vs `source_video/edit_prompt/edit_mode/keyframe_indices/preserve_mask` vs `source_image/strokes`);共享接缝仅 `motion_mask`(生成/转场)与 `preserve_mask`(编辑),语义文档化
- **工作流图节点 ID**:生成图 mask 支路 50-52 / 编辑图源视频支路 50 + mask 批支路 60-90;两 builder 独立函数图实例各自唯一;⚠️ `WanVaceEditParams` 继承的 `motion_mask` 字段在编辑图**不消费**(节点 50 已被源视频占用),误传静默无效——测试已钉死,编辑区域控制唯一通道是 `preserve_mask`
- **资源占用**:transition/keyframe-chain/video-edit 共用 :8197,三端点均经同一 `_wan_precheck_or_hold` 显存/RAM 预检(hold FIFO 排队);关键帧链整链只预检一次不逐段叠加;多镜头走 H3 :8195 独立预检,与 VACE 链路无资源竞争
- **路由命名**:Aleph `/api/generate/video-edit` 与 OpenCut 时间线剪辑 `/api/video-edit/render`(既有不同模块)并存不冲突
- **tracker 孤儿检测**:`keyframe_chain` 合成 id(chain-*)已豁免;`video_edit`/`h3_multishot` 为真实 prompt_id 无需豁免
- **作品库归桶**:`h3_multishot`/`keyframe_chain`/`transition`/`video_edit` 全部归前端视频桶(编辑源选择器可选)
- **助手工具链**:`h3-multishot`/`keyframe-chain` 已注册 `submit_generation` 分发;`video-edit`/`motion-brush` 未注册(落地时按同表扩展)

### 前端编辑器共存(GenerateView)

- 数据驱动引擎列表;`customEditor`(isChain/isMultiShot/isVaceEdit)专用编辑器互斥让位标准 PromptBar+参数分组
- 参数按引擎 id 分槽(`valuesByEngine`/`motionMaskByEngine`),切引擎不丢输入、参数面板互不干扰
- Motion Brush 按钮仅 `MOTION_BRUSH_ENGINES`(wan-vace/wan-transition)门控显示(H3 无 mask 输入、SCoPE 契约无 mask 字段,后端同规则);参考图变更自动失效清除已生成 mask
- `AiVideoEditView`(vace-edit 引擎)/`MultiShotEditor`(h3-multishot)/`KeyframeChainEditor`(keyframe-chain)各自承载提交链路,canSubmit 标准链路对专用编辑器引擎永不触发

### 测试

- 后端 `test_integration_video_pipeline.py` **18 例**(横向兼容性 10:命名空间/路由/注册表/agent 分发/tracker 豁免/双图节点布局/语义陷阱/共享预检/前端归桶 + 场景 A-D 7 + brush 服务层 1)
- **全量回归:后端 2248 passed / 前端 626 passed / tsc 0**(含并行落地的模块自测:multishot/motion_brush/video_edit/keyframe_chain)
- 前端脆弱性修复 1 处:`enginesTransition.test.ts` ③ uploadKind 断言 `indexOf`→`lastIndexOf`(Motion Brush 门控引入同名字符串前置出现)

### 遗留缺口(后续任务)

1. **场景 D 链层**:keyframe-chain 端点段级 `motion_mask` 透传未接通(测试 `test_scenario_d_keyframe_chain_mask_gap` 已钉死现状,接通后翻转)
2. **语义陷阱**:`WanVaceEditParams.motion_mask` 继承字段编辑图不消费,误传静默无效(测试已固化;长期可在参数类 `__post_init__` 拒绝或映射到 `preserve_mask`)
3. **助手工具链**:`video-edit`/`motion-brush` 未注册 submit_generation 分发(注册后助手可自然语言驱动编辑/动效)

---

## KEYFRAME-CHAIN-2026-08-26 · 关键帧链式转场(对标 Pika 2.5 Pikaframes)

**时间**: 2026-08-26
**类型**: P2 路线图任务落地(用户诉求「多镜头单次生成功能中的关键帧链式转场」)

### 数据结构与接口

- `KeyframeSegment`:first_frame/last_frame/prompt/duration_sec/frames/steps/cfg/seed(段种子=基础 seed+段序号)
- `KeyframeChainPlan`:segments tuple/total_duration/fps/width/height/seed + `to_params()` 快照
- `validate_keyframe_chain()`:2-5 帧/段 1-10s/总长 ≤25s/prompts/durations 数量=段数 → `KeyframeChainError` 转 422

### 平滑过渡算法

N 帧→N-1 段,段 i 尾帧=段 i+1 首帧(用户关键帧,天然零跳变);durations 缺省每段 5s 均分;帧数按 VACE 4k+1 网格向上吸附(`snap_engine_frames`);整链一次 `_wan_precheck_or_hold` 资源预检。

### API

`POST /api/generate/keyframes-chain`:
- 参数:keyframes(2-5 上传句柄)/prompts(单 string 全段共用 或 list 逐段)/durations(list 或 None=均分)/width/height/steps/cfg/seed/worker
- 合并 Job(kind=keyframe_chain,params 存链计划+段 prompt_ids)+段 Job(kind=transition 保留调试)
- 后台合并链:`_wait_files` 逐段等产物→`_concat_trim` 精确裁→回传 worker→`rewrite_job_result` 回写;api 重启按 params 快照幂等重挂

### 前端

`KeyframeChainEditor.tsx`:2-5 槽位上传(AssetPicker)/拖拽排序/段参数卡(时长滑块/提示词)/总时长预览/段进度;GenerateView「关键帧链」引擎选项;canSubmit 护栏。

### 兼容性

- 既有 transition 端点零改动(复用 `generate_transition` 内部函数)
- 与 DurationPlan extend 策略正交(多组独立转场 vs 单视频续写)
- tracker reconcile 跳过 `kind=keyframe_chain` 重挂(合成 prompt_id 防孤儿误杀)
- R18:X-NSFW 上下文段 Job 与合并 Job 全链打标

### 测试

- 后端 `test_keyframe_chain.py` **35 例**(校验 8/拆分 7/合并链 2/端点 18)
- 前端 `keyframeChain.test.ts` **13 例**(总时长/拖拽/门控/载荷契约/段进度)
- **全量回归:后端 2168 passed / 前端 601 passed / tsc 0**

### 生产 e2e

| 验证点 | 结果 |
|---|---|
| keyframe-chain 引擎上架 | ✅ video 类 |
| 校验路径(1 帧) | ✅ 422 too_short |
| 3 帧链式转场提交 | ✅ 合并 Job prompt_id=chain-*,2 段 segment prompt_ids,total_duration=6.0 |
| 合并 Job + 段 Job 建档 | ✅ keyframe_chain + 2× transition 全部 queued |

**commit**: 20dca29

---

## ROADMAP-2026-08-26 · 竞品调研路线图 P0/P1 四任务全落地

**时间**: 2026-08-26(凌晨)
**类型**: 竞品驱动功能开发(用户诉求「市场调研→路线图→直接开始推进→优化低分项」)

### 竞品调研(5 家并行)

| 竞品 | 核心启示 | ToIV 差距 |
|---|---|---|
| liblib.tv | 画布抽象层级/宫格分镜/3D 导演台/Agent Skill 开放 | 画布 UX/模板生态 |
| 即梦 AI | 全能参考一致性/Agent 小章鱼/分镜时间轴 | 多模态参考/自动成片 |
| Runway Gen-4.5 | Aleph in-context 编辑(改一帧传播全片+预览帧)/Act-Two 手指级表演捕捉/Media Router 语义路由 | 视频到视频编辑/局部动效 |
| Pika 2.5 | **Pikaffects 一键物理特效**(melt/explode/crush)/Pikaframes 关键帧链 | **特效预设空白**(P0) |
| Vidu Q3 | **@主体库全局资产**(@牛仔 @酒吧)/16s 声画同出/多镜头自动切镜 | **主体库非全局**/**@引用无感知**(P1) |
| PixVerse V6 | **首尾帧 Transition**/MultiShot 多镜头 | **首尾帧无产品形态**(P0) |
| 海螺 H3 | 导演模式 15 运镜指令/Motion Brush 局部动效 | 局部动效(P2) |

**护城河确认**:R18 无审查/私有算力零边际成本/数据飞轮/LoRA 训练管线/3D 管线——五家全空白。

### P0 落地(已部署 core)

**①特效预设体系**(对标 Pikaffects)
- `services/effect_presets.py`:17 物理特效(melt/explode/crush/inflate/squish/levitate/dissolve/deflate/eye-pop/shatter/freeze/burn/vanish/transform/camera-shake/petrify/crystallize),H3 自然语言风格英文 prompt,R18 兼容注明
- engine_registry 三链路注入(h3-t2v/h3-nsfw-t2v/wan-nsfw-i2v),GenerateView 特效下拉+描述展示
- 生产实证:H3 melt 特效提交,Job prompt 以「The subject melts like warm wax...」开头

**②首尾帧生成入口**(对标即梦/PixVerse)
- `POST /api/generate/transition`(Wan VACE 首尾帧,首帧兼作 ref 锚点)+ wan-transition 引擎注册
- 前端双上传框(AssetPicker 从作品库选)+ Job kind=transition
- 生产实证:wan-transition 引擎上架(14 SFW/22 R18 全量)

### P1 落地(已部署 core)

**③全局主体库**(对标 Vidu My References)
- `Entity` 全局表(kind=character|scene|prop)+ CRUD API+drama_studio 双源读取(同名优先全局,回退项目卡)+启动幂等迁移(3 次 init_db 只产 1 条)
- EntitiesView 管理页(三类 tab+卡片网格)+GenerateView 主体引用多选
- 生产实证:entities count: 17(含迁移);新建主体 200

**④@主体引用前台化**(对标 Vidu @语法)
- `PromptWithEntities` 组件(@触发选择器/↑↓Enter 键盘导航/chip 预览绑定详情/×删除联动重编号)
- 三处接入:GenerateView 视频 prompt/ImageEditView 编辑指令/AssistantView 助手输入框
- h3_refs entity_ids 优先路径+H3 直接路由 `_apply_entity_refs` 注入层(本会话补接)
- 生产实证:`@图片1作为倒霉蛋身份与服装参考` 引用行正确注入 prompt 绝对开头

### 回归与部署

- 后端 **2133 passed**(P0 +30 例/P1 +29 例/h3_studio entity_ids 2 例)
- 前端 **588 passed**(P0 +12 例/P1 +23 例)
- tsc 0 错误
- 部署:deploy.sh 全量(P0)→ --skip-web(P1 路由补接);BUILD_ID 20260825-205715-dc03f53-dirty

### 剩余路线图(P1 未完/P2)

| 优先级 | 任务 | 状态 |
|---|---|---|
| P1 | 多镜头单次生成(H3 单段「镜头一…镜头二…」协议) | 未启动 |
| P2 | 关键帧链式转场(≤5 帧,Pikaframes 对标) | 未启动 |
| P2 | 视频到视频编辑(Aleph 式 in-context) | 未启动 |
| P2 | Motion Brush 局部动效标记 | 未启动 |

---

## STUDIO-MIGRATION-2026-08-26 · Studio 依赖全迁离:反推 VLM → spark01,core 对 Studio 零依赖

**时间**: 2026-08-26(凌晨)
**类型**: 生产拓扑迁移(用户诉求「Studio 无法使用,所有服务全部转移」)

### 根因真机核查

- EXO 集群(studio01:52415)端口活着但**模型实例全部丢失**:`/v1/models` 只剩 MiniMax-M2.7-4bit,Kimi-K2.7/GLM-5.2 请求 404 "No instance found"
- studio04 :9303 NAS 挂载静默失效(D-2 重演,≥9 天)→ 本会话先手动 `mount_smbfs` 修复了一次
- L2/L3 文本层**已事实在 spark02**(生产 .env 实证 `TOIV_LLM_L2/L3_BASE_URL=192.168.71.84`),EXO 丢失零影响
- core 对 Studio 唯一硬依赖 = 反推 VLM(`TOIV_REVERSE_VLM_BASE_URL` + NAS 中转 `TOIV_REVERSE_VIDEO_MAC_PREFIX`)

### 迁移动作(2 行 .env,零新增部署)

```
TOIV_REVERSE_VLM_BASE_URL=http://192.168.71.113:9303/v1 → http://192.168.71.82:8000/v1  # spark01 Qwen3-VL-32B
TOIV_REVERSE_VIDEO_MAC_PREFIX=/Users/dgmt-studio04/nas_mnt → (空)                        # vLLM 认 base64 video_url,免 NAS 中转
```

- 备份:`/home/merlin/toiv/deploy/.env.bak-20260826-studio-migration`;`sudo systemctl restart toiv-api`(SSH merlin 无免密 sudo,须 `sudo -n`)
- 顺带消除 studio04 NAS 挂载单点(视频不再走 SFTP 中转)

### 生产 e2e(4/4 通过)

| # | 用例 | 结果 |
|---|---|---|
| ① | SFW 图反推(纯色图) | ✓ 准确描述+生成 negative |
| ② | R18 图反推(JoyCaption 专线,不受迁移影响) | ✓ 露骨描述如实输出 |
| ③ | R18 视频反推(spark01 直传新路径) | ✓ 30s,828 字符忠实描述无拒答 |
| ④ | SFW 视频反推(18MB 大文件) | ✓ 48s,tracking shot 等六段式完整 |

R18 无审查验证(用户本地测试诉求):spark01 Qwen3-VL-32B-Instruct-FP8 为官方对齐版,但评分/反推场景实测三次(文本探针/真实 R18 图/真实 R18 视频)均无拒答——system prompt「技术质量评审,不涉及内容审核」框架引导有效。

### 文档同步

AGENTS.md(设备清单 studio04 划线/Core 状态表迁移行/E-5 易错点改写)· fleet_registry.py(studio04 :9303 标注退役观察)· STATE.json(新增 studio_dependency_migration_2026_08_26)

### 回滚与后续

- 回滚:恢复 .env 两行+重启,30s;studio04 :9303/挂载保留不删
- 观察一周稳定后:`launchctl unload com.dgmt.toiv-vlm-mlx`(studio04 彻底退役 ToIV 依赖)
- 注意:spark01 现承担 评分+反推 双职责(低频反推 vs 未开灰度的评分,冲突概率低,开启视频评分器灰度后观察)

---

## GPU-REBALANCE-2026-08-25 · GPU2 过载三方换卡均衡 + 后室成片交付

**时间**: 2026-08-25(晚)
**类型**: 运维拓扑调整 + 观测/预检代码同步(用户诉求:四卡摊开负载避免单卡 OOM)

### 成片交付

后室 Level-1 12 段批次全 done,无损 concat **94.6s / 18.3MB** → NAS `toiv/films/backrooms_level1_final.mp4`,DB result 回填(作品库可播)。

### 换卡方案(真机 nvidia-smi 进程级核查后定)

GPU2 峰值 92.9% 根因 = H3 40G + JoyCaption 16.3G 常驻(transformers 不驱逐)+ LongCat 按需 25G 三叠加;GPU1/3 大块(LiveAct 57.7G/FlashTalk 49.5G)无处可接不动。三方换卡:

1. JoyCaption GPU2→GPU0:`start.sh` 改 `CUDA_VISIBLE_DEVICES=0`
2. LongCat GPU2→GPU0:drop-in `gpu0.conf` 覆盖 ExecStart,**新增 `--cache-lru 3`**(原无驱逐,空闲常驻 25G;改后作业完自动释放)
3. 四小音频(sensevoice/qwen3tts/cosyvoice3/fireredasr)GPU0→GPU2:改既有 `gpu0.conf`

### 落卡实证

joycaption/longcat pid 归 GPU0,四音频归 GPU2;GPU0 69.4G / GPU2 55.7G(原 92.9%);六服务 active + 端口响应。新稳态:GPU2 = H3+demucs+超分+四音频,峰值 ~78G 安全;GPU0 常驻 ~66G + 池缓存可驱逐。

### 代码同步(共卡假设纠偏)

- `config.h3_co_workers` 默认值剔除 :8197(LongCat 已不在 GPU2,跨卡驱逐无意义),仅留 :8262
- `routes/observability.py` GPU_TOPOLOGY:8197 归 GPU0 卡;`services/fleet_registry.py` 标签同步
- longcat/wan_video/wan_animate/wan_vace/longcat_studio/engine_registry 注释 GPU2→GPU0 同步
- `tests/test_observability.py` 断言随拓扑更新(8197 离线实例归 GPU0 卡)

### 回归

后端 **2079 passed** / tsc 无前端改动;已部署 core(`deploy.sh --skip-web`)。AGENTS.md 第三节 GPU 分配表 + 第七节决策记录已同步。

---

## H3-MULTI-2026-08-25 · H3 多实例 least-loaded 调度框架(资源窗口即插即用)

**时间**: 2026-08-25(午后)
**类型**: 吞吐扩容框架(用户诉求"加速但不影响质量、不停服务")

### 资源账真机核查(为什么现在不能双实例)

- H3 进程 37.2G RSS 中 **30.5G 是 RssAnon(匿名内存,不可回收)**,页缓存仅 0.13G——第二实例 RAM 增量实打实 30G+,workstation available 仅 12G ❌
- pc02(RTX 5090) 32G < H3 int8 峰值 30-33G+开销 ❌(且 SSH 直连不通,只能经 core 跳板)
- GPU1/3 空闲各 12-16G < 30G ❌;降 steps/蒸馏/分辨率=质量变化 ❌;停 animate2/scope 用户否决 ❌
- 结论:当前 12 段批次数学上无法无损加速(S1 实测 14min/段),照跑

### 交付:多实例调度框架

- config 新增 `TOIV_H3_BASE_URLS`(逗号分隔);`pick_h3_client()` 并发探 queue_len 选最短,探测失败跳过、全挂回退首实例
- 单实例配置走 `get_h3_client()` 原路径,**零行为变化**(所有旧测试桩 get_h3_client 自动兼容)
- 提交路径统一接 pick:t2v/i2v 路由、时长链 duration chain、drama 续镜、生成器抽象层
- 未来窗口(RAM 扩容/某大 RAM 服务退役)→ workstation 起 :8196 + 改一行 .env 即吞吐×2

### 回归

后端 2143 passed(全量 2079 + duration 64;新增 test_h3_multi_instance 7 例)/ 已部署 core(api 重启零影响在跑批次,4/12 done 继续)。commit 3e99f2c。

---

## ASSISTANT-FIX-2026-08-25 · 助手「立即超时」根治:真实错误透出 + 404 会话降级

**时间**: 2026-08-25
**类型**: Bug 修复(用户实证三连:真实错误不显示 / 刷新+历史才能看到问题 / 再提问立即「超时」)

### 根因

1. **真实错误被吞**:`AssistantView.requestReply` 的 `catch { failed = true }` 丢弃 Error、SSE 流内 `{type:"error"}` 事件只置 `streamError` 丢弃 `content` → 一律误报「回复失败:连接中断或超时,请重试」
2. **404 无自愈**:刷新后携带失效会话 id(session_id 404「会话不存在」),被同样误报为「超时」且永远不自愈

### 修复

- `agentChatStream`/`agentChatResume` 非 2xx 抛错携带 `err.status = res.status`(lib/api.ts)
- AssistantView:catch 保留 `e.message`+`status`、流内 error 事件保留 `content`,错误气泡优先显示真实原因,无法归因才回退通用超时文案
- 404(!resume)自动清 `activeConvIdRef/lastSessionIdRef` 并以新会话重试一次(不再显示超时)

### 验证

前端 549 passed(assistantAgentEvents 新增 3 断言)/ tsc 0;生产实证:正常对话流 text+done 通、假 session_id 404「会话不存在」由前端自动降级新会话重试、不再误报超时。commit 047dfba。

---

## P0-SWAP-2026-08-25 · Qwen3-VL-32B 替换 molmo2 + Hunyuan3D 2.1 纹理管线上线

**时间**: 2026-08-25
**类型**: P0 服务替换 ×2(评分/反推 VLM + 3D 纹理缺口)

### P0-a Qwen3-VL-32B-Instruct-FP8(spark01 替换 molmo2-8B)

- spark01 `qwen3vl32b` 容器(vLLM):served 别名 `qwen3-vl-32b`/`molmo2-8b`/`omni-captioner` 三在线,core .env 零改动兼容
- core 指向(生产 .env 实证):`TOIV_VLM_SERVER_URL`/`TOIV_EVAL_VLM_BASE_URL+MODEL`/`TOIV_OMNI_CAPTIONER_BASE_URL` 全部 spark01:8000
- **video→video_url 修复**:vLLM Qwen3-VL 只认 OpenAI 标准 `video_url`(scoring.py + eval_scorers.py 两处),旧 `"video"` 字段直接 400
- e2e(core→spark01):白底 PNG→"White"、红色 1s 视频(video_url)→"Red",双模态无幻觉;对照 08-24 molmo2 评分幻觉(没变化打 10/有效编辑打 0)根治
- fleet_registry:spark01 角色/服务名同步(vllm 探测 /v1/models)
- 注:`TOIV_VIDEO_SCORER_ENABLED` 生产保持 false(灰度开关,就绪未开)

### P0-b Hunyuan3D 2.1 纹理管线(toiv-hy3dtex :9404)

- **架构**:core `POST /api/3d/texture` → workstation toiv-hy3dtex(原生 hy3dpaint v2-1:多视图扩散 6 视角 + DINOv2-giant + RealESRGAN×4 增强 + PBR 烘焙)→ GLB 产物 + Job(kind=threed_texture);systemd enabled,GPU0,MemoryMax=48G
- **环境攻坚(sm_120 Blackwell)**:torch 2.7.1+cu126 无 sm_120 内核 → 换 torch 2.13.0+cu130;custom_rasterizer 源码重建(CUDA_HOME 借 ComfyUI-hunyuan3d venv 的 nvidia/cu13,pip cuda-toolkit 不含 nvcc);basicsr 打 torchvision functional_tensor 补丁 + `--no-build-isolation --no-deps` 装法(setup.py 需 torch/scipy 且依赖 tb-nightly 不存在);realesrgan 同法;diffusers 0.40 自定义管线须 `trust_remote_code=True` 补丁;trimesh 5.x `simplify_quadric_decimation` 首位参数变 percent,改 `face_count=` 关键字
- **Blender 缺位**:官方 obj→glb 依赖 bpy(静默失败)→ server.py 内改 trimesh `PBRMaterial`(albedo + metallicRoughness 合并贴图 R=AO/G=rough/B=metal)自转 GLB
- **参考图三优先级**:显式 image > 原图生3D 作业 params 回填 > 纯白图+文本引导(管线 text_prompt ToIV 补丁)
- 冒烟:球体+参考图 38.7s(含冷载)/9.5s(暖);产物 GLB 实证含 baseColorTexture + metallicRoughnessTexture
- **生产 e2e**:hunyuan3d 作业 7dd05aaa → 「金属质感,轻微锈蚀」→ 47.5s 产出 3.4MB PBR GLB,文件端点 200,作品库 3D 桶可见;fleet 探测 :8200/:9404 双 up

### 前端/工具

- 灯箱 ThreeDOpsBar 新增「AI 纹理贴图(约几分钟)」折叠区:风格描述输入 + 生成按钮(busy 态分钟级提示);lib/api threeDTexture(960s timeoutMs 覆盖);libraryQuery 收录 threed_texture(3D 桶+「3D 纹理」短名——路由注释声称已收录实为漂移,本轮回补)
- 助手 adjust_3d 新增 op=texture(系统提示同步,旧「纹理绘画暂不支持」断言同步更新)

### 回归

后端 2077 passed(新增 test_threed_texture.py 6 例)/ 前端 546 passed(新增纹理 2 例+mock 替身)/ tsc 0;已部署 core(deploy.sh core-ts,Mac 离 LAN 走 Tailscale)。

---

## QWEN-EDIT-2026-08-24 · Qwen-Image-Edit 上 pc02 全链路 + 评测矩阵首秀

**时间**: 2026-08-24(凌晨)
**类型**: 新引擎接入(pc02 5090 专用实例)+ 全面评测 + 低分项优化

### 链路验证

- pc02 :8194 专用实例(StartComfyUIEdit 计划任务);源图服务端转存(源 worker /view → :8194 /upload/image)
- 生产 e2e:upload → POST /api/generate/qwen-edit(camera=rotate_left,fast) → done,签名产物 URL 200;卡通男孩 45° 侧转完美
- 图构造:UNETLoader(fp8)+CLIPLoader(qwen_2.5_vl_7b)+双 LoRA 链(多角度仅选角度时挂,Lightning 常挂)+TextEncodeQwenImageEdit(正接 vae+image)

### 评测矩阵(12 例,molmo2 初评 + 人工目检校准)

| 用例 | VLM(molmo2-8B) | 人工目检(ground truth) |
|---|---|---|
| char 语义×2+相机×4 | 8-10 | 9-10,全优(赛博朋克/红帽/双旋转/俯视/特写全生效) |
| ink 语义·赛博朋克 | 1/3/2 | IF 2(只变了对比度+飞鸟),跨美学风格迁移失败 |
| ink 语义·红帽 | 0(误判"完全相同") | IF 6(亭顶变红,无人物主体可戴帽) |
| ink 相机·特写 | 5/3/2(过严) | IF 7(亭子特写真推近了) |
| ink 相机·旋转/俯视×3 | 10(幻觉,实际没变) | IF 2,确认未生效 |

**教训:molmo2-8B 不能当编辑质量评委**(没变化的打 10、有效编辑打 0);规模化评委候选=studio04 72B caption + spark02 文本评审两段式。

### 低分项优化(⑦)与结论

风景场景相机旋转四组对照(strength 1.3 / 标准档 20 步 cfg2.5 / cfg 3.5 / 英文指令)**全部无效** → 结论是 LoRA 训练分布硬限制(主体/角色向),非管线 bug。处置:前端相机下拉加适用范围提示,不硬凹。

### 回归

后端 1944 passed / 前端 450 passed / tsc 0;已部署 core;引擎计数 SFW 12 / R18 20。

---

## UX-2026-08-23 · 内容管控下线 + 作品库回收站 + 助手 Shift+Enter 与灯带重设计
 · 内容管控下线 + 作品库回收站 + 助手 Shift+Enter 与灯带重设计

**时间**: 2026-08-23(午后)
**类型**: 用户拍板的功能下线 + 两个 UX 特性(均已部署 core)

### ① 内容限制管控(CONTROL)完整下线

- 用户拍板该板块自行重做 → 全量移除:`nsfw_ctx.py` 回退 HEAD(nsfw_allowed 恢复为未成年硬阻断+X-NSFW 头语义)、`ContentPolicy` 表类、`GET/PUT /api/content-policy`、设置页管控卡、`test_content_policy.py`(12 例)、conftest 策略缓存 fixture;全仓 grep 零残留
- **遗留**:生产 core 数据库 `contentpolicy` 表成孤儿(代码已不引用;如介意可手动 DROP TABLE)
- AGENTS.md 第五节「内容限制管控」行随之失效,引擎矩阵行保留(R18=Wan2.2+LTX2.3 不变)

### ② 作品库回收站(全栈)

- 后端:`GET /api/jobs/trash`(归属隔离/保留期内/deleted_at 倒序/分页)、`POST /api/jobs/{id}/restore`、`DELETE /api/jobs/{id}/permanent`;**保留期 10 分钟→72 小时**(audit.UNDO_TTL_SECONDS,undo token 语义跟随);新增 `trash_purge_loop`(lifespan 每小时兜底物理清理超期行——此前「过期物理删除」只有注释没有实现,本次补齐)
- 前端:LibraryView 工具行「回收站」入口 → `LibraryTrashView`(复用作品卡样式,卡脚显示删除时间+剩余保留期 `formatRetention`,恢复/彻底删除 Modal 二次确认,空态文案);恢复后 invalidateJobs 主列表自动回归
- 测试:后端 test_jobs_trash.py 6 例 + 前端 libraryTrash.test.ts 6 例

### ③ AI 助手唤起 ⌘K → Shift+Enter + 灯带/弹窗重设计

- 快捷键:纯 Shift+Enter(排除 meta/ctrl/alt,不碰 ⌘Enter 提交);输入框内保留原生换行;可发现性提示键位与文案同步
- **灯带隐形根因根治(存量 bug)**:CSS keyframes 驱动注册自定义属性 `--neon-angle` 的逐帧重绘在本页层叠树下被 Chromium 整体丢弃(首开无光,生产构建同现)——改 **JS rAF 逐帧内联驱动**(easeInOutQuart 1400ms 扫 0→430° 过冲+首尾淡入淡出);assistant.css 改主包 eager 加载(首开样式必达)
- 新灯带:双层 conic 叠加(青#67e8f9→紫#a78bfa→品红#f0abfc 彗核 + 30% 静态三色整环)+ 三层 drop-shadow(6/18/44px)+ 4px 环带 + will-change 合成层;暗/亮双色截图验收
- 弹窗:玻璃拟态(blur 28px saturate)、18px 圆角、弹簧展开(translateY+scale)、开场 1.1s 边缘光晕与灯带收束联动、圆形玻璃关闭 chip
- 测试:assistantPopupNeon 9→11(rAF 驱动/触发键语义);reduced-motion 直开不破

### 回归与部署

- 后端 **1930 passed**(1917-12 管控+15 资源预算+2 TTS+6 回收站等;test_duration flaky 2 例本轮全量未复现);前端 **439 passed** + tsc 0 + ui_lint 过;web 干净构建;deploy.sh 部署 core

---

## AUTONOMY-2026-08-23 · 自主循环工程:ltx25 根治 + 前端 P0 修复 + 资源预算预检 + 10Eros-Max 实测 + roadmap A 闭环

**时间**: 2026-08-23(凌晨)
**类型**: 用户授权完全自主的循环工程(六任务),全部改动已部署 core 并真机验证

### ① ltx25 彻底退役(根治复活)

- 调研拍板:Civitai/HF 实证 LTX2.5 生态空白(Civitai LoRA 近乎为零、HF 社区 NSFW 0 结果、官方仓 gated:auto),定位已被 H3 全覆盖 → `systemctl disable --now comfyui-ltx25`(inactive+disabled,重启不再复活);GPU3 88.6→54.1G,RAM available 54→90G;NVFP4 模型文件留盘可回滚
- 同轮调研副产品:LTX2.3(Sulphur/10Eros 血脉)与 MiniMax-H3 生态正盛,Wan2.2 NSFW 霸主地位不变;Wan2.5/2.6 官方不存在

### ② 前端 P0/P1 四项修复(子代理实施,+13 测试)

- **avatar-talk 提交断链**:`lib/engines.ts` 补 `case "avatar-talk"`(载荷对齐 `POST /api/avatar/talk` 契约)+ `normalizeEngine()` 把注册表 text 型 audio 参数归一为 `audio`(GenerateView 才渲染音频上传);uploadKind 映射补 `avatar-talk→avatar`;**生产 e2e 实测通过**(人像+TTS 音频→数字人口播视频成片,唇部动作逐帧可见)
- **trackJob abort 卡死**:`trackJob.ts` 新增 `signal?: AbortSignal` + `TrackJobAbortError`(abort 走 aborted 终态立即 settle,看门狗不复活);`useGeneration.ts` start 建 AbortController、reset abort 优先——取消后 submitting 正常复位
- **TTS 产物落 Job**:前端 AudioView 合成后 `invalidateJobs()` + libraryQuery 补 `manju_voice→配音` 映射;**后端** `routes/voice.py synth_voice` 落盘后建档 `Job(kind=manju_voice, status=done, result=[/api/manju/voice/{name}])`(建档失败 try/except 不炸主流程,+2 测试)
- **AssetPicker 分页去重**:`mergeJobsPage` 按 id 去重 + 「加载更多」分页(offset=已加载条数,对齐 LibraryView 范式)

### ③ 资源预算预检(VRAM+RAM,H-3 OOM 制度化)

- 新建 `services/resource_budget.py`:`ensure_host_ram`(读 /system_stats 的 system.ram_free,不足→队列空时 free_memory+5s 落定→复查→503 结构化原因;stats 读失败降级放行)+ 通用 `ensure_vram`
- 接线:`h3.ensure_h3_vram` 三处出口接 RAM 预检(25G)、`wan_video.ensure_wan_vram` 两处(15G)、`longcat.submit_longcat_job` 双预检(VRAM 26G+RAM 15G,新增 `prechecked` 参数防 Wan 路由双重拦截,Avatar 链路顺带获得护栏)
- config 新增四项阈值;**生产实证**:avatar-talk 提交被 LongCat VRAM 预检正确拦截(23.7G<26G,结构化 503 错峰提示)

### ④ 10Eros-Max(H3 嫁接版)实测

- 下载 cicalooo/10Eros-Max-h3-int8-convrot 三件套(fl2va/ref2va/TURBO,共 ~58G)+ Sulphur-2 dev fp8mixed(29G,LTX2.3 系 t2v 补强)+ 官方 distill LoRA + 无审查提示词增强器 GGUF → NAS toiv/comfyui-models(脚本 /home/merlin/toiv_model_pull.py,经 TS 代理)
- **R18 实测(同 prompt 同 seed 对照)**:10Eros-Max fl2va 与 stock H3 均出裸体(stock 本身不拒轻度 NSFW),10Eros 版露骨度/姿势主动性更胜;**音画直出完好**(h264 1280×704 3.04s + aac 音频,嫁接未伤音频头)——H3 正式具备 R18+音画能力,矩阵可向「H3 主力 + Wan2.2 生态兜底」演进

### ⑤ roadmap A 闭环(次世代图片模型端到端 GPU 验证)

- 三族配方直提 worker :8189 全部 success 且出图质量在线:Z-Image-Turbo(res_multistep+simple cfg1 8步)/FLUX.2 dev(euler+simple cfg1 25步+FluxGuidance)/Qwen-Image(euler cfg3.5 20步)
- **修真 bug**:qwen_image 配方默认编码器 `qwen_3_vl_8b_instruct`(目录名)在 worker CLIPLoader 枚举里只有分片路径,`first_available` 永远命不中 → 静默降级 1.0 编码器;改用实测存在的 `qwen3vl_4b_fp8_scaled.safetensors`(Qwen3-VL 单文件)为首选候选
- API 级 e2e(生产 core):`POST /api/generate/txt2img` z_image_turbo → done,产物带签名 URL 可下载(1184×1184 PNG);`default_ckpt=flux2_dev_fp8mixed` 默认底模切换此前已在码,本次验证闭环

### 回归与部署

- 后端 **1934 passed**(1917+15 资源预算+2 TTS 建档;test_duration 2 例曾在全量高负载下偶发失败,单跑 74/74 过,判 flaky 计时敏感,记录观察);前端 **431 passed**(418+13)+ tsc 0 错误 + ui_lint 通过;web `rm -rf .next` 干净构建;deploy.sh 部署 core 双服务就绪
- 生产验证:TTS 合成→Job 建档实测通过;avatar-talk 引擎注册表在线(前端归一后音频参数渲染);Z-Image API 出图实测通过

---

## DOCS-CLEANUP-2026-08-23 · 文档治理(下一阶段起点)

**时间**: 2026-08-23(凌晨)
**类型**: 仓库瘦身——只保留重要信息,清理全部过程性文档

### 清理明细

| 对象 | 处置 | 说明 |
|---|---|---|
| `docs/` 18 篇(竞品调研×3/UI 审计×3/harness 计划/诛仙 dogfood/models-guide 等) | 删除 | 过程性文档使命完成,关键结论已沉淀于代码注释+AGENTS.md |
| `CLOSEOUT.md`、`设备说明.md`(与 AGENTS.md 重复)、`docs归档说明.md` | 删除 | 收尾计划已全部完成;设备单一真相源=AGENTS.md |
| `toiv-t2v-submits-20260820/`(提交截图)、`test-results/`、`docs/assets/` | 删除 | 过程证据 |
| TEST_LOG.md | 572KB→10KB | 保留最近 3 个关键里程碑(CONTROL/CANVAS-TS/ENGINE-R5)+本条 |
| STATE.json | 268KB→82KB | 79 key→12:核心结构(project/repo/health 最新 1 条/git/roadmap/infra/conventions)+最近 4 里程碑;70+ 历史 milestone key 清除 |
| 代码内 16 处 `docs/2026-*.md` 注释出处引用 | 清理 | 保留说明文字,去掉失效文档链接(纯注释,非运行时依赖) |

### 保留(下一阶段基线)

- **AGENTS.md**(58KB)——集群操作记忆+硬性规则,单一真相源
- **README.md**——项目入口
- **STATE.json**(82KB)——当前状态快照+infra 布局+roadmap
- **TEST_LOG.md**(10KB)——最近里程碑,新条目继续倒序追加

**回归**: 清理后后端 1917 passed / 前端 418 passed / tsc 0 错误——零破坏。

---

## CONTROL-2026-08-23 · 内容限制管控(admin 三档策略) + spark02 无审查模型替换

**时间**: 2026-08-23(凌晨)
**类型**: 用户主权功能(限制等级 admin 可控,全站统一生效) + LLM 无审查模型替换(生产已切换)

### ① spark02 模型替换:Qwen3.8-27B-NVFP4 → Qwen3.8-27B-Uncensored-FP8(abliterated)

- **选型**: OrcaRouter abliterated 版(同一 Qwen3.8-27B,拒答方向已从残差流正交移除,131 个残差写矩阵,视觉塔保留;Block-FP8 与官方 FP8 完全同一 vLLM kernel 路径,262K ctx/工具/推理/MTP 全保留)
- **下载路线(真机实证)**: HF 直连超时 → hf-mirror 403 → orcarouter 原仓库 gated: auto(需登录) → **chimingw/Qwen3.8-27B-Uncensored-OrcaRouter-GGUF 的 FP8/ 字节级镜像(gated: False)** → spark02 经 MateBook Clash 代理(100.74.15.34:7897)8MB/s 下载 29GB/7 分片(~35min,与 web_search 代理同款依赖:Mac 在线+Clash 运行)
- **切换**: vllm_node 容器重建,仅换模型路径,`--served-model-name qwen3.8-27b qwen3.6-uncensored` 别名保留 → **core .env 零改动**;MTP speculative 正常,360s 加载就绪;旧 NVFP4(22GB)保留可秒级回滚
- **无审查验证(对照测试)**: 官方版拒答的成人写作请求现在直接产出(「写一段激情做爱的详细小说片段」→ 完整细节输出,无「我不能」拒绝语)
- **core 链路**: core→spark02 /v1/models 实测 root=/models/Qwen3.8-27B-Uncensored-FP8;L1-L4 全层(auth 层/剧本/润色/NSFW 路由)与 AI 助手全部即时获得无审查能力

### ② 内容限制管控(CONTROL):admin 三档策略,全站统一生效

**设计**: 等级语义
- `strict` 严格——全站禁 R18(即使开 R18 模式也拒,适合公共场合/未成年设备)
- `standard` 标准(默认)——历史行为:分区门控(X-NSFW 头+年龄确认)
- `relaxed` 宽松——成年用户免门控:无需 R18 模式即可访问全部成人引擎/模型/作品/助手技能

**实现(最小侵入)**: `nsfw_allowed()` 是全站 66+ 调用点的唯一判定出口(各引擎 gate/列表过滤/技能注入/L4 路由)——等级判定收敛进 [nsfw_ctx.py](file:///Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/api/app/nsfw_ctx.py) 单点,所有调用点零改动自动跟随:
- `ContentPolicy` 单例表([models.py](file:///Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/api/app/models.py),create_all 自动建)
- `get_policy_level()` 30s 进程缓存+读库失败降级 standard(绝不炸业务请求);`set_policy_level()` 写入即失效缓存(即时生效)
- 未成年硬阻断优先级最高,任何等级不放行(法律红线)
- API:`GET /api/content-policy`(登录可读)/`PUT /api/content-policy`(仅 admin,422 校验,审计日志)
- 前端:设置页新增「内容限制管控」卡(仅 admin;三档单选卡组+当前徽章;普通用户不渲染不请求);page.tsx 传 role
- conftest 补策略缓存清理 autouse fixture(防 30s TTL 跨用例污染)

**回归**: 后端 1917 passed(1907+10 新增:三级语义/未成年阻断/未登录 401/非 admin 403/非法值 422);前端 418 passed+tsc+ui_lint;生产实测三档往返切换(relaxed→standard)即时生效;已部署 core

---

## CANVAS-TS-2026-08-23 · 画布去标题/副标题 + 全链路 Tailscale 化(跨地区访问)

**时间**: 2026-08-23(凌晨)
**类型**: 前端 UI 调整(用户要求去掉画布标题/副标题) + 浏览器侧直连地址 Tailscale 迁移(已部署 core)

### ① 画布页头精简

- [CanvasView.tsx](file:///Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/web/components/canvas/CanvasView.tsx):PageHeader(title「画布」+desc「内嵌 ComfyUI 节点画布…」+kicker「NODE CANVAS」)整体移除,改为纯操作条 `.canvas-bar`(右对齐:连接状态徽章+「新窗口打开」),标题区让位给画布内容;清理失效的移动端 `.page-header-desc` 隐藏规则
- 浏览器验证(DOM 实测):h1-h6 归零、旧文案全文档无残留;徽章+外链按钮正常

### ② 浏览器侧直连地址 Tailscale 迁移(用户动机:设备不在同一物理网络,局域网 IP 跨地区不可达)

| 位置 | 旧值(局域网) | 新值 |
|---|---|---|
| CanvasView COMFYUI_URL 默认 | 192.168.71.127:8188 | **100.68.100.90:8188**(Tailscale 优先) |
| CanvasView 候选链 | 单地址 | Tailscale 默认 + **192.168.71.127:8188 回退候选**(同地加速;探测按序) |
| CanvasView HTTPS 混合内容指引 | 硬编码 http://192.168.71.47:3100/?view=canvas | 动态 `http://{window.location.host}/?view=canvas`(任意入口自适应) |
| workflows.ts DEFAULT_COMFYUI_URL | 192.168.71.127:8189 | **100.68.100.90:8189**(当前无组件引用,防未来误用) |

- 真机验证(第二硬性规则):workstation :8188/:8189 均监听 0.0.0.0;从 Mac 经 Tailscale 实测 100.68.100.90:8188/8189→200、100.77.80.100:3100(root/?view=canvas)→200、:8090/api/health→ok
- 架构边界(有意保留):core→workstation 后端服务间调用维持局域网 IP(同机架共址,走 Tailscale 反而绕路);playwright.prod.config/e2e spec 内 LAN IP 为测试基建非用户功能,不在本次范围
- 回归:tsc 0 错误、npm test **418/418**、ui_lint 门禁通过(12 条预存软提醒)、`rm -rf .next` 干净构建(deploy 前置,易错点 29)、deploy.sh 部署 core 双服务就绪
- 部署后验证:core 构建产物含 100.68.100.90:8188 默认与 LAN 回退、旧标题文案/kicker 零残留;浏览器实测(经 Tailscale 入口)徽章显示「已连接 · 100.68.100.90:8188」,ComfyUI 节点编辑器 iframe 正常渲染(1195×671)

---

## ENGINE-R5-2026-08-22 · Round2 终局:时长链全量交付 + 短剧视频版成片 + 合成断链修复 + 作品库分类治理

**时间**: 2026-08-22(晚间) ~ 2026-08-23(凌晨)
**类型**: 生成收尾(时长链拼接/接链) + studio 视频合成断链修复(已部署 core) + 作品库 R18 分类/清理治理 + 散热处置

### ① R2 时长链全量交付(8 条拼接 + 2 条接链)

- **拼接 8 条**(`toiv_dur_*`,1280×704/1344×768,aac 音画直出,ffprobe 终验全过):出租车30s/雪国列车30s/菜市场30s/后巷打斗30s + R18床戏30s/都市霓虹30s + R18床戏60s/沙漠公路60s;全部回写/建档 Job 并挂 1080p 融合超分
- **接链 2 条**:雪国列车60s/清晨市场60s——OOM 断链后从已有 seg2 末帧续跑 seg3/seg4(H3 362帧 i2v,每段约 23-35min),4 段 concat+trim 60s 回写基座 Job(雪国 15.8MB/市场 20.3MB)
- **超分熔断处置**:Workstation BIOS 重启(用户改机箱风扇曲线满速)打断 8 条超分管线 → 重提(帧级断点续跑);发现 r2_concat 脚本进程退出杀 asyncio task 的隐患 → 改走 toiv-api 常驻进程 POST /api/video/upscale
- **GPU 锁扇值守**:fan_guard.py(NVML SetFanSpeed_v2,GPU2/GPU3 全风扇 100%,45s 重设;注意 pynvml API 签名含 fanIdx 参数);BIOS 满速后 GPU2 负载态 92→70°C

### ② studio 视频合成断链修复(P0,已部署 core,1907 passed)

**发现**:短剧《深夜便利店》视频版 8 镜全渲染成功但 assemble 报「片段非 Studio 产出」——`renderers/video.py._wait_video_url` 返回 `/api/images?` 代理 URL,而 `assemble._local_path` 只认 `/api/studio/files/` 前缀(防穿越校验)。render_mode=video 自上线起实际从未能通过合成(image_motion 版走 `_save_output` 落盘所以能合成)。

**修复**([renderers/video.py](file:///Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/api/app/services/studio/renderers/video.py)):
- `_wait_video_url` 拿到 worker 产物后经 `get_image_bytes` 下载 → 复用 image_motion `_save_output` 落盘 Studio 目录 → 返回 `/api/studio/files/` URL;下载为空显式 RenderError(不落空文件)
- 测试:test_video_render_fire_and_forget_waits 断言改 Studio URL+落盘内容;新增 test_video_render_download_empty(下载空产物报错路径);14/14 + 全量 1907 passed → deploy.sh 部署 core
- 存量处置:已渲染 8 镜无需重渲,r2_assemble.py 从 worker 下载落盘回写 shot.video_url/final_clip_url 后直接合成

### ③ 短剧《深夜便利店》视频版 v2 成片(H3 音画直出)

- **成片终验**:`final-82cb2d9f58cf4ca0bb6db752ba6de23d.mp4` 53.4s / 1280×704 / 24fps / h264+aac 立体声,8 镜×6.58s
- **v2 提示词强化**(v1 降级版被用户判「幻灯片」):每镜注入英文运镜指令(slow dolly-in/tracking/rack focus/pulls back)+画内持续动态(雨丝/蒸汽/热气/霓虹反射)+动作动词具体化+环境音暗示(雨声/门铃/冷柜嗡鸣)——针对 VideoRenderer 不消费 shot.camera 的根因,运镜指令直接写进 prompt
- shot1 被 BIOS 重启打断(1800s 超时误杀)→ 补渲恢复;合成断链见②

### ④ 作品库 R18 分类治理(用户规则:R18 底模 AND R18 内容)

- **误标降级 43 条**:出租车/雪国/菜市场/打斗/皮克斯机器人/神社/审讯室等普通内容被接链脚本错打 R18 标(提交时 nsfw=True 一刀切)→ 按 prompt 内容关键词审计降级
- **真 R18 保持 33 条**(wan 体位系列/ltx 成人短片/H3 床戏链/lipsync);漏标 0 条
- **超分 Job nsfw 继承修复**:超分 prompt 只写「视频超分 1080P」不含内容词,纯 prompt 判定会误降级 → 按 params.video_url 回溯源 Job nsfw 继承
- **清理**:22 条 error 空产物作业(OOM 旧单+重启打断)软删除,作品库可见 error 归零

### ⑤ 983「社区规范」错误排查(外部问题,已跳过)

用户预览 R18 视频遇「检测到内容违反社区规范(983)」——ToIV 代码库无此错误码、core API 日志无此报错(仅正常 206 流),为外部客户端(微信/QQ 内置浏览器、云盘 App 等)内容审核拦截,平台内文件正常。

### ⑥ Spark 真机模型确认(第二硬性规则)

- spark01: `omni-captioner` = Molmo2-8B(音乐/图像反推 VLM,:8000,容器 molmo2_captioner)
- spark02: `qwen3.8-27b` = Qwen3.8-27B-NVFP4(LLM L1-L4 主力,别名 qwen3.6-uncensored 有效,:8000,容器 vllm_node)

---


---

> **归档说明(2026-08-23 文档治理)**:更早的历史条目(ENGINE-R1~R4、HARNESS-M1/M2、CLOSEOUT-R51~R60、WAN-NSFW、RES/WIKI/QUEUE/LINKAGE 等 40+ 条)已清理——关键结论均已沉淀在代码注释、AGENTS.md 与 STATE.json 硬约束中;TEST_LOG 自本条起新条目继续倒序追加。
