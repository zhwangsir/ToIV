# 对口型(LatentSync 1.6)worker 侧设置

> 漫剧 B 阶段 · 让分镜视频里角色的嘴型对上配音。后端见 `apps/api/app/routes/lipsync.py`
> + `apps/api/app/workflows/lipsync.py`(纯函数构造 LatentSync 工作流图)。
> 以下为 worker(.100 ComfyUI)侧的一次性环境准备 —— **非 git 部署内容,手动复现**。

## 节点
- `ComfyUI-LatentSyncWrapper`(LatentSyncNode)+ `ComfyUI-VideoHelperSuite`(VHS_LoadVideo/VHS_VideoCombine)已装。
- 节点 Python 依赖(mediapipe / face-alignment 等)已随 wrapper 装好(节点能进 object_info 即证)。

## 模型(已下)
```
hf download ByteDance/LatentSync-1.6 \
  --include latentsync_unet.pt "whisper/tiny.pt" \
  --local-dir <wrapper>/checkpoints
```
落到 `custom_nodes/ComfyUI-LatentSyncWrapper/checkpoints/`:
- `latentsync_unet.pt`
- `whisper/tiny.pt`

## 坑 ①:torchcodec 写视频失败
comfy venv 是 **torch 2.10 / torchvision 0.25**,`torchvision.io.write_video` 已委托给
`torchcodec`,而 torchcodec 的 `libtorchcodec_core*.dll` 在本机加载失败(缺 FFmpeg 共享库)。

**修复**(已打补丁,改 wrapper 让其走 **av(pyav,自带 FFmpeg)** 兜底):
`nodes.py` 写视频段的 `except TypeError as e:` → `except Exception as e:`
(io.write_video 抛 ImportError/OSError 时落到已有的 av 写分支)。备份:`nodes.py.toivbak`。
已验证 av 在 comfy venv 能写 h264 mp4(无需 torchcodec)。

## 生效
补丁改的是磁盘上的 `nodes.py`,**ComfyUI 进程需重启**才会重载 —— 重启任一 worker 即激活
(4 进程共享同一安装)。激活后逐镜「对口型」即可跑通。

## 工作流链
```
VHS_LoadVideo(源视频, force_rate=25) → 帧
LoadAudio(配音 wav) → 音频
LatentSyncNode(帧, 音频, lips_expression=1.5, inference_steps=20) → 同步帧 + 音频
VHS_VideoCombine(同步帧, 25fps, h264, audio) → 成片
```
后端把源视频 + 配音下载后上传到选中 worker 的 input 再提交。

## 已知局限
LatentSync 训练于**真人脸**,人脸检测对**动漫脸**可能不稳。写实层(电视剧/电影)效果好;
纯动漫漫剧的口型质量需用真实分镜验证,必要时换 anime 友好的口型方案(后续)。
