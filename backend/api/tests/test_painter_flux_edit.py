from app.routes.apps import _normalize_painter_flux_image_edit


def test_old_inputs_to_autogrow():
    g = {"1": {"class_type": "PainterFluxImageEdit", "inputs": {
        "clip": ["2", 0], "mode": "2_image", "image1": ["3", 0], "image2": ["4", 0],
        "image1_mask": ["5", 1], "image7": ["6", 0], "width": 1024}}}
    _normalize_painter_flux_image_edit(g)
    i = g["1"]["inputs"]
    assert "mode" not in i and "image1" not in i and "image7" not in i
    assert i["images.image_0"] == ["3", 0]
    assert i["images.image_1"] == ["4", 0]
    assert i["image_0_mask"] == ["5", 1]
    assert i["width"] == 1024


def test_other_nodes_untouched():
    g = {"1": {"class_type": "Other", "inputs": {"image1": 1, "mode": "x"}}}
    _normalize_painter_flux_image_edit(g)
    assert g["1"]["inputs"] == {"image1": 1, "mode": "x"}
