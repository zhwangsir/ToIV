import { useEffect, useState } from "react";
import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";
import { diffPrimeRevision, listPrimeRevisions, type PrimeRevision, type PrimeRevisionDiff } from "../adapters/revisions";
import type { PrimeShotCard } from "../adapters/storyboard";

const SOURCE_LABEL: Record<string, string> = {
    "manual-edit": "手工编辑", rollback: "回滚", imported: "导入", render: "生成快照",
};
const FIELD_ORDER = [
    "idx", "scene", "prompt", "negative", "camera", "dialogue", "speaker", "duration_sec",
    "characters", "render_mode", "seam_to_next", "seam_anchor", "ref_epoch", "ref_epoch_note",
    "beats_json", "scene_ref_json",
];
const FIELD_LABEL: Record<string, string> = {
    idx: "镜序", scene: "场景", prompt: "提示词", negative: "负向词", camera: "运镜", dialogue: "台词",
    speaker: "说话人", duration_sec: "时长", characters: "角色", render_mode: "渲染方式",
    seam_to_next: "衔接", seam_anchor: "衔接锚", ref_epoch: "造型阶段", ref_epoch_note: "造型说明",
    beats_json: "拍结构", scene_ref_json: "场景锚点",
};

function timeText(raw: string): string {
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? raw : date.toLocaleString("zh-CN", { hour12: false });
}
function valueText(raw: unknown): string {
    if (raw === null || raw === undefined) return "（无）";
    if (Array.isArray(raw)) return raw.length ? raw.map(valueText).join("、") : "（空）";
    if (typeof raw === "object") return JSON.stringify(raw);
    const text = String(raw);
    return text.trim() ? text : "（空）";
}
const orderedFields = (fields: Record<string, unknown>) => [
    ...FIELD_ORDER.filter(field => field in fields),
    ...Object.keys(fields).filter(field => !FIELD_ORDER.includes(field)).sort(),
];

type Props = {
    shot: PrimeShotCard | null;
    busy: boolean;
    onClose: () => void;
    onRollback: (revisionId: string, version: number) => Promise<boolean>;
};

