# AGENTS.md — 集群操作记忆与决策记录

> **目的**：避免 AI 助手反复犯同样的错误，每次会话必须先读本文件（全文 <20KB，约 5 分钟）
> **维护者**：设备管家（AI Assistant）
> **最后更新**：2026-09-22（二次压缩至 20KB 内。当前：api 3315/web 988/e2e 11/11 全绿；应用目录 6773/公开 5061 全量打标；whisper 四节点集群 LIVE；**下一步=四域方案批 1**，见第七节）
> **历史归档**：09-16~09-21 详叙 `.archive/AGENTS-focus-20260916-0921.md`；09-04~09-11 `.archive/AGENTS-changes-20260904-0911.md`；更早 `.archive/AGENTS-full-20260903.md`；机读状态 `STATE.json`

---

## 〇、🔒 硬性规则（每次会话必读）

1. **所有 AI/算力后端服务来源均在 Workstation**（192.168.71.127 / 100.68.100.90）。core(192.168.71.47)只跑 web/api+PG/Redis 是业务网关不是算力；Mac 只是操作终端，配置里的 127.0.0.1 只是本地 dev 兜底。排查「服务离线/引擎不可达」第一反应=SSH 到 Workstation 查 systemd 和端口，禁止臆断。
2. **文档仅供参考，必须真机验证**。凡 GPU 显存/服务状态/端口/路径/挂载/模型占用，先 SSH 执行真实命令（nvidia-smi/systemctl/ss/mountpoint/df/free）再作答；文档与真机冲突以真机为准并修正文档。「已停用/已退役」记录尤其要复核（stop≠disable，重启会复活）。

---

## 一、集群设备清单

| 设备 | 角色 | LAN IP | Tailscale IP | SSH 用户 |
|---|---|---|---|---|
| ~~studio01-04~~ | 2026-08-29 全线下线退役（fleet_registry 已移除） | .109-.113 | — | — |
| openclaw01-04 | **whisper ASR 集群 :9310**（core env 四址故障转移）+JoyCaption :9305；⚠️ 02-04 tailscaled 僵死（**机活服务活 LAN 全通**，仅 TS 离线无远程通道，恢复需现场 `tailscale down && up`） | .86/.75/.81/.85 | **100.115.23.67** / ~~100.76.35.7~~ / ~~100.76.140.121~~ / ~~100.125.217.11~~ | dgmt-openclaw01-04 |
| spark01 | DSv4 TP2 **worker**（rank1，`dsv4_60` 容器；旧 vllm_glm53 stop 留存回滚） | .82 | 100.81.235.124 | dgmt-spark |
| spark02 | **现网 LLM/VLM API** DSv4 TP2 **head** :8000（启动 `~/dsv4-serve.sh 1`(01)→`0`(02)，restart=no 重启需手动；guard cron 双侧已在） | .84 | 100.86.42.89 | dgmt-spark |
| workstation | 算力+全部后端服务（见三） | 192.168.71.127 | **100.68.100.90** | merlin |
| pc01 | ComfyUI worker :8188 + H3 第二实例 :8198（NSSM 服务化） | **192.168.71.116** | 100.69.134.27 | home |
| ~~pc02~~ | 2026-09-13 下线（LB 池已移除） | ~~.114~~ | 100.107.94.26 | w |
| NAS | SMB 存储 44T | 192.168.71.7 | 100.80.237.96 | dgmt-nas |
| 小米路由器 | BE10000 Pro AP/有线中继，管理页 .42 | 192.168.71.42 | — | — |
| 光猫 | 主网关/拨号 | 192.168.71.1 | — | — |
| cloud | 香港网关/frps/OpenResty；⚠️ tailscaled 僵死待现场重启（用户面 frp 不受影响） | 43.119.32.180 | 100.83.78.114 | root |
| core | **ToIV 生产**(web :3100+api :8090+PG+Redis+admin :3200) | 192.168.71.47 | **100.77.80.100** | merlin |
| beijing | **CN 入口** toiv.wineryz.top（OpenResty+frps 7000/7500/13100/18090） | 8.140.222.24 | — | root |
| MateBook | 操作终端（当前在外地，bulk ~37KB/s） | 192.168.71.9 | 100.74.15.34 | 本机 |

