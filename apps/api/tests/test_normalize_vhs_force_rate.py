from app.routes.apps import _normalize_vhs_force_rate_int_link


def test_bypass_float_to_int_on_force_rate():
    g = {
        "588": {"class_type": "PrimitiveFloat", "inputs": {"value": 16.0}},
        "589": {"class_type": "Float to Int", "inputs": {"float": ["588", 0]}},
        "560": {"class_type": "PrimitiveInt", "inputs": {"value": 81}},
        "590": {"class_type": "VHS_LoadVideo", "inputs": {"force_rate": ["589", 0], "frame_load_cap": ["560", 0]}},
    }
    _normalize_vhs_force_rate_int_link(g)
    assert g["590"]["inputs"]["force_rate"] == ["588", 0]
    assert g["590"]["inputs"]["frame_load_cap"] == ["560", 0]


def test_literal_float_source_and_untouched_cases():
    g = {
        "1": {"class_type": "Float to Int", "inputs": {"float": 24}},
        "2": {"class_type": "VHS_LoadVideo", "inputs": {"force_rate": ["1", 0]}},
        "3": {"class_type": "SomeFloat", "inputs": {}},
        "4": {"class_type": "VHS_LoadVideo", "inputs": {"force_rate": ["3", 0]}},
        "5": {"class_type": "VHS_LoadVideo", "inputs": {"force_rate": 0}},
    }
    _normalize_vhs_force_rate_int_link(g)
    assert g["2"]["inputs"]["force_rate"] == 24.0
    assert g["4"]["inputs"]["force_rate"] == ["3", 0]
    assert g["5"]["inputs"]["force_rate"] == 0
