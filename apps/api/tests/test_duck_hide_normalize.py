from app.routes.apps import _normalize_duck_hide_node


def test_duck_hide_combine_becomes_video_combine():
    g = {
        "1664": {"class_type": "RIFE VFI", "inputs": {}},
        "1585": {"class_type": "DuckHideNode", "inputs": {"images": ["1664", 0], "fps": 32, "combine_video": True, "password": ""}},
        "1593": {"class_type": "SaveImage", "inputs": {"images": ["1585", 0]}},
    }
    _normalize_duck_hide_node(g)
    assert "1593" not in g
    assert g["1585"]["class_type"] == "VHS_VideoCombine"
    assert g["1585"]["inputs"]["images"] == ["1664", 0]
    assert g["1585"]["inputs"]["frame_rate"] == 32
    assert g["1585"]["inputs"]["save_output"] is True


def test_duck_hide_passthrough_when_not_video():
    g = {
        "1": {"class_type": "VAEDecode", "inputs": {}},
        "2": {"class_type": "DuckHideNode", "inputs": {"images": ["1", 0], "combine_video": False}},
        "3": {"class_type": "SaveImage", "inputs": {"images": ["2", 0]}},
    }
    _normalize_duck_hide_node(g)
    assert "2" not in g
    assert g["3"]["inputs"]["images"] == ["1", 0]