> 🔒 访问原则：浏览器侧直连一律 **Tailscale 优先**；core→workstation 服务间调用走 LAN；**「TS 离线」≠「服务掉线」**（N-5）。

## 二、关键凭据（禁止再次询问）

| 服务 | 用户名 | 密码 | 备注 |
|------|--------|------|------|
| NAS SMB | dgmt-nas | Aki.19950108 | 192.168.71.7，共享名 NAS |
| Tailscale Auth Key | — | tskey-auth-kPM5hHvNGY11CNTRL-UTn8rtRjK8Pfw3riNoGB8Pru71VhdRR9C | 已用于 core 授权 |
| ToIV admin | admin | admin123 | 生产 core（登录字段是 `email`） |

**NAS 挂载**：WS=fstab `/home/merlin/nas_mount`（重启后必 `mountpoint` 核实，**挂载后必须重启 ComfyUI 实例**否则缓存空模型列表）；Windows=`cmdkey /add:192.168.71.7 /user:dgmt-nas /pass:Aki.19950108`+SYSTEM 自挂 Z:（W-2）。

## 三、Workstation 服务与 GPU（🔒 启动服务前必须核对；显存/RAM 是动态值，先 `nvidia-smi`/`free -h`）

**现网常驻（2026-09-12 恢复，全部 enabled；09-21 复核全 active）**：

| 服务 | 端口 | 卡 | systemd |
|---|---|---|---|
| ComfyUI-LB（池：本地 :8196 + pc01 :8188；`/admin/backends`） | :8188 | — | comfyui-lb |
| gpu0-alt（cache-lru 8） | :8196 | GPU0 | comfyui-gpu0-alt |
| LongCat（cache-lru 3） | :8197 | GPU0 | comfyui-longcat |
| MiniMax H3（**UUID 钉卡 GPU-0e6e9149**；+pc01:8198 双池 `TOIV_H3_BASE_URLS`） | :8195 | GPU2 | toiv-comfyui-h3 |
| Wan-Animate-2 | :8199 | GPU3 | comfyui-wan-animate-2 |
| 超分 fleet（4x-UltraSharp 帧超分） | :8261/:8262/:8263 | GPU0/1/3 | comfyui-upscale-gpu1/2/3 |
| Qwen3-Embedding-4B | :9302 | — | qwen3-embedding |
| IndexTTS 2.5（配音主路，勿再停） | :9200 | GPU0 | toiv-indextts |
| 音频分离 / comfy-mcp / fan_guard（脚本 `/opt/fan_guard.py`） | :9220/:9100/— | — | toiv-audio-sep / toiv-comfy-mcp / fan_guard |

- **🔒 池后端变更只编辑 workstation `/opt/comfyui-lb/backends.json`**（5s 热重载零重启；api 按 `TOIV_COMFY_WORKERS_REGISTRY_URL` 60s 跟随）；禁止改 core env/LB 源码切成员。
- **🔒 新服务锁卡一律用 GPU UUID**（H-6）；新专用实例必须补 `deps.resolve_worker()` 精确匹配（E-1）。
- **散热政策（拍板）**：无软件温度熔断，GPU 自降频即保护；锁扇是吞吐优化；仅持续 ≥95°C 人工介入。
- 关键路径：ComfyUI=/opt/ComfyUI · H3=/home/merlin/ComfyUI-h3-eval · LongCat=/home/merlin/ComfyUI-longcat · IndexTTS=/home/merlin/index-tts。断电恢复 SOP 见 STATE `power_outage_recovery_2026_09_13`。

## 四、NAS 模型路径与下载

- 主库 `NAS/Windows/ComfyUI/ComfyUIModel/models`（WS `/opt/ComfyUI/models` symlink；524GB+）；ToIV 专用 `NAS/toiv/comfyui-models`（~260GB）。PC01/02 `extra_model_paths.yaml` 指向 `Z:/Windows/ComfyUI/ComfyUIModel`（**不得含 custom_nodes 键**）。
- H3 Ref2VA 权重四档齐（bf16/fp8/int8/pruned_bf16，均在 `h3/diffusion_models/`）。
- **下载清单**：`docs/MODEL_SOURCES.md/.json`（带来源条目，持续追加；勿在仓库根新增 MODEL_SOURCES*）。**下载主路=workstation 直连 hf-mirror.com + aria2c -x16**（N-2）。

