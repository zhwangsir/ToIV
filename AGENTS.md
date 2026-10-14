# AGENTS.md — 集群操作记忆与决策记录

> **目的**：避免 AI 助手重犯同样错误，每次会话必读（<20KB）
> **维护者**：设备管家
> **最后更新**：2026-10-14 晚（ToIV开发·技术栈 T0 执行批）：**方案 v3 开跑 + 用户四条新拍板**——①**opentalking 数字人下架**（不修复；三 unit 留 systemd-archive 归档态，core `TOIV_OPENTALKING_ENABLED=false` 待下一 api 重启窗翻转，禁战役中重启 api）；②**引用 img2threejs（Apache-2.0）+ hypit（修改版 Apache：单租户自用可并码，多租户/商业转售禁，转公开前须清）功能**，资源优先 AI 短剧创作与视频内容；③**模型保持最新**原则；④**整体 UI 优化立项高优先**（T-U 波）。当日真机：GPU1 embedding 重启回收 28.5G（84.6→56.1；「余量≥60GB」在 H3#2 常驻 41.3G 下不可达，如实改记 41.8G）；LB 池实为 **:8196+:8263 双后端**（旧「单成员」作废，pc01 已不在池）；PG total 14304/public 2166/pass 2170/running 3（战役在跑）。
> **历史归档**：07-07~10-14 焦点全叙与易错点详版 `.archive/AGENTS-full-20261014.md`；更早 `.archive/AGENTS-focus-20260916-0921.md`、`AGENTS-changes-20260904-0911.md`、`AGENTS-full-20260903.md`；机读 `STATE.json`（753KB 只读头部）。

---

## 〇、🔒 硬性规则（每次会话必读）

1. **所有 AI/算力后端服务来源均在 Workstation**（192.168.71.127 / 100.68.100.90）。core 只跑 web/api+PG/Redis 是业务网关不是算力；Mac 只是操作终端。排查「服务离线/引擎不可达」第一反应=SSH 到 Workstation 查 systemd 和端口，禁止臆断。
2. **文档仅供参考，必须真机验证**。凡 GPU 显存/服务状态/端口/路径/挂载/模型占用，先 SSH 执行真实命令（nvidia-smi/systemctl/ss/mountpoint/df/free）再作答；文档与真机冲突以真机为准并修正文档。「已停用/已退役」记录尤其要复核（stop≠disable，重启会复活）。
3. **冒测战役在跑时（PG running>0）禁止重启 toiv-api**（留 running 孤儿，P-18b）；实例重启/迁移等 running=0 窗口。

## 一、集群设备清单

| 设备 | 角色 | LAN IP | Tailscale IP | SSH 用户 |
|---|---|---|---|---|
| openclaw01-04 | whisper ASR 集群 :9310 + JoyCaption :9305（经 TS 全 OPEN）；⚠️ openclaw01 SSH 拒连（服务不受影响） | .86/.75/.81/.85 | 100.115.23.67 / 100.76.35.7 / 100.76.140.121 / 100.125.217.11 | dgmt-openclaw01-04 |
| spark01 | DSv4 TP2 worker（rank1，`dsv4_60` 容器） | .82 | 100.81.235.124 | dgmt-spark |
| spark02 | 现网 LLM/VLM API DSv4 TP2 head :8000（`~/dsv4-serve.sh 1`(01)→`0`(02)，restart=no 重启需手动；guard cron 双侧） | .84 | 100.86.42.89 | dgmt-spark |
| workstation | 算力+全部后端服务（见三） | 192.168.71.127 | 100.68.100.90 | merlin |
| pc01 | ComfyUI worker :8188+H3 :8198；**10-05 起 offline，已撤出 LB 池**（修复非紧急） | 192.168.71.116 | 100.86.169.64 | home |
| NAS | SMB 存储 44T | 192.168.71.7 | 100.80.237.96 | dgmt-nas |
| 路由器/光猫 | BE10000 Pro .42 / 主网关 .1 | — | — | — |
| cloud | 香港网关/frps/OpenResty；⚠️ tailscaled 僵死待现场重启（frp 不受影响） | 43.119.32.180 | 100.83.78.114 | root |
| core | **ToIV 生产**(web :3100+api :8090+admin :3200+PG+Redis) | 192.168.71.47 | 100.77.80.100 | merlin |
| beijing | CN 入口 toiv.wineryz.top | 8.140.222.24 | — | root |
| MateBook | 操作终端（外地时 bulk ~37KB/s） | 192.168.71.9 | 100.74.15.34 | 本机 |

