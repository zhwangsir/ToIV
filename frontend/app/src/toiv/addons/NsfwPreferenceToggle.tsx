import { useState } from "react";
import Button from "../../components/ui/Button";
import { readNsfwPreference, writeNsfwPreference } from "../preferences/nsfw";

export function NsfwPreferenceToggle() {
    const [on, setOn] = useState(readNsfwPreference);
    const toggle = () => {
        const next = !on;
        setOn(next);
        writeNsfwPreference(next);
    };
    return (
        <Button size="sm" variant={on ? "lime" : "outline"} className="toiv-nsfw-toggle"
            aria-label="NSFW 偏好" aria-pressed={on}
            title={on ? "NSFW 偏好已开启（仅记录偏好，不解除内容锁）" : "NSFW 偏好已关闭（仅记录偏好，不解除内容锁）"}
            onClick={toggle}>
            <span className={`dot${on ? " on" : ""}`} aria-hidden="true" />NSFW
        </Button>
    );
}
