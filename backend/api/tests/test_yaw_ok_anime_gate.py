"""二次元三分脸 yaw 门禁：anime 20-60，写实 30-60。"""
from app.services.studio.character_sheet import yaw_ok_for_face_key


def test_anime_three_quarter_accepts_20_to_60():
    assert yaw_ok_for_face_key(24.4, "face_three_quarter", style="anime") is True
    assert yaw_ok_for_face_key(20.0, "face_three_quarter", style="anime") is True
    assert yaw_ok_for_face_key(60.0, "face_three_quarter", style="anime") is True
    assert yaw_ok_for_face_key(19.9, "face_three_quarter", style="anime") is False
    assert yaw_ok_for_face_key(60.1, "face_three_quarter", style="anime") is False


def test_realistic_three_quarter_keeps_30_to_60():
    assert yaw_ok_for_face_key(24.4, "face_three_quarter", style="ancient_realistic") is False
    assert yaw_ok_for_face_key(24.4, "face_three_quarter") is False
    assert yaw_ok_for_face_key(30.0, "face_three_quarter", style="ancient_realistic") is True
    assert yaw_ok_for_face_key(45.0, "face_three_quarter") is True


def test_front_and_side_unchanged():
    assert yaw_ok_for_face_key(10.0, "face_front", style="anime") is True
    assert yaw_ok_for_face_key(20.0, "face_front", style="anime") is False
    assert yaw_ok_for_face_key(80.0, "face_side", style="anime") is True
    assert yaw_ok_for_face_key(50.0, "face_side", style="anime") is False
