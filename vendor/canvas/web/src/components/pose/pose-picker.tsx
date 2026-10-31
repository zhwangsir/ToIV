/** W5 · PosePicker — pick mode for /create reference slot. */
import { PoseGallerySurface } from "@/components/pose/pose-gallery-surface";
import { AppModal } from "@/components/ui/product/app-modal";
import type { PoseEntry, PoseGroup } from "@/lib/pose-catalog";

export type PosePickerProps = {
    open: boolean;
    onClose: () => void;
    onSelect: (entry: PoseEntry, group: PoseGroup) => void;
};

export function PosePicker({ open, onClose, onSelect }: PosePickerProps) {
    return (
        <AppModal
            open={open}
            onCancel={onClose}
            title="从姿势库选"
            footer={null}
            centered
            destroyOnHidden
            width="min(960px, calc(100vw - 32px))"
            className="toiv-pose-picker-modal"
            data-testid="pose-picker-modal"
        >
            <div style={{ padding: "4px 4px 8px" }}>
                <PoseGallerySurface
                    mode="pick"
                    title="姿势库"
                    meta="选用后回填创作参考图"
                    onPick={(entry, group) => {
                        onSelect(entry, group);
                        onClose();
                    }}
                />
            </div>
        </AppModal>
    );
}
