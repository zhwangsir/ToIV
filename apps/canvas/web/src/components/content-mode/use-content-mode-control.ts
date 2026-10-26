import { useCallback, useState, useSyncExternalStore } from "react";

import {
    COPY_MODE_ADULT,
    COPY_MODE_NORMAL,
    getR18ModeSnapshot,
    getServerR18ModeSnapshot,
    isUnderage,
    setR18Mode,
    subscribeR18Mode,
} from "@/redline";

/** Shared me/mode wiring for A/B/C prototypes. */
export function useContentModeControl() {
    const adultOn = useSyncExternalStore(subscribeR18Mode, getR18ModeSnapshot, getServerR18ModeSnapshot);
    const [confirming, setConfirming] = useState(false);
    const label = adultOn ? COPY_MODE_ADULT : COPY_MODE_NORMAL;

    const requestAdult = useCallback(() => {
        if (adultOn) return;
        if (isUnderage()) return;
        setConfirming(true);
    }, [adultOn]);

    const confirmAdult = useCallback(() => {
        setR18Mode(true);
        setConfirming(false);
    }, []);

    const cancelConfirm = useCallback(() => setConfirming(false), []);

    const goOrdinary = useCallback(() => {
        setConfirming(false);
        if (!adultOn) return;
        setR18Mode(false);
    }, [adultOn]);

    const select = useCallback(
        (nextAdult: boolean) => {
            if (nextAdult) requestAdult();
            else goOrdinary();
        },
        [goOrdinary, requestAdult],
    );

    return {
        adultOn,
        label,
        confirming,
        requestAdult,
        confirmAdult,
        cancelConfirm,
        goOrdinary,
        select,
    };
}
