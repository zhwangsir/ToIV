# Wave F3 进度（BGM 声床 + 北向 KPI 看板）

> 时间：2026-10-22 Asia/Shanghai · tip 起点 `12052c14` · **无 push / 无 deploy / 无 restart**

## 范围（已完成）

1. **BGM 声床（产品路径）**
   - 纯函数 `bgm_bed.py`：音量/闪避/站内 URL 白名单
   - `ffmpeg_ops.mix_bgm_under_video`：成片下垫 BGM（可选对白 sidechain 闪避、循环垫底）
   - `assemble.assemble_project`：拼接后若项目/请求挂了 `bgm_url` 则混音
   - 模型字段 `StudioProject.bgm_url|bgm_volume|bgm_duck` + 幂等列迁移
   - `PATCH` 校验白名单；`POST /studio/projects/{pid}/bgm` 上传音频
   - FE：`BgmBedPanel` 挂时间线 + 合成段；挂 URL / 上传 / 音量 / 对白闪避

2. **KPI 北向看板（诚实空→有）**
   - `ProductKpiEvent` + `product_kpi.summarize`：四指标
     - 首集成片率、不进自由画布完成率、一致性返工次数、本地队列 P50
   - `GET /studio/kpi/summary` · `POST /studio/kpi/events`
   - 合成成功/失败服务端记 `episode_assembled`
   - FE：工作区 `path_touch=drama_workspace`；自由画布 `free_canvas`；保留拒片记返工；渲染轮询记 `queue_wait`
   - UI：`KpiNorthboundPanel` + `/toiv/kpi` 学习看板；侧栏入口；短剧列表/工作区嵌入
   - **null = 暂无数据**，禁止伪造 0%

## 测试

- bun：`bgm-bed` · `product-kpi`（4 pass）
- pytest：`test_bgm_bed_f3.py` · `test_product_kpi_f3.py`（5 pass）

## OUT（本波未做）

F4 剪映草稿 · F0b 部署 · Acc/Mega · 安全 Dly · 雨夜一镜 · 完整 DAW