## 五、Core 生产状态（活口径）

- **服务**：toiv-api :8090 / toiv-web :3100 / toiv-admin :3200 systemd 常驻；PG 18+Redis 仅 bind 127.0.0.1。**域名双入口**：toiv.dgmt.top（香港 frp）+ **toiv.wineryz.top（CN 主入口，验证一律走此）**。
- **LLM/VLM（DSv4 无审查 TP2 LIVE）**：core `TOIV_LLM_*` 指 spark02 `http://192.168.71.84:8000/v1`；served `deepseek-v4-flash-dspark`+别名 `qwen3.8-27b`/`qwen3.6-uncensored`/`glm-5.3-flash`（core 零改动）；1M ctx、实测 70.5 tok/s；启动/回滚见第一节与归档。
- **whisper ASR 集群**：`TOIV_WHISPER_URL`=openclaw 四址（.86/.75/.81/.85:9310，OpenAI 兼容契约；`Settings.whisper_endpoint_list` 多址故障转移，5xx/连接错换节点、4xx/中止不转移）；env 备份 `.env.bak-whisper-cluster-20260921`。
- **Embedding**：workstation :9302（core `TOIV_EMBED_BASE_URL=http://192.168.71.127:9302/v1`）。
- **部署口径（拍板）**：web/admin 一律 **core 本机构建**（外地 .next 不可传）——web=`cd /home/merlin/toiv/web && rm -rf .next && pnpm build && sudo systemctl restart toiv-web`；admin 构建前 core 必须全量 `npm install`（生产装 --omit=dev 缺 typescript 会报 `@/components` 假线索）；api=`deploy/deploy.sh --skip-web core-jump`（重试循环）。生产 PG 直查：`export PGPASSWORD=68799b59242beeccfd54963902a35006; psql -h 127.0.0.1 -U toiv -d toiv`（core 的 toiv/api/toiv.db 是废弃 SQLite 勿用）。
- **杂项**：视频评分器 `TOIV_VIDEO_SCORER_ENABLED=true`；web_search 代理 `TOIV_WEB_SEARCH_PROXY=http://192.168.71.9:7897`（依赖 Mac 在线）；数字人 M1–M6 与音频编排（tts/separate/concat/mix/variant）可用，sfx 仍 501；内容限制管控已下线（未成年硬阻断+X-NSFW 语义保留）；封面 autorefire 深度闸 12+尝试上限 3+批限 120，勿手动乱调。

## 六、⚠️ 易错点（按主题归并）

### H. 硬件/容量
- **H-1 禁止臆造硬件数据**：先 SSH 真机确认。
- **H-2 显存数字是快照不是真理**：容量规划/共卡部署必须现场 nvidia-smi;vLLM 共卡必须显式调低 gpu-memory-utilization。
- **H-3 多引擎并跑先算 RAM**（183G 曾耗尽 OOM）：上架大 RAM 模型前 `free -h`。
- **H-4 「DB 标 error」≠「生成失败」**：批量失败先查 ComfyUI `/history/{pid}`,产物在就回写,禁止盲目重提。
- **H-5 温度政策**：无软件熔断（见三节）。
- **H-6 CUDA 数字索引≠nvidia-smi 索引**（GPU0 requires reset 时偏移；2026-09-21 真机核：已自愈）：🔒 锁卡一律 **GPU UUID**+起服后 `--query-compute-apps` 复核。
- **H-7 :8189 已退役**（unit disable 防复活）；:8196 gpu0-alt 是正式本地池后端。

### D. 退役/迁移
- **D-1 stop≠disable,重启会复活**：退役必须 disable/mask;「已迁移/已停用」记录跨项目冲突时真机复核。
- **D-2 一次性手工迁移没有守护会静默失效**：生产依赖变更后必须实测业务链路。

