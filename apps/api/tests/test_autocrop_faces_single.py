from app.routes.apps import _normalize_autocrop_faces_single


def test_clamp_when_feeding_rembg():
    g = {
        "58": {"class_type": "AutoCropFaces", "inputs": {"image": ["56", 0], "number_of_faces": 5, "max_faces_per_image": 50}},
        "60": {"class_type": "easy imageRemBg", "inputs": {"images": ["58", 0]}},
    }
    _normalize_autocrop_faces_single(g)
    assert g["58"]["inputs"]["number_of_faces"] == 1
    assert g["58"]["inputs"]["max_faces_per_image"] == 1


def test_untouched_otherwise():
    g = {
        "58": {"class_type": "AutoCropFaces", "inputs": {"image": ["56", 0], "number_of_faces": 5}},
        "60": {"class_type": "PreviewImage", "inputs": {"images": ["58", 0]}},
    }
    _normalize_autocrop_faces_single(g)
    assert g["58"]["inputs"]["number_of_faces"] == 5
