import { create } from "zustand";

export type StudioToast = { id: number; text: string; warn?: boolean };

let seq = 1;

export const useStudioToast = create<{
    toasts: StudioToast[];
    push: (text: string, warn?: boolean) => void;
    dismiss: (id: number) => void;
}>((set) => ({
    toasts: [],
    push: (text, warn) => {
        const id = seq++;
        set((state) => ({ toasts: [...state.toasts, { id, text, warn }].slice(-3) }));
        setTimeout(() => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })), 4000);
    },
    dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}));

export function useStudioToastPush() {
    return useStudioToast((state) => state.push);
}
