from app.services.app_smoke import mask_consuming_image_keys


def test_mask_output_consumed():
    wf = {"89": {"class_type": "LoadImage", "inputs": {"image": "x.png"}},
          "128": {"class_type": "Mask Fill Holes", "inputs": {"masks": ["89", 1]}},
          "5": {"class_type": "LoadImage", "inputs": {"image": "y.png"}},
          "6": {"class_type": "VAEEncode", "inputs": {"pixels": ["5", 0]}}}
    b = {"img": {"node": "89", "field": "inputs.image"}, "img2": {"node": "5", "field": "inputs.image"}}
    assert mask_consuming_image_keys(wf, b) == ["img"]


def test_unbound_loader_ignored():
    wf = {"89": {"class_type": "LoadImage", "inputs": {}},
          "1": {"class_type": "X", "inputs": {"m": ["89", 1]}}}
    assert mask_consuming_image_keys(wf, {}) == []