> 🔒 浏览器侧 TS 优先；core→workstation 走 LAN；「TS 离线」≠「服务掉线」（N-5）。~~studio01-04/pc02~~ 已退役下线。

## 二、关键凭据（禁止再次询问）

| 服务 | 用户名 | 密码 | 备注 |
|------|--------|------|------|
| NAS SMB | dgmt-nas | Aki.19950108 | 192.168.71.7，共享名 NAS |
| Tailscale Auth Key | — | tskey-auth-kPM5hHvNGY11CNTRL-UTn8rtRjK8Pfw3riNoGB8Pru71VhdRR9C | 已用于 core 授权 |
| ToIV admin | admin | admin123 | 生产 core（登录字段是 `email`） |
| core 生产 PG | toiv | 68799b59242beeccfd54963902a35006 | `export PGPASSWORD=…; psql -h 127.0.0.1 -U toiv -d toiv`（core 上跑） |

**NAS 挂载**：WS=fstab `/home/merlin/nas_mount`（重启后必 `mountpoint` 核实，挂载后必须重启 ComfyUI 实例）；Windows=`cmdkey /add:192.168.71.7 /user:dgmt-nas /pass:Aki.19950108`+SYSTEM 自挂 Z:（W-2）。

## 三、Workstation 服务与 GPU（🔒 启动服务前必须核对；显存/RAM 动态值先 nvidia-smi/free -h）

**现网常驻（全部 enabled；4× RTX PRO 6000 Blackwell 96GB + 183G RAM）**：

| 服务 | 端口 | 卡 | systemd |
|---|---|---|---|
| ComfyUI-LB（池=本地 **:8196+:8263 双后端**，10-14 实测；`/opt/comfyui-lb/backends.json` 5s 热重载） | :8188 | — | comfyui-lb |
| gpu0-alt（cache-lru 8） | :8196 | GPU0 | comfyui-gpu0-alt |
| LongCat（cache-lru 3） | :8197 | GPU0 | comfyui-longcat |
| MiniMax H3（UUID 钉卡 GPU-0e6e9149） | :8195 | GPU2 | toiv-comfyui-h3 |
| MiniMax H3 worker#2（UUID 8a63d89c，~41G） | :8264 | GPU1 | toiv-comfyui-h3-gpu1 |
| ToIV VLM（Qwen3-VL-8B BF16，~44.6G） | :9311 | GPU3 | toiv-vlm |
| 超分 fleet（4x-UltraSharp；**:8261 已撤**；**:8263 在 LB 池**） | :8262/:8263 | GPU2/GPU3 | comfyui-upscale-gpu2/3 |
| Qwen3-Embedding-4B（SentenceTransformer 脚本 `/opt/qwen3-embedding-server.py`，非 vLLM；进程名 nemotron-venv 有误导） | :9302 | **GPU1**（CVD=1 存量） | qwen3-embedding |
| IndexTTS 2.5（配音主路，勿再停） | :9200 | GPU0 | toiv-indextts |
| 音频分离 / comfy-mcp / fan_guard（`/opt/fan_guard.py`） | :9220/:9100/— | — | toiv-audio-sep / toiv-comfy-mcp / fan_guard |
| ~~opentalking 数字人栈~~ | ~~:4403/:19092/:9000~~ | — | **2026-10-14 用户拍板下架**：三 unit 留 `/home/merlin/systemd-archive/` 不复活；代码 `/home/merlin/opentalking` |

- **🔒 池后端变更只编辑 workstation `/opt/comfyui-lb/backends.json`**；禁止改 core env/LB 源码切成员。
- **🔒 新服务锁卡一律用 GPU UUID**（H-6）；新专用实例必须补 `deps.resolve_worker()` 精确匹配（E-1）。
- **散热**：无软件温度熔断，GPU 自降频即保护；仅持续 ≥95°C 人工介入。
- 关键路径：ComfyUI=/opt/ComfyUI · H3=/home/merlin/ComfyUI-h3-eval · LongCat=/home/merlin/ComfyUI-longcat · IndexTTS=/home/merlin/index-tts。

