import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

import type { ToivDramaDetail, ToivStageId } from "@/services/toiv/client";

/** stageFocus 携带 pid:旧项目的聚焦请求不得污染新项目的 Inspector */
type StageFocus = { pid: string; stage: ToivStageId; nonce: number };

type CreationStudioSlotsValue = {
    inspector: ReactNode;
    setInspector: (node: ReactNode) => void;
    clearInspector: () => void;
    /** TL R4: when a shot card is selected, right pane expands to 420 (max 480). */
    shotSelected: boolean;
    setShotSelected: (selected: boolean) => void;
    /** C1c:drama-workspace 注册的项目真源;Inspector 只读消费,不另造项目状态 */
    projectDetail: ToivDramaDetail | null;
    /** 项目 load():动作成功后必须经它刷新真源;返回 null = 刷新未确认(切换/失败/已清理) */
    reloadProject: () => Promise<ToivDramaDetail | null>;
    registerProject: (detail: ToivDramaDetail | null, reload: () => Promise<ToivDramaDetail | null>) => void;
    /** pid 守卫:仅当注册 pid 匹配才清除(避免旧卸载清理掉新项目的注册) */
    clearProject: (pid?: string) => void;
    /** C1c:阶段阻断定位(pid 关联)→ 请求打开 Inspector 并聚焦指定阶段(workbench 负责开合) */
    stageFocus: StageFocus | null;
    requestStageFocus: (pid: string, stage: ToivStageId) => void;
};

const CreationStudioSlotsContext = createContext<CreationStudioSlotsValue | null>(null);

export function CreationStudioSlotsProvider({ children }: { children: ReactNode }) {
    const [inspector, setInspectorState] = useState<ReactNode>(null);
    const [shotSelected, setShotSelectedState] = useState(false);
    const [projectDetail, setProjectDetail] = useState<ToivDramaDetail | null>(null);
    const [stageFocus, setStageFocus] = useState<StageFocus | null>(null);
    const reloadRef = useRef<() => Promise<ToivDramaDetail | null>>(async () => null);
    const pidRef = useRef<string | null>(null);
    const setInspector = useCallback((node: ReactNode) => setInspectorState(node), []);
    const clearInspector = useCallback(() => setInspectorState(null), []);
    const setShotSelected = useCallback((selected: boolean) => setShotSelectedState(Boolean(selected)), []);
    const registerProject = useCallback((detail: ToivDramaDetail | null, reload: () => Promise<ToivDramaDetail | null>) => {
        const nextPid = detail?.id ?? null;
        // 项目注册切换:同步清旧项目的 stageFocus(p1 的聚焦不得带到 p2)
        if (pidRef.current !== nextPid) setStageFocus(null);
        pidRef.current = nextPid;
        reloadRef.current = reload;
        setProjectDetail(detail);
    }, []);
    const clearProject = useCallback((pid?: string) => {
        if (pid !== undefined && pidRef.current !== pid) return;
        pidRef.current = null;
        reloadRef.current = async () => null;
        setStageFocus(null);
        setProjectDetail(null);
    }, []);
    const reloadProject = useCallback(() => reloadRef.current(), []);
    const requestStageFocus = useCallback((pid: string, stage: ToivStageId) => {
        setStageFocus((prev) => ({ pid, stage, nonce: (prev?.nonce ?? 0) + 1 }));
    }, []);
    const value = useMemo(
        () => ({
            inspector, setInspector, clearInspector, shotSelected, setShotSelected,
            projectDetail, reloadProject, registerProject, clearProject, stageFocus, requestStageFocus,
        }),
        [inspector, setInspector, clearInspector, shotSelected, setShotSelected,
            projectDetail, reloadProject, registerProject, clearProject, stageFocus, requestStageFocus],
    );
    return <CreationStudioSlotsContext.Provider value={value}>{children}</CreationStudioSlotsContext.Provider>;
}

export function useCreationStudioSlots() {
    return useContext(CreationStudioSlotsContext);
}
