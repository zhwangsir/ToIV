export type PolicyLocation = { pathname?: string; search?: string };
export type PolicyContentClass = "sfw" | "nsfw" | "unknown";

export interface ContentPolicy {
    id: string;
    fallbackImageBasename: string;
    fallbackVideoModel: string;
    gatedPaths: readonly string[];
    gatedQuery: Readonly<Record<string, readonly string[]>>;
    adultOnlyPoseSystems: readonly string[];
    coverage: readonly string[];
    copy: {
        underageAdult: string;
        guardReason: string;
        switchToAdult: string;
        stayNormal: string;
        confirmSwitch: string;
        slotAdult: string;
        lockLabel: string;
        lockedHint: string;
        modelsHiddenEmpty: string;
        appsHiddenEmpty: string;
        mediaLocked: string;
        poseSystemsHidden: string;
        fallbackTip: string;
        adultRequiredReason: string;
        adultRequiredAction: string;
        guardAction: string;
        retryNeedsChangedInput: string;
        modeUpdatedNewAttempt: string;
        lockedLabel: string;
        assetLockedHint: string;
        taskLockedHint: string;
        queueLockedHint: string;
    };
    isUnderage(birthdate: string | null): boolean;
    allowsContent(adultOn: boolean): boolean;
    isAppVisible(pure: boolean, adultOn: boolean): boolean;
    isAssetListable(rating: PolicyContentClass, adultOn: boolean): boolean;
    isAssetSelectable(rating: PolicyContentClass, adultOn: boolean): boolean;
    isPoseVisible(system: string, adultOn: boolean): boolean;
    isGatedLocation(location: PolicyLocation, exclusiveAppIds: readonly string[]): boolean;
    shouldSoften(adultOn: boolean): boolean;
    shouldFallback(previousAdult: boolean, nextAdult: boolean): boolean;
    shouldConfirmModeSwitch(previousAdult: boolean, nextAdult: boolean): boolean;
    /** 该失败类别是否属于本策略管辖的内容闸（决定文案、指纹与重试放行）。 */
    isContentGate(category: string): boolean;
    /** 该失败类别是否允许按原输入自动重试；技术类失败由主代码自行判断。 */
    allowsAutomaticRetry(category: string): boolean;
}

export const contentPolicy: ContentPolicy = {
    id: "unrestricted",
    fallbackImageBasename: "",
    fallbackVideoModel: "",
    gatedPaths: [],
    gatedQuery: {},
    adultOnlyPoseSystems: [],
    coverage: [],
    copy: {
        underageAdult: "",
        guardReason: "",
        switchToAdult: "",
        stayNormal: "",
        confirmSwitch: "",
        slotAdult: "",
        lockLabel: "",
        lockedHint: "",
        modelsHiddenEmpty: "",
        appsHiddenEmpty: "",
        mediaLocked: "",
        poseSystemsHidden: "",
        fallbackTip: "",
        adultRequiredReason: "",
        adultRequiredAction: "",
        guardAction: "",
        retryNeedsChangedInput: "",
        modeUpdatedNewAttempt: "",
        lockedLabel: "",
        assetLockedHint: "",
        taskLockedHint: "",
        queueLockedHint: "",
    },
    isUnderage: () => false,
    allowsContent: () => true,
    isAppVisible: () => true,
    isAssetListable: () => true,
    isAssetSelectable: () => true,
    isPoseVisible: () => true,
    isGatedLocation: () => false,
    shouldSoften: () => false,
    shouldFallback: () => false,
    shouldConfirmModeSwitch: () => false,
    isContentGate: () => false,
    allowsAutomaticRetry: () => true,
};