- **四、NAS**：主库 `toiv/comfyui-models` ≈5.2T（新下载只进这里）core=`/mnt/toiv-nas`、工作站=`/home/merlin/nas_mount`；旧库 `Windows/ComfyUI/ComfyUIModel/models` ≈1.5T；两树合计会把硬链算重。端口挂载（10-09 实测）：:8196 两棵都可见；:8197 extra 挂 toiv+h3；:8195/:8264 只挂 h3/，**H3 生产口=:8264**。口径：盘上有≠产品在用（写死文件名见 STATE `branch_integrate_2026_10_09`）；PC01/02 extra 指旧树不得含 custom_nodes 键。下载清单 `docs/MODEL_SOURCES.md/.json`；主路=hf-mirror.com+aria2c -x16（N-2）。

## 五、Core 生产状态（活口径）

- **服务**：toiv-api :8090 / toiv-web :3100 / toiv-admin :3200 systemd 常驻；PG 18+Redis 仅 bind 127.0.0.1。域名双入口：toiv.dgmt.top（香港 frp）+ toiv.wineryz.top（CN 入口）。验证：局域网优先 LAN 直连 `192.168.71.47:3100`(/studio 同源)/`:8090`/`:3200`；外网/发布回归才走 wineryz（N-1）。
- **LLM/VLM（DSv4 无审查 TP2 LIVE）**：core `TOIV_LLM_*` 指 spark02 `http://192.168.71.84:8000/v1`；served `deepseek-v4-flash-dspark`+别名 `qwen3.8-27b`/`qwen3.6-uncensored`/`glm-5.3-flash`；1M ctx、70.5 tok/s；换模型保别名=core 零改动。`/api/llm/v1` 白名单 `TOIV_LLM_PROXY_MODELS` 须含四名。
- **whisper ASR**：`TOIV_WHISPER_URL`=openclaw 四址故障转移。**Embedding**：workstation :9302。
- **数字人**：~~opentalking M1–M6~~ **已下架（2026-10-14 拍板）**——`TOIV_OPENTALKING_ENABLED=false` 待下一 api 重启窗生效（战役中禁重启 api）；web 数字人入口随 T-U UI 批隐藏。
- **部署口径**：web/admin 一律 **core 本机构建**（web=`cd /home/merlin/toiv/web && rm -rf .next && pnpm build && sudo systemctl restart toiv-web`；admin 构建前全量 `npm install`）；api=`deploy/deploy.sh --skip-web core-jump`。生产 PG 直查见 §二。
- **杂项**：`TOIV_VIDEO_SCORER_ENABLED=true`；web_search 代理 `TOIV_WEB_SEARCH_PROXY=http://192.168.71.9:7897`（依赖 Mac 在线）；内容限制管控已下线；封面 autorefire 勿手动乱调。

## 六、⚠️ 易错点（按主题归并；叙事详版见 .archive/AGENTS-full-20261014.md）

### H. 硬件/容量
- **H-1 禁止臆造硬件数据**，先 SSH 真机。**H-2 显存数字是快照**：共卡部署必须现场 nvidia-smi；vLLM 共卡显式调低 gpu-memory-utilization。**H-3 多引擎并跑先算 RAM**（183G 曾 OOM）。**H-4 「DB 标 error」≠失败**：先查 ComfyUI `/history/{pid}`，产物在就回写，禁盲目重提。**H-5** 无软件温度熔断。**H-6 CUDA 数字索引≠nvidia-smi 索引**：🔒 锁卡一律 GPU UUID+起服后 `--query-compute-apps` 复核。**H-7** :8189 已退役（disable 防复活）。

### D. 退役/迁移
- **D-1 stop≠disable，重启会复活**：退役必须 disable/mask；跨项目冲突记录真机复核。**D-2 一次性手工迁移无守护会静默失效**：生产依赖变更后必须实测业务链路。