export default function RevisionDrawer({ shot, busy, onClose, onRollback }: Props) {
    const [rows, setRows] = useState<PrimeRevision[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [reloadKey, setReloadKey] = useState(0);
    const [diff, setDiff] = useState<PrimeRevisionDiff | null>(null);
    const [diffLoading, setDiffLoading] = useState("");
    const [diffError, setDiffError] = useState("");
    const [confirmId, setConfirmId] = useState("");
    const [rollingBack, setRollingBack] = useState(false);
    const shotId = shot?.id ?? "";
    const currentId = shot?.revisionId ?? "";

    useEffect(() => {
        if (!shotId) return;
        let alive = true;
        setLoading(true);
        setError("");
        setRows([]);
        setDiff(null);
        setConfirmId("");
        listPrimeRevisions(shotId).then(list => { if (alive) setRows(list); })
            .catch(error => { if (alive) setError(error instanceof Error ? error.message : "修订列表载入失败"); })
            .finally(() => { if (alive) setLoading(false); });
        return () => { alive = false; };
    }, [shotId, reloadKey]);

    const showDiff = async (revisionId: string) => {
        setDiffError("");
        setDiffLoading(revisionId);
        try {
            setDiff(await diffPrimeRevision(shotId, revisionId));
        } catch (error) {
            setDiffError(error instanceof Error ? error.message : "修订差异载入失败");
        } finally {
            setDiffLoading("");
        }
    };
    const rollback = async (revision: PrimeRevision) => {
        setRollingBack(true);
        try {
            if (await onRollback(revision.id, revision.version)) setConfirmId("");
        } finally {
            setRollingBack(false);
        }
    };
    const diffFields = diff ? orderedFields(diff.fields) : [];

    return (
        <Modal open={Boolean(shot)} onClose={() => { if (!rollingBack) onClose(); }}
            title={shot ? `修订历史 · ${shot.title}` : "修订历史"}
            variant="drawer" size="md" dismissible={!rollingBack} className="toiv-revision-drawer">
            <p className="meta">每次编辑、回滚与生成都会追加修订；历史与媒体不会被删除。</p>
            {loading ? <p className="meta">正在载入修订…</p> : null}
            {error ? (
                <div className="toiv-revision-error" role="alert">
                    <p>{error}</p>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => setReloadKey(key => key + 1)}>重试</Button>
                </div>
            ) : null}
            {!loading && !error && rows.length === 0 ? <p className="meta">暂无修订；编辑或渲染后会在此出现。</p> : null}
            {rows.length ? (
                <ol className="toiv-revision-list" aria-label="修订列表">
                    {rows.map(revision => {
                        const current = revision.id === currentId;
                        return (
                            <li key={revision.id} className={current ? "is-current" : undefined}>
                                <header>
                                    <b>v{revision.version}</b>
                                    <span className={`toiv-revision-source src-${revision.source}`}>
                                        {SOURCE_LABEL[revision.source] ?? revision.source}
                                    </span>
                                    {current ? <span className="toiv-revision-current">当前</span> : null}
                                    <span className="meta">{timeText(revision.createdAt)}</span>
                                </header>
                                <div className="toiv-revision-actions">
                                    <Button size="sm" variant="ghost" aria-expanded={diff?.revisionId === revision.id}
                                        onClick={() => { if (diff?.revisionId === revision.id) setDiff(null); else void showDiff(revision.id); }}>
                                        {diffLoading === revision.id ? "载入差异…" : diff?.revisionId === revision.id ? "收起差异" : "查看差异"}
                                    </Button>
                                    <Button size="sm" variant="outline" disabled={busy || current}
                                        title={current ? "该修订就是当前内容" : "追加一条回滚修订，不改写历史"}
                                        onClick={() => setConfirmId(confirmId === revision.id ? "" : revision.id)}>
                                        回滚到此版
                                    </Button>
                                </div>
                                {confirmId === revision.id ? (
                                    <div className="toiv-revision-confirm" role="group" aria-label={`回滚到 v${revision.version} 确认`}>
                                        <p>回滚会追加一条新修订；下游阶段确认将失效，媒体会按新内容重估过期状态。</p>
                                        <Button size="sm" variant="ghost" disabled={rollingBack} onClick={() => setConfirmId("")}>取消</Button>
                                        <Button size="sm" variant="lime" disabled={rollingBack || busy}
                                            onClick={() => void rollback(revision)}>
                                            {rollingBack ? "回滚中…" : `确认回滚到 v${revision.version}`}
                                        </Button>
                                    </div>
                                ) : null}
                            </li>
                        );
                    })}
                </ol>
            ) : null}
            {diffError ? <p className="toiv-revision-error" role="alert">{diffError}</p> : null}
            {diff ? (
                <section className="toiv-revision-diff" aria-label={`v${diff.version} 修订差异`}>
                    <header>
                        <b>v{diff.version} 差异</b>
                        <span className="meta">{diff.fromUnknown || diff.fromVersion === null ? "无上游修订可比较" : `对比 v${diff.fromVersion}`}</span>
                    </header>
                    {diffFields.length === 0 ? <p className="meta">内容字段没有变化。</p> : (
                        <dl>
                            {diffFields.map(field => (
                                <div key={field}>
                                    <dt>{FIELD_LABEL[field] ?? field}</dt>
                                    <dd>
                                        <span className="toiv-revision-from">{valueText(diff.fields[field].from)}</span>
                                        <span aria-hidden="true"> → </span>
                                        <span className="toiv-revision-to">{valueText(diff.fields[field].to)}</span>
                                    </dd>
                                </div>
                            ))}
                        </dl>
                    )}
                </section>
            ) : null}
        </Modal>
    );
}