### N. 网络/代理
- **N-1 跨境链路波动会污染 A/B 结论**：「502/超时」先排除全局链路事件（验证入口用 CN wineryz，dgmt frp 抖动）。
- **N-2 HF/外网下载**：hf-mirror.com 从 workstation 直连+aria2c -x16 是主路;Mac Clash(:7897)为备,依赖 Mac 在线。
- **N-3 Tailscale**：浏览器侧 TS 优先;服务须监听 0.0.0.0 才经 TS 可达。
- **N-4 Windows 长命令经 SSH 会被换行截断**：用 PowerShell `-EncodedCommand`;`schtasks` 用 `/create /f` 覆盖重建。
- **N-5 「TS 离线」≠「服务掉线」**（09-21 翻案）：先 LAN ping+端口扫;处置 Mac=`tailscale down && up`,Linux=ts-health 探针（已常驻 core/WS）。

### W. Windows
- **W-1 SSH session 隔离**：长期服务用计划任务+bat 或 NSSM;SSH 启的进程断连即被杀。
- **W-2 SYSTEM 任务看不到用户盘符**：ps1 开头自挂 `net use Z:`;模型可见性最终裁判=ComfyUI 进程 object_info。

### E. 引擎/工作流
- **E-1 新专用 ComfyUI 实例必须补 `deps.resolve_worker()` 精确匹配**：否则作业成功但产物 502。
- **E-2 LongCat 链路坑**：TI2V i2v 用 WanVideoEncode→extra_latents;Avatar 音频必须 whisper-large-v3;WanVideoWrapper 必须 `rope_function="comfy"`。
- **E-3 引擎探测通过≠链路可跑**：新引擎必须真机 e2e 后交付。
- **E-4 vLLM 坑**：NVML mismatch 炸平台探测（补丁 /home/merlin/patch_vllm_nvml.py）;**served-model-name 别名机制——换模型保别名=core 零改动**。
- **E-6 超分竖屏源必须显式 --target-w/--target-h**,生产一律 `--keep-frames`。
- **E-7 回写协程生命周期不得超过 tracker 作业生命周期**：「等待作业完成再落库」按多轮等待+启动 reconcile 双保险写。
- **E-8 读用户参考图一律 input→output 双形态**：统一走 `get_image_bytes_any`(硬编码 input 必 404→502)。

### P. 平台机制
- **P-1 产物 URL 已签名+归属校验**：测试构造 URL 必须带 sig 或先建档;媒体走 `?token=`。
- **P-2 前端变更必须真机验证**：生产 `rm -rf .next` 干净重建,截图/查 BUILD_ID,不能只看 API。
- **P-2b CSS/前端三约束**：①appsRh 全文件懒惰正则——`object-fit: cover` 须在 `.rh-preview-cover`/`.rh-detail-cover` 断言区**之前**;②engineStudio 零 hex——自 `.apps-studio {` 起扫到文件尾,禁 hex 且勿臆造 token（先 grep globals.css）;③新增 lib/api 导出必补 `tests/mocks/studioApi.ts` 替身。多组件文件一律 `<style jsx global>`+前缀命名。
- **P-3 浏览器自动化测 React**：select 用 native setter+dispatchEvent;多 textarea 用 `.promptbar-textarea`。
- **P-4 命令行自杀坑**：`pkill -f` 模式串用 `[f]an_guard` 式转义;/tmp 是 tmpfs（大文件写 /var/tmp）。
- **P-5 并行 SSH 会话会互相改写状态**：关键服务「莫名掉线」先 `journalctl -u <svc>` 查停止来源。
- **P-6 杂项**：workstation pip 用清华镜像、github 用 ghfast.top;core 登录返回字段是 `token`;上传 kind 必须下划线风格;H3 生成前先 free 缓存。
- **P-7 新 Python 服务环境三坑**(sm_120)：torch 必须 cu128+/cu130;老牌 CV 包 `--no-build-isolation`;**库主版本升级后旧调用约定逐处核对,能跑≠语义对**。
- **P-8 DB 会话纪律（09-21 池楔死 P0）**：FastAPI yield 依赖**响应流完才 teardown**——大 payload 端点必须内存拼好字节后**显式 session.close() 再返回**;**异步长任务禁持 DB 会话跨 await**;PG 池已显式 20+20/pre_ping;诊断=pg_stat_activity 看 idle in transaction（基线 20 idle/0 楔死）+core venv py-spy。
- **P-9 agent 工具纪律**：加工具同步四处断言（BUILTIN_ORDER/schemas/LEGACY_SYSTEM/test_agent_gen_tools）;服务抽出 import 必须别名防遮蔽;**成功文案首 60 字禁 hint 词**（"失败/超时/不可用/仅 R18/过于频繁/未知工具/不存在",错误路径反而要含）。

