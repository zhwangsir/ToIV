"""SFW+NSFW market merge: twin map + content_modes tags."""
from app.services.app_content_modes import (
    MERGE_HIDE_IDS,
    NSFW_TO_SFW,
    SFW_NSFW_TWINS,
    content_modes_for,
    nsfw_variant_id_for,
)


def test_h3_twins_roundtrip():
    assert SFW_NSFW_TWINS["h3-t2v"] == "h3-nsfw-t2v"
    assert NSFW_TO_SFW["h3-nsfw-t2v"] == "h3-t2v"
    assert "h3-nsfw-t2v" in MERGE_HIDE_IDS
    assert nsfw_variant_id_for("h3-t2v") == "h3-nsfw-t2v"
    assert nsfw_variant_id_for("h3-nsfw-t2v") is None


def test_content_modes_tags():
    assert content_modes_for("h3-t2v", is_nsfw=False, has_twin=True) == ["sfw", "nsfw"]
    assert content_modes_for("h3-t2v", is_nsfw=False, has_twin=False) == ["sfw"]
    assert content_modes_for("ltx-txt2video", is_nsfw=True, has_twin=False) == ["nsfw"]
    assert content_modes_for("h3-nsfw-t2v", is_nsfw=True, has_twin=False) == ["nsfw"]
