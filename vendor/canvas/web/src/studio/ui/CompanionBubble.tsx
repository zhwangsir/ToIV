export function CompanionBubble({ text, onDismiss }: { text: string; onDismiss: () => void }) {
    return (
        <div className="stv-buddy">
            <span className="stv-buddy-bubble">
                <b>小爪：</b>{text}
                <button type="button" className="stv-buddy-x" onClick={onDismiss} aria-label="关闭提示">×</button>
            </span>
            <span className="stv-buddy-pet" aria-hidden="true" />
        </div>
    );
}