### N. 网络/代理
- **N-1** 跨境链路波动污染 A/B 结论，先排除全局链路事件。**N-2** HF 下载=workstation 直连 hf-mirror.com+aria2c -x16 主路；Mac Clash(:7897) 备用。**N-3** 服务须监听 0.0.0.0 才经 TS 可达。**N-4** Windows 长命令经 SSH 换行截断：PowerShell `-EncodedCommand`；`schtasks /create /f` 覆盖。**N-5** 「TS 离线」≠「服务掉线」：先 LAN ping+端口扫；处置 Mac=`tailscale down && up`，Linux=ts-health 探针（常驻 core/WS）。

### W. Windows
- **W-1** SSH session 隔离：长期服务用计划任务+bat 或 NSSM。**W-2** SYSTEM 任务看不到用户盘符：ps1 自挂 `net use Z:`；模型可见性最终裁判=ComfyUI object_info。

### E. 引擎/工作流
- **E-1** 新专用 ComfyUI 实例必须补 `deps.resolve_worker()` 精确匹配，否则作业成功产物 502。**E-2** LongCat 坑：TI2V 用 WanVideoEncode→extra_latents；Avatar 音频必须 whisper-large-v3；WanVideoWrapper `rope_function="comfy"`。**E-3 🔴 探测通过≠链路可跑**：新引擎必须真机 e2e 出片后才算交付（三连实证）。**E-4** vLLM：NVML mismatch 补丁 `/home/merlin/patch_vllm_nvml.py`；served-model-name 别名机制=换模型 core 零改动。**E-6** 超分竖屏显式 --target-w/--target-h，生产一律 `--keep-frames`。**E-7** 回写协程生命周期≤tracker 作业生命周期（多轮等待+reconcile 双保险）。**E-8** 读用户参考图 input→output 双形态，统一 `get_image_bytes_any`（硬编码 input 必 404）。**E-9 🔴 专用实例分支必须在模型检查前先验模型**：`_pick_app_client`(routes/apps.py:4294) 按 class_type 前缀派专用实例直接 return，`required` 从不被检查；路由错被 combo_repair 伪装成「权重不兼容」（fp8 报错真因是路由）。处置：专用分支 return 前先验 required，不满足穿透 pool.pick；`h3_like`/`qwen_edit_like`/`animate2` 三分支同查；换模型文件必须同步处理耦合的量化/精度部件。**E-10 🔴 shim 输出元数必须 ≥ 云端节点被引用的最大 socket 索引**：越界报 `tuple index out of range` 且异常挂在下游消费者、真凶不在错误信息里。诊断：逐节点 object_info 断言每条 `[node_id, idx]` 的 `idx < len(output)`。禁止加宽 RETURN_TYPES 骗过校验；不可通用 shim 的终态=清晰归因失败。**E-11 🔴 库级失败(cusolver/cuDNN/NCCL)不能单调用点补丁当根修**：查环境面（Xid / `torch.backends.cuda.preferred_linalg_library` / libcusolver 与 torch+cu130/sm_120 匹配）；写「已验证」前两道必查：①补丁被加载（进程启动时间>文件 mtime）②同故障其他调用点。**E-12 🔴 节点包会把 HTTP 错误响应当模型写盘不校验**（WD14-Tagger 317 字节限流页冒充 onnx，7 应用被打死）：诊断先看文件大小与头部字节（错误页=几百字节纯文本；真 onnx=GB 级）；处置=hf-mirror 重下+舰队 venv 验证加载；「小得离谱的权重文件」可能是错误页/LFS 指针。

