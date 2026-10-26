import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

type CreationStudioSlotsValue = {
    inspector: ReactNode;
    setInspector: (node: ReactNode) => void;
    clearInspector: () => void;
    /** TL R4: when a shot card is selected, right pane expands to 420 (max 480). */
    shotSelected: boolean;
    setShotSelected: (selected: boolean) => void;
};

const CreationStudioSlotsContext = createContext<CreationStudioSlotsValue | null>(null);

export function CreationStudioSlotsProvider({ children }: { children: ReactNode }) {
    const [inspector, setInspectorState] = useState<ReactNode>(null);
    const [shotSelected, setShotSelectedState] = useState(false);
    const setInspector = useCallback((node: ReactNode) => setInspectorState(node), []);
    const clearInspector = useCallback(() => setInspectorState(null), []);
    const setShotSelected = useCallback((selected: boolean) => setShotSelectedState(Boolean(selected)), []);
    const value = useMemo(
        () => ({ inspector, setInspector, clearInspector, shotSelected, setShotSelected }),
        [inspector, setInspector, clearInspector, shotSelected, setShotSelected],
    );
    return <CreationStudioSlotsContext.Provider value={value}>{children}</CreationStudioSlotsContext.Provider>;
}

export function useCreationStudioSlots() {
    return useContext(CreationStudioSlotsContext);
}
