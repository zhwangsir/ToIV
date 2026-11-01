import {
    createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from "react";
import { useLocation } from "react-router-dom";
import {
    cancelTask, deriveActiveTasks, loadActiveTasks, loadRecentTasks, loadTaskCounts, loadTaskHealth, mergePrimeTasks,
    rerunTask, type PrimeHealth, type PrimeTask, type PrimeTaskCounts, type PrimeTaskPhase,
} from "../adapters/tasks";

type TaskCenterData = {
    active: PrimeTask[];
    recent: PrimeTask[];
    counts: PrimeTaskCounts | null;
    recentPhase: PrimeTaskPhase;
    activePhase: PrimeTaskPhase;
    health: PrimeHealth | null;
    healthPhase: PrimeTaskPhase;
    updatedAt: number | null;
    pending: string | null;
    rerunning: string | null;
    cancelError: string | null;
    notice: string;
    noticeError: boolean;
    revision: number;
};

export type TaskCenterValue = TaskCenterData & {
    merged: PrimeTask[];
    acquire: () => () => void;
    refresh: () => void;
    refreshHealth: () => void;
    cancel: (id: string) => void;
    rerun: (id: string) => void;
    dismissNotice: () => void;
};

const INITIAL: TaskCenterData = {
    active: [], recent: [], counts: null,
    recentPhase: "idle", activePhase: "idle", health: null, healthPhase: "idle",
    updatedAt: null, pending: null, rerunning: null, cancelError: null, notice: "", noticeError: false,
    revision: 0,
};

const noop = () => {};
const IDLE: TaskCenterValue = {
    ...INITIAL,
    merged: [],
    acquire: () => noop,
    refresh: noop,
    refreshHealth: noop,
    cancel: noop,
    rerun: noop,
    dismissNotice: noop,
};

const TaskCenterContext = createContext<TaskCenterValue | null>(null);

function hasSession(): boolean {
    try { return Boolean(localStorage.getItem("toiv_token")); } catch { return false; }
}

export function TaskCenterProvider({ children }: { children: ReactNode }) {
    const location = useLocation();
    const [data, setData] = useState<TaskCenterData>(INITIAL);
    const [interest, setInterest] = useState(0);
    const [refreshKey, setRefreshKey] = useState(0);
    const [healthKey, setHealthKey] = useState(0);
    const pendingRef = useRef<string | null>(null);
    const rerunningRef = useRef<string | null>(null);
    const interestRef = useRef(0);
    const mounted = useRef(true);
    const dataRef = useRef(data);

    useEffect(() => { dataRef.current = data; }, [data]);

    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);

    const acquire = useCallback(() => {
        interestRef.current += 1;
        setInterest(interestRef.current);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            interestRef.current = Math.max(0, interestRef.current - 1);
            setInterest(interestRef.current);
        };
    }, []);

    const enabled = interest > 0 && location.pathname !== "/auth" && hasSession();

    useEffect(() => {
        if (!enabled) return;
        let alive = true;
        let reading = false;
        const controller = new AbortController();
        const read = async (initial: boolean) => {
            if (reading) return;
            reading = true;
            if (initial) {
                setData(current => ({
                    ...current,
                    recentPhase: current.recent.length ? current.recentPhase : "loading",
                    activePhase: current.active.length ? current.activePhase : "loading",
                }));
            }
            const [recentResult, activeResult, countsResult] = await Promise.allSettled([
                loadRecentTasks(controller.signal),
                loadActiveTasks(controller.signal),
                loadTaskCounts(controller.signal),
            ]);
            reading = false;
            if (!alive) return;
            const aborted = controller.signal.aborted;
            setData(current => {
                const next = { ...current };
                if (recentResult.status === "fulfilled") {
                    next.recent = recentResult.value;
                    next.recentPhase = "ready";
                    next.updatedAt = Date.now();
                } else if (!aborted) {
                    next.recentPhase = "error";
                }
                if (activeResult.status === "fulfilled") {
                    next.active = activeResult.value;
                    next.activePhase = "ready";
                } else if (!aborted) {
                    next.activePhase = "error";
                    if (!current.active.length) next.active = deriveActiveTasks(next.recent);
                }
                if (countsResult.status === "fulfilled") next.counts = countsResult.value;
                return next;
            });
        };
        void read(true);
        const timer = setInterval(() => {
            // The last consumer may unmount between commits; stop before the effect cleanup runs.
            if (interestRef.current === 0) return;
            if (document.visibilityState !== "hidden") void read(false);
        }, 5000);
        const onVisible = () => {
            if (interestRef.current === 0) return;
            if (document.visibilityState === "visible") void read(false);
        };
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            alive = false;
            clearInterval(timer);
            controller.abort();
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [enabled, refreshKey]);

    useEffect(() => {
        if (!enabled) return;
        let alive = true;
        let reading = false;
        const controller = new AbortController();
        const load = async (initial: boolean) => {
            if (reading) return;
            reading = true;
            if (initial) setData(current => ({ ...current, healthPhase: current.health ? current.healthPhase : "loading" }));
            try {
                const health = await loadTaskHealth(controller.signal);
                if (alive) setData(current => ({ ...current, health, healthPhase: "ready" }));
            } catch {
                if (alive && !controller.signal.aborted) setData(current => ({ ...current, healthPhase: "error" }));
            } finally {
                reading = false;
            }
        };
        void load(true);
        const timer = setInterval(() => {
            if (document.visibilityState !== "hidden") void load(false);
        }, 60_000);
        const onVisible = () => { if (document.visibilityState === "visible") void load(false); };
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            alive = false;
            clearInterval(timer);
            controller.abort();
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [enabled, healthKey]);

    const refresh = useCallback(() => setRefreshKey(value => value + 1), []);
    const refreshHealth = useCallback(() => setHealthKey(value => value + 1), []);

    const cancel = useCallback((id: string) => {
        if (!id.trim() || pendingRef.current) return;
        pendingRef.current = id;
        setData(current => ({ ...current, pending: id, cancelError: null, notice: "", noticeError: false }));
        void (async () => {
            try {
                await cancelTask(id);
                if (!mounted.current) return;
                const current = dataRef.current;
                // A response that lands after the list moved on (reopen, refresh) must not
                // resurrect a notice for a task the user can no longer see.
                const present = current.active.some(task => task.id === id) || current.recent.some(task => task.id === id);
                if (!present) {
                    setData(value => ({ ...value, pending: null, cancelError: null }));
                    return;
                }
                setData(value => ({
                    ...value,
                    active: value.active.filter(task => task.id !== id),
                    recent: value.recent.map(task => task.id === id
                        ? { ...task, status: "canceled" as const, rawStatus: "canceled", cancellable: false, canRerun: task.hasParams, failure: undefined }
                        : task),
                    pending: null,
                    cancelError: null,
                    notice: "任务已取消",
                    noticeError: false,
                    revision: value.revision + 1,
                }));
                setRefreshKey(value => value + 1);
            } catch {
                if (mounted.current) setData(current => ({ ...current, pending: null, cancelError: id }));
            } finally {
                pendingRef.current = null;
            }
        })();
    }, []);

    const rerun = useCallback((id: string) => {
        if (!id.trim() || rerunningRef.current) return;
        rerunningRef.current = id;
        setData(current => ({ ...current, rerunning: id, notice: "", noticeError: false }));
        void (async () => {
            try {
                await rerunTask(id);
                if (!mounted.current) return;
                setData(current => ({
                    ...current, rerunning: null, notice: "已提交重试，新任务会出现在列表中", noticeError: false,
                    revision: current.revision + 1,
                }));
                setRefreshKey(value => value + 1);
            } catch (error) {
                if (mounted.current) setData(current => ({
                    ...current,
                    rerunning: null,
                    notice: error instanceof Error && error.message ? error.message : "重试提交失败",
                    noticeError: true,
                }));
            } finally {
                rerunningRef.current = null;
            }
        })();
    }, []);

    const dismissNotice = useCallback(() => setData(current => ({ ...current, notice: "", noticeError: false })), []);

    const value = useMemo<TaskCenterValue>(() => ({
        ...data,
        merged: mergePrimeTasks(data.active, data.recent),
        acquire, refresh, refreshHealth, cancel, rerun, dismissNotice,
    }), [data, acquire, refresh, refreshHealth, cancel, rerun, dismissNotice]);

    return <TaskCenterContext.Provider value={value}>{children}</TaskCenterContext.Provider>;
}

/** Safe outside the provider (server render and isolated component tests). */
export function useTaskCenter(): TaskCenterValue {
    return useContext(TaskCenterContext) ?? IDLE;
}

/** Task polling runs only while at least one task surface is mounted and visible. */
export function useTaskPolling(enabled = true) {
    const { acquire } = useTaskCenter();
    useEffect(() => {
        if (!enabled) return;
        return acquire();
    }, [enabled, acquire]);
}
