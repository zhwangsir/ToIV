import { useState } from "react";
import Button from "../../components/ui/Button";
import { toivMediaUrl } from "../adapters/media";

type Props = { src?: string; alt: string; className?: string; loading?: "lazy" | "eager" };

/** 同源 /api 参考图带 token；失效时给出可重试入口，而不是一张静默的破图。 */
export default function PrimeMediaThumb({ src, alt, className, loading = "lazy" }: Props) {
    const [attempt, setAttempt] = useState(0);
    const [failed, setFailed] = useState(false);
    const signed = toivMediaUrl(src);
    if (!signed) return <i>{alt}</i>;
    if (failed) {
        return (
            <span className="toiv-media-failed" role="alert" title="媒体载入失败：文件可能不可用或登录已过期">
                <span className="toiv-visually-hidden">媒体载入失败，文件可能不可用或登录已过期。</span>
                <em>载入失败</em>
                <Button size="sm" variant="outline" type="button" aria-label={`重试 ${alt}`}
                    onClick={() => { setFailed(false); setAttempt(value => value + 1); }}>重试</Button>
            </span>
        );
    }
    return <img key={attempt} className={className} src={signed} alt={alt} loading={loading}
        referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}
