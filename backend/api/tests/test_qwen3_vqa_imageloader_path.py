from app.routes.apps import _normalize_qwen3_vqa_imageloader_path, _build_graph


def test_rewire_imageloader_path_to_image():
    g = {
        "457": {"class_type": "ImageLoader", "inputs": {"image": "a.png"}},
        "453": {
            "class_type": "Qwen3_VQA",
            "inputs": {
                "text": "hi",
                "model": "Qwen3-VL-4B-Instruct-FP8",
                "source_path": ["457", 2],
            },
        },
    }
    _normalize_qwen3_vqa_imageloader_path(g)
    assert g["453"]["inputs"]["image"] == ["457", 0]
    assert "source_path" not in g["453"]["inputs"]


def test_keep_existing_image_link():
    g = {
        "457": {"class_type": "ImageLoader", "inputs": {"image": "a.png"}},
        "453": {
            "class_type": "Qwen3_VQA",
            "inputs": {
                "text": "hi",
                "image": ["99", 0],
                "source_path": ["457", 2],
            },
        },
    }
    _normalize_qwen3_vqa_imageloader_path(g)
    assert g["453"]["inputs"]["image"] == ["99", 0]
    assert "source_path" not in g["453"]["inputs"]


def test_untouched_for_non_imageloader_path():
    g = {
        "10": {"class_type": "MultiplePathsInput", "inputs": {"inputcount": 1, "path_1": "x"}},
        "453": {
            "class_type": "Qwen3_VQA",
            "inputs": {"text": "hi", "source_path": ["10", 0]},
        },
    }
    _normalize_qwen3_vqa_imageloader_path(g)
    assert g["453"]["inputs"]["source_path"] == ["10", 0]
    assert "image" not in g["453"]["inputs"]


def test_build_graph_applies_normalize():
    g = {
        "457": {"class_type": "ImageLoader", "inputs": {"image": "a.png"}},
        "453": {
            "class_type": "Qwen3_VQA",
            "inputs": {
                "text": "hi",
                "model": "Qwen3-VL-4B-Instruct-FP8",
                "quantization": "none",
                "keep_model_loaded": False,
                "temperature": 0.7,
                "max_new_tokens": 128,
                "min_pixels": 100,
                "max_pixels": 1000,
                "seed": 1,
                "attention": "eager",
                "source_path": ["457", 2],
            },
        },
    }
    built = _build_graph(g, {}, {})
    assert built["453"]["inputs"]["image"] == ["457", 0]
    assert "source_path" not in built["453"]["inputs"]