### P. 平台机制
- **P-1** 产物 URL 已签名+归属校验；媒体走 `?token=`。**P-2** 前端变更真机验证：干净重建+截图+查 BUILD_ID。**P-2b CSS 三约束**：appsRh 懒惰正则断言区次序；engineStudio 零 hex（先 grep globals.css）；新增 lib/api 导出必补 `tests/mocks/studioApi.ts` 替身；多组件文件 `<style jsx global>`+前缀命名。**P-3** 测 React：select 用 native setter+dispatchEvent；多 textarea 用 `.promptbar-textarea`。**P-4** `pkill -f` 用 `[f]an_guard` 式转义；/tmp 是 tmpfs（大件写 /var/tmp）。**P-5** 并行 SSH 会话互改状态：关键服务异常先 `journalctl -u <svc>`。**P-6** workstation pip 清华镜像、github ghfast.top；core 登录返回字段 `token`；上传 kind 下划线风格；H3 生成前 free 缓存。**P-7** 新 Python 服务三坑(sm_120)：torch cu128+/cu130；老 CV 包 `--no-build-isolation`；库主版本升级后旧调用逐处核对。**P-8 DB 会话纪律**：大 payload 端点内存拼字节+显式 close 再返回；异步长任务禁持 DB 会话跨 await；诊断=pg_stat_activity idle in transaction+py-spy。**P-9 agent 工具纪律**：加工具同步四处断言（BUILTIN_ORDER/schemas/LEGACY_SYSTEM/test_agent_gen_tools）；服务抽出 import 必须别名防遮蔽；成功文案首 60 字禁 hint 词（错误路径反而要含）。**P-10 kernels 0.16+ 信任门**：实例无 `HF_ENDPOINT` 会直连 hf 报 `runtime_cuda` 假缺包；处置=unit drop-in 补 `Environment=HF_ENDPOINT=https://hf-mirror.com`（drop-in 目录漏 `.service` 不生效）+`kernels>=0.16` 落 venv。**P-11 分页契约静默吞错=数据灾难**：`/api/apps` limit>1000 与未知 query 返 422；「拉全量去重」必须分页拉+任何一页失败即 raise，绝不返回空集当「库里没有」；同类自查=所有 `except → continue/return []` 的网络辅助函数。**P-12 派生指标不能自证**：admin 视图不按 is_public 过滤（验上架用 PG `count(*) FILTER`）；任何过滤参数用「换值看结果变不变」自证（RunningHub page/pageSize/searchValue、civitai baseModel 同病——`modelId=` 才真生效）；预期收益先做前后对照/翻转矩阵。**P-13 🔴 烟测通过≠生产可用**：`combo_repair` 只在烟测路径跑、`_finish` 不写 workflow_json；修复必须以结构化 edits 回放存量图落库；**绝不存运行图**（含烟测 fixture）；任何一条 edit 失败整体不落库；「探测/修复后重试」必须问「修复有没有写回持久层」。**P-14 枚举全库的结论会随数据增长过期**：按名字清单做兼容层的活，动手前重新枚举全库（RH_LLMAPI_NODE 662 图在用而 shim 未覆盖的教训）；清单按「语义族+正则」定。**P-15 装了文件≠生效**：多实例舰队节点包变更逐实例重启+逐个 `object_info/<class>` 核验，节点总数下降即回滚。**P-16 🔴 `/object_info/<未知类>` 返回 200+空对象**：存在性判据=body 键集合（`name in json.loads(raw)`），`-w %{http_code}` 作废；任何「拿 2xx 当存在性」的探测同风险。**P-17 上架类操作先查启动期不变量**（`SFW_NSFW_TWINS` 九对孪生卡 seed 时强制软隐藏 R18）；收益用稳定态口径复核，不信瞬时计数。**P-18 core 手跑 app.* 代码必须显式带 `TOIV_DATABASE_URL`**（否则静默回落废弃 SQLite；生产 DB 地址只在 systemd 进程 env，从 `/proc/<pid>/environ` 取）；运维脚本第一步断言 `engine.url` 是 postgresql 否则 raise；结论一律 psql 复核。**P-18b `app` 表无烟测开始时刻**：`smoke_at` 只在完成时写、`updated_at` 无 onupdate；running 是否孤儿靠外部证据（活跃 id 清单+ActiveEnterTimestamp+/queue）；根治=加 `smoke_started_at` 列（须拍板）。**P-19 前端注释里的「这个端点不用鉴权」必须实测**：探活一律经带 authHeaders() 的统一封装；可加「直接断言后端源码含 Depends(get_current_user)」的防回归测试。**P-20 SPA 挂 /studio 子路径时硬编 `/api/...` 必 404**：任何绕过 `http`/`apiBaseURL` 自拼 URL 的请求（fetch/EventSource/img src/window.open）都是雷，新增必须走 apiBaseURL。**P-21 浏览器判「碎图」不能用 `complete && naturalWidth===0`**：lazy 视口外假阳性；先滚动再测、或 fetch 状态码、或过滤 `loading==="lazy" && !inViewport`。**P-22 永久失败(401/403)不能当「还没起来」轮询**（一次刷 3877 条 403 的教训）：给 403 打可判定标记→终态+清定时器；判断轮询看时间轴增量（等 25s 再数 growth=0）。**P-23 「代理改 Host」类诊断必须无副作用探针实证**：Next rewrite 会把 Host 改写成目标；真拦人的是 Origin 同源分支；`CANVAS_OPS_TRUSTED_ORIGINS` 精确 Origin 准入已上线。

