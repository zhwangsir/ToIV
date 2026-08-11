import pytest
from app.comfy.pool import WorkerPool
from app.models import User
from app.routes.models import list_models

DEFAULT_CKPT = "flux2_dev_fp8mixed.safetensors"
KLEIN_CKPT = "flux-2-klein-4b.safetensors"
SDXL_CKPT = "sdxl_base.safetensors"


class FakeComfyClient:
    """提供 object_info 的 worker 替身，不联网。"""

    def __init__(self, object_info_map: dict):
        self.base_url = "http://fake-worker"
        self._object_info = object_info_map

    async def object_info(self, node: str) -> dict:
        return self._object_info.get(node, {})


def _object_info_fixture() -> dict:
    """构造 ComfyUI object_info 返回值。"""
    return {
        "CheckpointLoaderSimple": {
            "CheckpointLoaderSimple": {
                "input": {
                    "required": {
                        "ckpt_name": [[SDXL_CKPT]],
                    }
                }
            }
        },
        "KSampler": {
            "KSampler": {
                "input": {
                    "required": {
                        "sampler_name": [["euler"]],
                        "scheduler": [["simple", "karras"]],
                    }
                }
            }
        },
        "UNETLoader": {
            "UNETLoader": {
                "input": {
                    "required": {
                        "unet_name": [[KLEIN_CKPT, DEFAULT_CKPT]],
                    }
                }
            }
        },
    }


@pytest.fixture
def pool():
    fake = FakeComfyClient(_object_info_fixture())
    return WorkerPool([fake])


@pytest.fixture
def user():
    return User(
        id="u-1", email="tester", hashed_password="x", tenant_id="t-1"
    )


async def test_default_ckpt_is_first_and_exposed_as_mode_default(pool, user, monkeypatch):
    monkeypatch.setenv("TOIV_DEFAULT_CKPT", DEFAULT_CKPT)
    from app.config import get_settings
    get_settings.cache_clear()
    response = await list_models(pool, user)
    assert response["checkpoints"][0] == DEFAULT_CKPT
    assert response["modes"]["image"]["default"] == DEFAULT_CKPT


async def test_video_ckpts_excluded_from_image_list(user, monkeypatch):
    """checkpoints/ 里的 LTX 视频底模与 10Eros(LTX 系 NSFW 视频 UNET)不得混入图像底模列表。

    背景:LTXVGemmaCLIPModelLoader 的 ltxv_path 只枚举 checkpoints 目录,视频 DiT 必须落
    checkpoints/,但不筛掉会混进图像下拉,选中即报错(2026-08-10 真机 /api/models 实测)。
    """
    from app.config import get_settings
    get_settings.cache_clear()
    info = _object_info_fixture()
    info["CheckpointLoaderSimple"]["CheckpointLoaderSimple"]["input"]["required"]["ckpt_name"] = [[
        SDXL_CKPT,
        "ltx-2.3-22b-distilled-1.1.safetensors",
        "ltx-2.3-22b-dev.safetensors",
        "10eros_v14.safetensors",
    ]]
    pool = WorkerPool([FakeComfyClient(info)])  # 重建 pool,替身枚举含视频底模
    response = await list_models(pool, user)
    assert SDXL_CKPT in response["checkpoints"]
    assert not any("ltx-" in c.lower() for c in response["checkpoints"])
    assert not any("10eros" in c.lower() for c in response["checkpoints"])
