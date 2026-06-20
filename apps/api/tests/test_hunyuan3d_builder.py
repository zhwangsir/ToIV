from app.workflows.hunyuan3d import Hunyuan3DParams, build_hunyuan3d_graph


def test_checkpoint_and_image_wiring():
    g = build_hunyuan3d_graph(Hunyuan3DParams(image="obj.png"))
    assert g["1"]["class_type"] == "ImageOnlyCheckpointLoader"
    assert g["2"]["inputs"]["image"] == "obj.png"
    # CLIP_VISION 是 checkpoint 的 slot 1
    assert g["3"]["inputs"]["clip_vision"] == ["1", 1]
    assert g["3"]["inputs"]["image"] == ["2", 0]


def test_conditioning_and_sampler_chain():
    g = build_hunyuan3d_graph(Hunyuan3DParams(image="o.png", steps=25, cfg=4.5))
    assert g["4"]["inputs"]["clip_vision_output"] == ["3", 0]
    ks = g["6"]["inputs"]
    assert ks["model"] == ["1", 0]
    assert ks["positive"] == ["4", 0]
    assert ks["negative"] == ["4", 1]
    assert ks["latent_image"] == ["5", 0]
    assert ks["steps"] == 25 and ks["cfg"] == 4.5


def test_voxel_to_mesh_to_glb():
    g = build_hunyuan3d_graph(Hunyuan3DParams(image="o.png"))
    assert g["7"]["class_type"] == "VAEDecodeHunyuan3D"
    assert g["7"]["inputs"]["vae"] == ["1", 2]
    assert g["8"]["class_type"] == "VoxelToMeshBasic"
    assert g["8"]["inputs"]["voxel"] == ["7", 0]
    assert g["9"]["class_type"] == "SaveGLB"
    assert g["9"]["inputs"]["mesh"] == ["8", 0]