## 七、当前焦点（活口径）

### 2026-10-14 晚（ToIV 开发：技术栈方案 v3 执行开始 · T0 批）
- **真源**：`docs/ops/TECH_STACK_PLAN_20261014.md`（v3）+ 执行提示词 `TECH_STACK_EXEC_PROMPT_20261014.md` + 世界漫游调研 `WORLD_MODEL_INTERACTIVE_RESEARCH_20261014.md` + OSS 调研仓 `~/Desktop/ALLProject/Ai-OSS-Reference`（SURVEY.md 637 条含逐仓 LICENSE 留档，**引入第一真源**；AGPL 167+未声明 431 只读不并码，引入仅限 Apache/MIT/BSD 且逐仓读 LICENSE）。
- **用户拍板（同日两批）**：①opentalking 数字人**下架不修复**；②引用 img2threejs(Apache)+hypit(修改版 Apache 单租户可并码)功能；③**模型保持最新**；④UI 优化+**「完全使用 BeefTV(canvas) 那一套」**——canvas 定为唯一 SFW 主 UI，web 缩薄壳，六仓(hypit/Toonflow/dramaclaw/OpenMontage/ChatCut/video-use)深度融合，方案真源 `docs/ops/UI_UNIFY_FUSION_PLAN_20261014.md`（F9-F12+FU1-FU5；R18 去留 D-U1 待拍板，默认 A=web 留 R18 薄壳不推翻红线）。
- **T0 执行记录**：AGENTS 归档瘦身（93.7KB→<20KB）；GPU1 embedding 重启回收 28.5G；LB 池口径修正（:8196+:8263 双后端）；opentalking 下架处置；其余见 `docs/ops/TECH_STACK_EXEC_LOG_20261014.md`。
- **状态**：`tech_stack_t0_exec_2026_10_14`（STATE 同键）。

## 八、未完成任务总表（仅存开口项；已核销见归档/STATE.json）

### 产品
- [ ] 非管理员视角市场复核（role=user 账号密码哈希不可逆——需用户提供凭据或授权重置测试号）
- [ ] W0-1b canvas `asset-view-scope.browser.test.ts` 5 例既有红灯（HEAD 既存非本批引入；首症=reload 后 dialog 不出现）——与 W5-7 配对系统化排障
- [ ] W0-2 外层 pathname-key 摘除回归（drama↔library↔market↔tasks 往返×10 真机回归，PASS 才摘）
- [ ] Slice C 触发条件待重定义（须先与 W8 上架闸对齐避免两套上架口径）
- [ ] SeC 387721：einops reshape 错=SecNodes×torch2.13/sm_120 上游边界（保留观察）
- **T-U UI 优化波（2026-10-14 用户拍板，高优先）**：整体 UI 审计+体验修复；含数字人入口下架隐藏

### 设备/运维
- [ ] openclaw02-04 + cloud tailscaled 恢复（需现场）
- [ ] core BIOS 来电自启建议设置（断电后需人工确认）
- [ ] pc01 修复非紧急（已撤池；可达时补 kernels 0.16.x）
- [ ] SenseVoice 接 `/api/nas/models`（权重在 NAS，等 picker 盘扫）
- [ ] H3 service-token exp 2026-10-17 06:20（自动刷新已 enable，届时留意一跳）
- [ ] 旧 Admin JWT 吊销（HOLD，等设备侧执行）
- [ ] MODEL_SOURCES 持续追加（当前 ok487/blocked337/total825）
- [ ] **T1 吞吐解锁**：LongCat :8197 迁 GPU3（UUID+E-1+H-6）+160 装包+逐实例核验，**等 running=0 窗口**；同窗翻转 `TOIV_OPENTALKING_ENABLED=false`
- [ ] W8 冒测战役余量：未测 ~11,096 条在跑（40–50/h；瓶颈同 GPU0，T1 解）
