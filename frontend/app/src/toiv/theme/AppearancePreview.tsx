export default function AppearancePreview({ name, description }: { name: string; description: string }) {
    return (
        <section className="toiv-preview" aria-label="外观预览" role="group" data-testid="appearance-preview">
            <div className="toiv-preview-nav">
                <span className="toiv-lockup"><span className="mark">TV</span>ToIV</span>
                <span className="toiv-preview-links" aria-hidden="true">
                    <span>项目</span><span className="active">画布</span><span>资产</span><span>任务</span>
                </span>
                <span className="toiv-preview-cta" aria-hidden="true">新建项目</span>
            </div>
            <div className="toiv-preview-body">
                <div className="toiv-preview-copy">
                    <span className="toiv-preview-kicker">{name}</span>
                    <h3>把每一场戏钉在锚点上</h3>
                    <p>{description}</p>
                    <div className="toiv-preview-actions" aria-hidden="true">
                        <span className="lime">生成分镜</span>
                        <span className="outline">保存草稿</span>
                    </div>
                </div>
                <div className="toiv-preview-card" aria-hidden="true">
                    <header><span>场景 07</span><em>冻结</em></header>
                    <div className="toiv-preview-thumb"><span /></div>
                    <small>四视图 · 角色一致</small>
                </div>
            </div>
            <div className="toiv-preview-canvas" aria-hidden="true"><i /><i /><i /></div>
        </section>
    );
}