## 七、当前焦点（活口径摘要）

### 基线（2026-09-22 核）
- **测试**：api **3315** / web **988** / e2e 六 spec **11/11**；分支 `feat/app-guides-admin-cms`（**勿 push、勿 stage `.regen_tmp`/`dogfood-output`**）。
- **生产**：见五节；web BUILD_ID `20260921-052336-nogit`。
- **目录**：应用 **6773 总/5061 公开/5558 rh-acc**，use_case 打标全覆盖；说明卡 550/550；作品库 72 件（44 件折 18 变体文件夹）。

### 下一步=四域方案批 1（方案已备，说「继续」即开工）
1. **作品库文件夹整组删除 P0**（`docs/LIBRARY_FOLDER_DELETE_PLAN_20260922.md`）：文件夹卡删除入口+确认 Modal+复用批量删/撤销；三处「不做整组删除」注释与测试同步改。
2. **助手 A0 快赢**（`docs/ASSISTANT_UI_REDESIGN_PLAN_20260922.md`）：移动端 CTA ctaAction 跳 fusion→改 home（page.tsx:806）；popup 提示分端；残留清理。后续 A1 工具卡片（toolRenderers 六族，生产实数：工具结果占消息 46%）。
3. **Admin 审计筛选键点号化**（`docs/ADMIN_REPLAN_20260922.md`）：AuditLogView 下划线→点号，2932 条存量立即可查。后续 P0 设备域（假活识别）+说明书批量。
- 总方案 `docs/EVOLUTION_PLAN_20260922.md`；移交提示词套件 `docs/HANDOFF_PROMPT_20260922.md`。

### 关键拍板（长期有效）
- **ToIV 仅本地自用/学习，不公开运营**——社区广场/UGC 合规搁置备档；hypit 平台级集成否决。
- 09-21 交付：漫剧线 M1-M3+A1-A3+remix 全收口、RH SCALE3 8747 全 drain 新种 4524、P0 池楔死根修（fb7a69d）、whisper 四节点集群（ffd4939）。逐条叙事见归档。

## 八、未完成任务总表（仅存开口项；已核销见归档/STATE.json）

### 产品（批 1 之后）
- [ ] 四域方案批 2~5：助手 A1 工具卡片/A2 IA → Admin P0 设备域+D3 内容运营 → 文件夹 P1 bulk 端点+Admin P1 作业队列 → C3 拆分/D2 模型资产/D6 实测矩阵/D7 工程化（lib 瘦身/deploy 固化/admin 测试 0→1）
- [ ] Comfy 二次编辑 save-back（open-in-comfy 已通）
- [ ] SeC 387721：einops reshape 错=SecNodes×torch2.13/sm_120 上游边界（已登记，flash-attn 关闭保留）

### 设备/运维（现场或决策项）
- [ ] openclaw02-04 + cloud tailscaled 恢复（**需现场**：`tailscale down && up` / `systemctl restart tailscaled`）
- [ ] core BIOS 来电自启建议设置（断电后需人工确认）
- [ ] 决策点：cloud 遗留 aigc-auth/deploy-flask/exo-proxy 清理；OpenClaw×4 网关去留（上游已断）
- [ ] wave4 设备组残留核查（Anything Everywhere3/SAM3 Get Object Mask/全局输入/H3 文本节点/IPAdapter FaceID）
- [ ] MODEL_SOURCES 持续追加（当前 ok476/blocked337/total813）
- [ ] wave23 后空闲窗口补刀（可选）：超时/排队 12 例复测+封面余量续跑+QwenEdit fp4 权重
