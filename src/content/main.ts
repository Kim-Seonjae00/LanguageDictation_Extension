import { Msg, type DictationResult, type SendDictation, type ExtMessage, type TimedTextTrack, type AudioTrack } from "../shared/protocol";
import { parseTtmlSubtitle } from "../shared/ttmlParser";
import { setSubFluentLogLevel,subFluentDebug,subFluentError } from "../shared/util";
import { contentState, makeTrackKey, type TimedTextTrackMeta, type StoredTimedText } from "./state/contentState";

setSubFluentLogLevel("DEBUG");

// --- Cue time-based logging (NO DOM, console only) ---
type CueLike = { start: number; end: number; text: string; id?: string; regionX?: number; regionY?: number; };
type Cluster = {
    key: string;
    ls: number;
    le: number;
    learn: string[];
    native: string[];
};
type CueData = { start: number, end: number, learn: string[]; native: string[] };

function getVideoEl(): HTMLVideoElement | null {
    return document.querySelector("video");
}

let stopCueLogging: (() => void) | null = null;

let sfDictationMode = false; // default OFF
let sfOverlay: HTMLDivElement | null = null;
let sfInput: HTMLInputElement | null = null;
let sfExpectedStart = 0;
let sfExpectedText = "";
let sfNativeText = "";
let sfLastDictationKey: string | null = null;

let sfDictationVideo: HTMLVideoElement | null = null;
// Rewind a bit on overlay close so the next cue isn’t clipped
//const SF_DICTATION_REWIND_SEC = 0.35;
let sfLatestMovieId: string | null = null;
let sfLatestLearningMerged: CueLike[] | null = null;
let sfLatestNativeMerged: CueLike[] | null = null;

function rebuildCueWindowIfReady() {
    if (!sfLatestMovieId || !sfLatestLearningMerged || !sfLatestNativeMerged) return;
    // generateWindow will internally decide whether to collapse to sentence-map based on `sfDictationMode`
    generateWindow(sfLatestMovieId, sfLatestLearningMerged as any, sfLatestNativeMerged as any, startCueLogging);
}

function resetSubtitleSessionState(reason = "") {
    try {
        if (reason) {
            console.debug("[SubFluent] resetSubtitleSessionState:", reason);
        }
    } catch {
        // ignore
    }

    sfLatestMovieId = null;
    sfLatestLearningMerged = null;
    sfLatestNativeMerged = null;
    sfLastDictationKey = null;
    sfExpectedStart = 0;
    sfExpectedText = "";
    sfNativeText = "";

    clearSubtitleText();
    updateSubtitleOverlayVisibility();
}

let sfFocusGuardOn = false;

let sfFocusGuardTimer: number | null = null;

// ===== Fullscreen-safe UI mounting =====
function getUiHost(): HTMLElement {
    const fe = document.fullscreenElement as HTMLElement | null;
    // Prefer fullscreen root so overlays are visible in fullscreen mode
    if (fe) return fe;
    // Fallbacks
    return (document.body || document.documentElement) as HTMLElement;
}

function ensureMounted(node: HTMLElement) {
    const host = getUiHost();
    if (node.parentElement === host) return;
    try {
        host.appendChild(node);
    } catch {
        // ignore
    }
}

function remountAllSubFluentUi() {
    if (sfSubtitleOverlay) ensureMounted(sfSubtitleOverlay);
    if (sfOverlay) ensureMounted(sfOverlay);
    if (sfSettingsOverlay) ensureMounted(sfSettingsOverlay);
}

// Netflix fullscreen toggles can swap fullscreen root; re-mount UI each time.
document.addEventListener("fullscreenchange", remountAllSubFluentUi, true);
(document as any).addEventListener?.("webkitfullscreenchange", remountAllSubFluentUi, true);
// ===== Fullscreen-safe UI mounting end =====

// ===== SubFluent Subtitle UI (dual lines) =====
let sfSubtitleOverlay: HTMLDivElement | null = null;
let sfSubtitleLearn: HTMLDivElement | null = null;
let sfSubtitleNative: HTMLDivElement | null = null;
let sfSubtitleVisible = true; // 나중에 토글 만들 때 쓰면 됨

function ensureSubtitleOverlay() {
    if (sfSubtitleOverlay) return;

    sfSubtitleOverlay = document.createElement("div");
    sfSubtitleOverlay.id = "__sf_subtitle_overlay";
    sfSubtitleOverlay.style.position = "fixed";
    sfSubtitleOverlay.style.left = "0";
    sfSubtitleOverlay.style.right = "0";
    sfSubtitleOverlay.style.bottom = "87px"; // 넷플릭스 컨트롤 위
    sfSubtitleOverlay.style.zIndex = "2147483646";
    sfSubtitleOverlay.style.pointerEvents = "none";
    sfSubtitleOverlay.style.display = "flex";
    sfSubtitleOverlay.style.justifyContent = "center";

    const box = document.createElement("div");
    box.style.width = "min(980px, 92vw)";
    box.style.padding = "0";
    box.style.background = "transparent";
    box.style.border = "0";
    box.style.boxShadow = "none";
    box.style.color = "#fff";
    box.style.fontFamily = "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
    box.style.textAlign = "center";

    sfSubtitleLearn = document.createElement("div");
    sfSubtitleLearn.id = "__sf_subtitle_learn";
    sfSubtitleLearn.style.fontSize = "32px";
    sfSubtitleLearn.style.fontWeight = "600";
    sfSubtitleLearn.style.lineHeight = "1.25";
    sfSubtitleLearn.style.textShadow = "0 2px 4px rgba(0,0,0,1), 0 0 2px rgba(0,0,0,1), 0 8px 18px rgba(0,0,0,0.85)";

    sfSubtitleNative = document.createElement("div");
    sfSubtitleNative.id = "__sf_subtitle_native";
    sfSubtitleNative.style.fontSize = "28px";
    sfSubtitleNative.style.opacity = "0.92";
    sfSubtitleNative.style.marginTop = "6px";
    sfSubtitleNative.style.lineHeight = "1.25";
    sfSubtitleNative.style.textShadow = "0 2px 4px rgba(0,0,0,1), 0 0 2px rgba(0,0,0,1), 0 8px 18px rgba(0,0,0,0.85)";

    box.appendChild(sfSubtitleLearn);
    box.appendChild(sfSubtitleNative);
    sfSubtitleOverlay.appendChild(box);

    ensureMounted(sfSubtitleOverlay);
    updateSubtitleOverlayVisibility();
}

function updateSubtitleOverlayVisibility() {
    if (!sfSubtitleOverlay) return;

    // Dictation mode ON이면 자막 UI는 항상 숨김 (overlay 열림 여부 무관)
    const shouldShow = sfSubtitleVisible && !sfDictationMode;
    sfSubtitleOverlay.style.display = shouldShow ? "flex" : "none";
}

function setSubtitleText(learnText: string, nativeText: string) {
    ensureSubtitleOverlay();
    remountAllSubFluentUi();
    if (!sfSubtitleLearn || !sfSubtitleNative) return;
    sfSubtitleLearn.textContent = learnText || "";
    sfSubtitleNative.textContent = nativeText || "";
}

function clearSubtitleText() {
    if (!sfSubtitleLearn || !sfSubtitleNative) return;
    sfSubtitleLearn.textContent = "";
    sfSubtitleNative.textContent = "";
}
// ===== SubFluent Subtitle UI end =====

function enableDictationFocusGuard() {
    if (sfFocusGuardOn) return;
    sfFocusGuardOn = true;

    const onFocusIn = (ev: FocusEvent) => {
        if (!sfOverlay || sfOverlay.style.display === "none") return;
        const target = ev.target as Node | null;
        if (!target) return;
        if (sfOverlay && !sfOverlay.contains(target)) {
            setTimeout(() => sfInput?.focus(), 0);
        }
    };

    const onPointerDownCapture = (ev: Event) => {
        if (!sfOverlay || sfOverlay.style.display === "none") return;
        const target = ev.target as Node | null;
        if (!target) return;
        // overlay 뒤(넷플릭스) 클릭/포커스 훔치기 방지
        if (sfOverlay && !sfOverlay.contains(target)) {
            ev.preventDefault();
            ev.stopPropagation();
        }
    };

    // NOTE: capture 단계에서 무조건 stopPropagation 하면 input까지 키가 못 가는 케이스가 있음.
    // 그래서 "input에 포커스가 없는 경우"에만 Netflix 단축키를 강하게 차단한다.
    const onKeyCapture = (ev: KeyboardEvent) => {
        if (!sfOverlay || sfOverlay.style.display === "none") return;

        const ae = document.activeElement as HTMLElement | null;
        const isInputFocused = !!(ae && (ae === sfInput || (sfOverlay.contains(ae) && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA"))));

        // input에 포커스가 없으면 Netflix 단축키/컨트롤을 완전히 차단
        if (!isInputFocused) {
            ev.preventDefault();
            ev.stopPropagation();
            return;
        }
    };

    const onVisibility = () => {
        if (!sfOverlay || sfOverlay.style.display === "none") return;
        setTimeout(() => sfInput?.focus(), 0);
    };

    (window as any).__sf_onFocusIn = onFocusIn;
    (window as any).__sf_onPointerDownCapture = onPointerDownCapture;
    (window as any).__sf_onKeyCapture = onKeyCapture;
    (window as any).__sf_onVisibility = onVisibility;

    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("pointerdown", onPointerDownCapture, true);
    document.addEventListener("mousedown", onPointerDownCapture, true);
    document.addEventListener("touchstart", onPointerDownCapture, true);
    window.addEventListener("keydown", onKeyCapture, true);
    window.addEventListener("keyup", onKeyCapture, true);
    document.addEventListener("visibilitychange", onVisibility, true);

    // 일부 레이어가 focusin 없이 activeElement만 바꾸는 케이스 방어
    sfFocusGuardTimer = window.setInterval(() => {
        if (!sfOverlay || sfOverlay.style.display === "none") return;
        if (!sfInput) return;
        const ae = document.activeElement;
        if (ae && sfOverlay.contains(ae)) return;
        sfInput.focus();
    }, 250);
}

function disableDictationFocusGuard() {
    if (!sfFocusGuardOn) return;
    sfFocusGuardOn = false;

    const onFocusIn = (window as any).__sf_onFocusIn as ((e: FocusEvent) => void) | undefined;
    const onPointerDownCapture = (window as any).__sf_onPointerDownCapture as ((e: Event) => void) | undefined;
    const onKeyCapture = (window as any).__sf_onKeyCapture as ((e: KeyboardEvent) => void) | undefined;
    const onVisibility = (window as any).__sf_onVisibility as (() => void) | undefined;

    if (onFocusIn) document.removeEventListener("focusin", onFocusIn, true);
    if (onPointerDownCapture) {
        document.removeEventListener("pointerdown", onPointerDownCapture, true);
        document.removeEventListener("mousedown", onPointerDownCapture, true);
        document.removeEventListener("touchstart", onPointerDownCapture, true);
    }
    if (onKeyCapture) {
        window.removeEventListener("keydown", onKeyCapture, true);
        window.removeEventListener("keyup", onKeyCapture, true);
    }
    if (onVisibility) document.removeEventListener("visibilitychange", onVisibility, true);

    (window as any).__sf_onFocusIn = undefined;
    (window as any).__sf_onPointerDownCapture = undefined;
    (window as any).__sf_onKeyCapture = undefined;
    (window as any).__sf_onVisibility = undefined;

    if (sfFocusGuardTimer != null) {
        clearInterval(sfFocusGuardTimer);
        sfFocusGuardTimer = null;
    }
}

function ensureDictationOverlay() {
    if (sfOverlay) return;

    sfOverlay = document.createElement("div");
    sfOverlay.id = "__subfluent_dictation_overlay";
    sfOverlay.style.position = "fixed";
    sfOverlay.style.inset = "0";
    sfOverlay.style.zIndex = "2147483647";
    sfOverlay.style.background = "rgba(0,0,0,0.55)";
    (sfOverlay.style as any).backdropFilter = "blur(6px)";
    sfOverlay.style.display = "flex";
    sfOverlay.style.alignItems = "center";
    sfOverlay.style.justifyContent = "center";
    sfOverlay.style.pointerEvents = "auto";
    // Accessibility / focus trap help
    sfOverlay.tabIndex = -1;
    sfOverlay.setAttribute("role", "dialog");
    sfOverlay.setAttribute("aria-modal", "true");

    const box = document.createElement("div");
    box.style.width = "min(760px, 92vw)";
    box.style.background = "linear-gradient(180deg, rgba(28,28,30,0.98), rgba(18,18,20,0.98))";
    box.style.border = "1px solid rgba(255,255,255,0.10)";
    box.style.borderRadius = "16px";
    box.style.padding = "18px 18px 16px";
    box.style.boxShadow = "0 16px 60px rgba(0,0,0,0.55)";
    box.style.color = "#fff";
    box.style.fontFamily = "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";

    // --- top bar ---
    const title = document.createElement("div");
    title.textContent = "SubDictate";
    title.style.fontSize = "18px";
    title.style.fontWeight = "750";
    title.style.marginBottom = "0px";

    const badge = document.createElement("span");
    badge.textContent = "DICTATION";
    badge.style.fontSize = "11px";
    badge.style.letterSpacing = "0.08em";
    badge.style.padding = "6px 10px";
    badge.style.borderRadius = "999px";
    badge.style.background = "rgba(255,255,255,0.10)";
    badge.style.border = "1px solid rgba(255,255,255,0.14)";
    badge.style.opacity = "0.95";

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "✕";
    closeBtn.style.width = "36px";
    closeBtn.style.height = "36px";
    closeBtn.style.borderRadius = "10px";
    closeBtn.style.border = "1px solid rgba(255,255,255,0.12)";
    closeBtn.style.background = "rgba(255,255,255,0.08)";
    closeBtn.style.color = "#fff";
    closeBtn.style.cursor = "pointer";
    closeBtn.style.fontSize = "14px";
    closeBtn.style.lineHeight = "1";

    closeBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideDictationOverlay(false);
    });

    // ===== [SF UI ONLY] replay button (handler to be implemented by user) =====
    const replayBtn = document.createElement("button");
    replayBtn.type = "button";
    replayBtn.id = "__sf_replay";
    replayBtn.textContent = "↺";
    replayBtn.title = "다시듣기";
    replayBtn.style.width = "36px";
    replayBtn.style.height = "36px";
    replayBtn.style.borderRadius = "10px";
    replayBtn.style.border = "1px solid rgba(255,255,255,0.12)";
    replayBtn.style.background = "rgba(255,255,255,0.08)";
    replayBtn.style.color = "#fff";
    replayBtn.style.cursor = "pointer";
    replayBtn.style.fontSize = "14px";
    replayBtn.style.lineHeight = "1";
    // TODO(user): add click handler for replay behavior
    // replayBtn.addEventListener("click", () => { /* implement replay */ });
    // ===== [SF UI ONLY] end =====

    const titleWrap = document.createElement("div");
    titleWrap.style.display = "flex";
    titleWrap.style.alignItems = "center";
    titleWrap.style.gap = "10px";
    titleWrap.appendChild(badge);
    titleWrap.appendChild(title);

    const topBar = document.createElement("div");
    topBar.style.display = "flex";
    topBar.style.alignItems = "center";
    topBar.style.justifyContent = "space-between";
    topBar.style.gap = "12px";
    topBar.style.marginBottom = "10px";
    const rightBtns = document.createElement("div");
    rightBtns.style.display = "flex";
    rightBtns.style.alignItems = "center";
    rightBtns.style.gap = "8px";

    topBar.appendChild(titleWrap);
    topBar.appendChild(rightBtns);

    const hint = document.createElement("div");
    hint.id = "__sf_hint";
    hint.innerHTML = "Type what you hear. <br>Enter = submit · Esc = close";
    hint.style.fontSize = "15px";
    hint.style.opacity = "0.82";
    hint.style.marginBottom = "12px";

    // native hint line (optional)
    const nativeLine = document.createElement("div");
    nativeLine.id = "__sf_native";
    nativeLine.style.fontSize = "15px";
    nativeLine.style.opacity = "0.78";
    nativeLine.style.marginBottom = "10px";
    nativeLine.style.color = "rgba(255,255,255,0.85)";

    const expected = document.createElement("div");
    expected.id = "__sf_expected";
    expected.style.fontSize = "16px";
    expected.style.opacity = "0.92";
    expected.style.marginBottom = "10px";
    expected.style.display = "none";
    expected.style.padding = "10px 12px";
    expected.style.borderRadius = "12px";
    expected.style.border = "1px solid rgba(255,255,255,0.10)";
    expected.style.background = "rgba(255,255,255,0.06)";

    const result = document.createElement("div");
    result.id = "__sf_result";
    result.style.fontSize = "16px";
    result.style.marginTop = "10px";
    result.style.paddingTop = "10px";
    result.style.borderTop = "1px solid rgba(255,255,255,0.10)";

    const stateLine = document.createElement("div");
    stateLine.id = "__sf_state";
    stateLine.style.marginBottom = "6px";

    const answerLine = document.createElement("div");
    answerLine.id = "__sf_answer";

    sfInput = document.createElement("input");
    sfInput.id = "__sf_input";
    sfInput.type = "text";
    sfInput.placeholder = "Type here...";
    sfInput.style.width = "100%";
    sfInput.style.fontSize = "20px";
    sfInput.style.padding = "12px 14px";
    sfInput.style.borderRadius = "12px";
    sfInput.style.border = "1px solid rgba(255,255,255,0.14)";
    sfInput.style.outline = "0";
    sfInput.style.boxSizing = "border-box";
    sfInput.style.background = "rgba(255,255,255,0.08)";
    sfInput.style.color = "#fff";
    sfInput.style.caretColor = "#fff";
    (sfInput.style as any).backdropFilter = "blur(6px)";

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.id = "__sf_next";
    nextBtn.textContent = "⏭";
    nextBtn.title = "다음";
    nextBtn.style.width = "36px";
    nextBtn.style.height = "36px";
    nextBtn.style.borderRadius = "10px";
    nextBtn.style.border = "1px solid rgba(255,255,255,0.12)";
    nextBtn.style.background = "rgba(255,255,255,0.08)";
    nextBtn.style.color = "#fff";
    nextBtn.style.cursor = "pointer";
    nextBtn.style.fontSize = "14px";
    nextBtn.style.lineHeight = "1";

    rightBtns.appendChild(replayBtn);
    rightBtns.appendChild(nextBtn);
    rightBtns.appendChild(closeBtn);

    nextBtn.addEventListener("click", () => {
        if(sfInput) sfInput.value = "";
        hideDictationOverlay(false);
    });

    replayBtn.addEventListener("click", () => {
        if (!sfDictationVideo) return;
        const start = sfExpectedStart * 1000;
        window.postMessage({ type: "PLAYER_SEEK", source: "SubFluent", start: start }, "*");
        hideDictationOverlay(false);
    });

    sfInput.addEventListener("keydown", (e) => {
        if (!sfInput) return;

        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            hideDictationOverlay(false);
            return;
        }

        if (e.key === "Enter") {
            const actual = sfInput.value;
            const expectedText = sfExpectedText;
            if (!expectedText) return;

            const payload: SendDictation = { expected: expectedText, actual };
            const msg: ExtMessage<typeof Msg.DICTATION_SEND> = { type: Msg.DICTATION_SEND, payload };

            chrome.runtime.sendMessage(msg, (response) => {
                const stateEl = document.getElementById("__sf_state");
                const expectedEl = document.getElementById("__sf_expected");
                const answerEl = document.getElementById("__sf_answer");
                if (!stateEl || !expectedEl || !answerEl) return;

                if (response?.type === Msg.DICTATION_RESULT) {
                    const result = response.payload as DictationResult;
                    expectedEl.style.display = "block";
                    expectedEl.innerHTML = `Expected: <span style="color:#8ef; font-weight:700;">${escapeHtml(result.sendDictation.expected)}</span>`;

                    if (result.correct) {
                        stateEl.innerHTML = "✅ Correct";
                        answerEl.innerHTML = `<span style="color:#a6ff9b;">${escapeHtml(result.sendDictation.actual)}</span>`;
                    } else {
                        stateEl.innerHTML = "❌ Wrong";

                        const wrongIndices = new Set<number>(result.wrong as any);
                        const words = result.sendDictation.actual.trim().split(/\s+/);
                        const highlighted = words
                            .map((w, idx) => (wrongIndices.has(idx) ? `<span style="color:#ff6b6b; font-weight:700;">${escapeHtml(w)}</span>` : escapeHtml(w)))
                            .join(" ");

                        answerEl.innerHTML = highlighted;
                    }
                }
            });

            sfInput.value = "";
            return;
        }
    });

    result.appendChild(stateLine);
    result.appendChild(answerLine);

    box.appendChild(topBar);
    box.appendChild(hint);
    box.appendChild(nativeLine);
    box.appendChild(sfInput);
    box.appendChild(expected);
    box.appendChild(result);

    sfOverlay.appendChild(box);
    ensureMounted(sfOverlay);
}

// ===== SubFluent Settings UI (modal) =====
let sfSettingsOverlay: HTMLDivElement | null = null;
let sfSettingsOpen = false;


let sfAvailableSubtitleLangs: TimedTextTrack[] = [];
let sfAvailableAudioLangs: AudioTrack[] = []

let sfSettingDictationEnabled = false; // settings modal toggle (synced from sfDictationMode on open)
let sfSyncSettingsDictationToggleVisual: ((checked: boolean) => void) | null = null;

// NOTE: Initialized from PLAYER_READY track lists (no hardcoded defaults)
let sfSettingAudioLang = "";        // trackId
let sfSettingSubtitleLang = "";     // trackId
let sfSettingTranslateLang = "";    // trackId

// Settings modal element refs (so we can refresh options/selection on each open)
let sfSettingsAudioSel: HTMLSelectElement | null = null;
let sfSettingsSubtitleSel: HTMLSelectElement | null = null;
let sfSettingsTranslateSel: HTMLSelectElement | null = null;

function refreshSettingsSelects() {
    if (!sfSettingsOverlay) return;

    // If defaults are still empty, derive from current title lists.
    ensureTrackIdDefaultsInitialized();

    // Ensure local lists are the latest single source of truth.
    sfAvailableSubtitleLangs = contentState.timedTextTrackList || [];
    sfAvailableAudioLangs = contentState.audioList || [];

    const fill = (sel: HTMLSelectElement | null, opts: any[], cur: string) => {
        if (!sel) return;
        sel.innerHTML = "";
        for (const o of opts) {
            const opt = document.createElement("option");
            opt.value = o.trackId;
            opt.textContent = o.displayName;
            sel.appendChild(opt);
        }

        // Selection: prefer `cur` if it exists; otherwise fall back to first option.
        const hasCur = !!opts.find((x: any) => x?.trackId === cur);
        const nextValue = hasCur ? cur : (opts[0]?.trackId as string) || "";
        sel.value = nextValue;
    };

    fill(sfSettingsAudioSel, sfAvailableAudioLangs, sfSettingAudioLang);
    fill(sfSettingsSubtitleSel, sfAvailableSubtitleLangs, sfSettingSubtitleLang);
    fill(sfSettingsTranslateSel, sfAvailableSubtitleLangs, sfSettingTranslateLang);

    // Keep state vars aligned with actual selected values
    if (sfSettingsAudioSel) sfSettingAudioLang = sfSettingsAudioSel.value;
    if (sfSettingsSubtitleSel) sfSettingSubtitleLang = sfSettingsSubtitleSel.value;
    if (sfSettingsTranslateSel) sfSettingTranslateLang = sfSettingsTranslateSel.value;
}

// ===== Persistent Settings (chrome.storage.local) =====
// NOTE: trackId/trackList can change per title. Persist only criteria that can be re-mapped.
const SF_SETTINGS_KEY = "sf_settings_v2" as const;

type SfTrackCriteria = {
  bcp47: string | null;
  trackType: string | null;
  rawTrackType: string | null;
};

type SfGlobalPrefs = {
  version: 2;
  dictationEnabled: boolean;

  preferredAudio: SfTrackCriteria;
  preferredLearning: SfTrackCriteria;
  preferredTranslate: SfTrackCriteria;

  updatedAt: number;
};

const SF_DEFAULT_PREFS: SfGlobalPrefs = {
  version: 2,
  dictationEnabled: false,

  preferredAudio: { bcp47: null, trackType: null, rawTrackType: null },
  // If user has no prefs, default to English for both subtitle/translate (best-effort)
  preferredLearning: { bcp47: "en", trackType: null, rawTrackType: null },
  preferredTranslate: { bcp47: "en", trackType: null, rawTrackType: null },

  updatedAt: Date.now(),
};

// Legacy v1 shape (for migration only)
type SfGlobalPrefsV1 = {
  version: 1;
  dictationEnabled: boolean;
  preferredAudioTrack: AudioTrack | null;
  preferredLearningTrack: TimedTextTrack | null;
  preferredTranslateTrack: TimedTextTrack | null;
  preferredAudioBcp47: string | null;
  preferredLearningBcp47: string | null;
  preferredTranslateBcp47: string | null;
  updatedAt: number;
};

function sfStorageGet<T>(key: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(key, (items) => resolve(items?.[key] as T | undefined));
    } catch {
      resolve(undefined);
    }
  });
}

function sfStorageSet<T>(key: string, value: T): Promise<void> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [key]: value }, () => resolve());
    } catch {
      resolve();
    }
  });
}

const norm = (s: any) => String(s ?? "").toLowerCase();
const primary = (s: string) => norm(s).split("-")[0];

function toCriteriaFromTrack(track: any | null | undefined): SfTrackCriteria {
  if (!track) return { bcp47: null, trackType: null, rawTrackType: null };
  return {
    bcp47: track?.bcp47 != null ? norm(track.bcp47) : null,
    trackType: track?.trackType != null ? String(track.trackType) : null,
    rawTrackType: (track as any)?.rawTrackType != null ? String((track as any).rawTrackType) : null,
  };
}

function migrateV1ToV2(v1: SfGlobalPrefsV1): SfGlobalPrefs {
  // Prefer explicit tracks if present; otherwise use legacy bcp47 fields.
  const audioC = v1.preferredAudioTrack ? toCriteriaFromTrack(v1.preferredAudioTrack) : { ...toCriteriaFromTrack(null), bcp47: v1.preferredAudioBcp47 ? norm(v1.preferredAudioBcp47) : null };
  const learnC = v1.preferredLearningTrack ? toCriteriaFromTrack(v1.preferredLearningTrack) : { ...toCriteriaFromTrack(null), bcp47: v1.preferredLearningBcp47 ? norm(v1.preferredLearningBcp47) : "en" };
  const tranC = v1.preferredTranslateTrack ? toCriteriaFromTrack(v1.preferredTranslateTrack) : { ...toCriteriaFromTrack(null), bcp47: v1.preferredTranslateBcp47 ? norm(v1.preferredTranslateBcp47) : "en" };

  return {
    version: 2,
    dictationEnabled: !!v1.dictationEnabled,
    preferredAudio: { ...audioC },
    preferredLearning: { ...learnC },
    preferredTranslate: { ...tranC },
    updatedAt: Date.now(),
  };
}

async function loadSfPrefs(): Promise<SfGlobalPrefs> {
  const v2 = await sfStorageGet<SfGlobalPrefs>(SF_SETTINGS_KEY);
  if (v2 && typeof v2 === "object" && (v2 as any).version === 2) {
    return { ...SF_DEFAULT_PREFS, ...v2, version: 2 };
  }

  // Try migrate from v1 key (if it existed)
  const v1 = await sfStorageGet<SfGlobalPrefsV1>("sf_settings_v1");
  if (v1 && typeof v1 === "object" && (v1 as any).version === 1) {
    const migrated = migrateV1ToV2(v1);
    await sfStorageSet<SfGlobalPrefs>(SF_SETTINGS_KEY, migrated);
    return migrated;
  }

  return { ...SF_DEFAULT_PREFS, updatedAt: Date.now() };
}

async function saveSfPrefs(patch: Partial<SfGlobalPrefs>): Promise<SfGlobalPrefs> {
  const prev = await loadSfPrefs();
  const next: SfGlobalPrefs = { ...prev, ...patch, version: 2, updatedAt: Date.now() };
  await sfStorageSet<SfGlobalPrefs>(SF_SETTINGS_KEY, next);
  return next;
}

// ===== bcp47 <-> trackId (re-map by criteria) =====
function getAudioTrackByTrackId(trackId: string): AudioTrack | null {
  if (!trackId) return null;
  return (sfAvailableAudioLangs || []).find((x: any) => String(x?.trackId || "") === trackId) || null;
}

function getTimedTextTrackByTrackId(trackId: string): TimedTextTrack | null {
  if (!trackId) return null;
  return (sfAvailableSubtitleLangs || []).find((x: any) => String(x?.trackId || "") === trackId) || null;
}

function pickAudioTrackIdByCriteria(pref: SfTrackCriteria | null | undefined): string {
  const list = sfAvailableAudioLangs || [];
  if (!list.length) return sfSettingAudioLang;
  const wantedB = pref?.bcp47 ? norm(pref.bcp47) : "";
  const wantedPrimary = wantedB ? primary(wantedB) : "";

  const matchesType = (x: any) => {
    if (pref?.trackType && String(x?.trackType || "") !== String(pref.trackType)) return false;
    if (pref?.rawTrackType && String(x?.rawTrackType || "") !== String(pref.rawTrackType)) return false;
    return true;
  };

  // 1) exact + type
  let t = wantedB ? list.find((x: any) => norm(x?.bcp47) === wantedB && matchesType(x)) : null;
  if (t?.trackId) return String(t.trackId);

  // 2) exact
  t = wantedB ? list.find((x: any) => norm(x?.bcp47) === wantedB) : null;
  if (t?.trackId) return String(t.trackId);

  // 3) primary + type
  t = wantedPrimary
    ? list.find((x: any) => {
        const b = norm(x?.bcp47);
        return b && primary(b) === wantedPrimary && matchesType(x);
      })
    : null;
  if (t?.trackId) return String(t.trackId);

  // 4) primary
  t = wantedPrimary
    ? list.find((x: any) => {
        const b = norm(x?.bcp47);
        return b && primary(b) === wantedPrimary;
      })
    : null;
  if (t?.trackId) return String(t.trackId);

  return sfSettingAudioLang || String(list[0]?.trackId || "");
}

function pickTimedTrackIdByCriteria(pref: SfTrackCriteria | null | undefined): string {
  const list = (sfAvailableSubtitleLangs || []).filter((x: any) => !(x as any)?.isNoneTrack);
  if (!list.length) return sfSettingSubtitleLang;

  const wantedB = pref?.bcp47 ? norm(pref.bcp47) : "";
  const wantedPrimary = wantedB ? primary(wantedB) : "";

  const matchesType = (x: any) => {
    if (pref?.trackType && String(x?.trackType || "") !== String(pref.trackType)) return false;
    if (pref?.rawTrackType && String(x?.rawTrackType || "") !== String(pref.rawTrackType)) return false;
    return true;
  };

  // 1) exact + type
  let t = wantedB ? list.find((x: any) => norm(x?.bcp47) === wantedB && matchesType(x)) : null;
  if (t?.trackId) return String(t.trackId);

  // 2) exact
  t = wantedB ? list.find((x: any) => norm(x?.bcp47) === wantedB) : null;
  if (t?.trackId) return String(t.trackId);

  // 3) primary + type
  t = wantedPrimary
    ? list.find((x: any) => {
        const b = norm(x?.bcp47);
        return b && primary(b) === wantedPrimary && matchesType(x);
      })
    : null;
  if (t?.trackId) return String(t.trackId);

  // 4) primary
  t = wantedPrimary
    ? list.find((x: any) => {
        const b = norm(x?.bcp47);
        return b && primary(b) === wantedPrimary;
      })
    : null;
  if (t?.trackId) return String(t.trackId);

  return sfSettingSubtitleLang || String(list[0]?.trackId || "");
}

function pickDefaultAudioTrackId(): string {
  // Prefer PRIMARY + native audio, then any PRIMARY, then first item.
  const list = contentState.audioList || [];
  const a1 = list.find((x: any) => x?.rawTrackType === "PRIMARY" && x?.isNative);
  if (a1?.trackId) return a1.trackId;
  const a2 = list.find((x: any) => x?.rawTrackType === "PRIMARY");
  if (a2?.trackId) return a2.trackId;
  const a3 = list[0];
  return (a3?.trackId as string) || "";
}

function pickDefaultSubtitleTrackId(): string {
  // Prefer first non-NONE subtitle track. If none, fallback to NONE if present.
  const list = contentState.timedTextTrackList || [];
  const s1 = list.find((x: any) => !(x as any)?.isNoneTrack);
  if (s1?.trackId) return s1.trackId;
  const off = list.find((x: any) => (x as any)?.isNoneTrack);
  return (off?.trackId as string) || "";
}

function pickDefaultTranslateTrackId(): string {
  // Default translate follows subtitle default.
  return pickDefaultSubtitleTrackId();
}

function ensureTrackIdDefaultsInitialized() {
  if (!sfSettingAudioLang) sfSettingAudioLang = pickDefaultAudioTrackId();
  if (!sfSettingSubtitleLang) sfSettingSubtitleLang = pickDefaultSubtitleTrackId();
  if (!sfSettingTranslateLang) sfSettingTranslateLang = pickDefaultTranslateTrackId();
}
// ===== Persistent Settings end =====

function ensureSettingsOverlay() {
    if (sfSettingsOverlay) return;

    sfSettingsOverlay = document.createElement("div");
    sfSettingsOverlay.id = "__sf_settings_overlay";
    sfSettingsOverlay.style.position = "fixed";
    sfSettingsOverlay.style.inset = "0";
    sfSettingsOverlay.style.zIndex = "2147483647";
    sfSettingsOverlay.style.background = "rgba(0,0,0,0.55)";
    (sfSettingsOverlay.style as any).backdropFilter = "blur(6px)";
    sfSettingsOverlay.style.display = "none";
    sfSettingsOverlay.style.alignItems = "center";
    sfSettingsOverlay.style.justifyContent = "center";
    sfSettingsOverlay.style.pointerEvents = "auto";
    sfSettingsOverlay.tabIndex = -1;
    sfSettingsOverlay.setAttribute("role", "dialog");
    sfSettingsOverlay.setAttribute("aria-modal", "true");

    const box = document.createElement("div");
    box.style.width = "min(480px, 92vw)";
    box.style.background =
        "linear-gradient(180deg, rgba(28,28,30,0.98), rgba(18,18,20,0.98))";
    box.style.border = "1px solid rgba(255,255,255,0.10)";
    box.style.borderRadius = "16px";
    box.style.padding = "14px 14px 12px";
    box.style.boxShadow = "0 16px 60px rgba(0,0,0,0.55)";
    box.style.color = "#fff";
    box.style.fontFamily =
        "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";

    const topBar = document.createElement("div");
    topBar.style.display = "flex";
    topBar.style.alignItems = "center";
    topBar.style.justifyContent = "space-between";
    topBar.style.gap = "10px";
    topBar.style.marginBottom = "12px";

    const title = document.createElement("div");
    title.textContent = "SubDictate 설정";
    title.style.fontSize = "16px";
    title.style.fontWeight = "750";

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "✕";
    closeBtn.style.width = "36px";
    closeBtn.style.height = "36px";
    closeBtn.style.borderRadius = "10px";
    closeBtn.style.border = "1px solid rgba(255,255,255,0.12)";
    closeBtn.style.background = "rgba(255,255,255,0.08)";
    closeBtn.style.color = "#fff";
    closeBtn.style.cursor = "pointer";
    closeBtn.style.fontSize = "14px";
    closeBtn.style.lineHeight = "1";
    closeBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideSettingsOverlay();
    });

    topBar.appendChild(title);
    topBar.appendChild(closeBtn);

    const desc = document.createElement("div");
    desc.style.fontSize = "13px";
    desc.style.opacity = "0.78";
    desc.style.marginBottom = "10px";

    const sectionWrap = document.createElement("div");
    sectionWrap.style.display = "grid";
    sectionWrap.style.gap = "12px";

    const fillOptions = (sel: HTMLSelectElement, opts: any[], cur: string) => {
        sel.innerHTML = "";
        for (const o of opts) {
            const opt = document.createElement("option");
            opt.value = o.trackId;
            opt.textContent = o.displayName;
            sel.appendChild(opt);
        }
        // Selection: prefer `cur` if exists; else fall back to first.
        const hasCur = !!opts.find((x: any) => x?.trackId === cur);
        sel.value = hasCur ? cur : ((opts[0]?.trackId as string) || "");
    };

    const makeRow = (label: string, bodyEl: HTMLElement) => {
        const row = document.createElement("div");
        row.style.display = "grid";
        row.style.gridTemplateColumns = "1fr";
        row.style.gap = "6px";
        row.style.padding = "12px";
        row.style.borderRadius = "14px";
        row.style.border = "1px solid rgba(255,255,255,0.10)";
        row.style.background = "rgba(255,255,255,0.06)";

        const head = document.createElement("div");
        head.style.display = "flex";
        head.style.alignItems = "baseline";
        head.style.justifyContent = "space-between";
        head.style.gap = "10px";

        const t = document.createElement("div");
        t.textContent = label;
        t.style.fontSize = "14px";
        t.style.fontWeight = "750";


        head.appendChild(t);

        // If the row body is a <select>, apply select styling
        if (bodyEl instanceof HTMLSelectElement) {
            bodyEl.style.width = "100%";
            bodyEl.style.padding = "10px 12px";
            bodyEl.style.borderRadius = "12px";
            bodyEl.style.border = "1px solid rgba(255,255,255,0.14)";
            bodyEl.style.background = "rgba(0,0,0,0.30)";
            bodyEl.style.color = "#fff";
            bodyEl.style.fontSize = "14px";
            bodyEl.style.outline = "0";
        }

        row.appendChild(head);
        row.appendChild(bodyEl);
        return row;
    };

    // Dictation ON/OFF toggle (no icons)
    const dictToggleWrap = document.createElement("div");
    dictToggleWrap.style.display = "flex";
    dictToggleWrap.style.alignItems = "center";
    dictToggleWrap.style.justifyContent = "space-between";
    dictToggleWrap.style.gap = "12px";

    const dictToggleLeft = document.createElement("div");
    dictToggleLeft.style.display = "grid";
    dictToggleLeft.style.gap = "2px";

    const dictToggleLabel = document.createElement("div");
    dictToggleLabel.textContent = "ON / OFF";
    dictToggleLabel.style.fontSize = "14px";
    dictToggleLabel.style.fontWeight = "750";
    dictToggleLeft.appendChild(dictToggleLabel);

    const dictToggleRight = document.createElement("button");
    dictToggleRight.type = "button";
    dictToggleRight.style.border = "0";
    dictToggleRight.style.background = "transparent";
    dictToggleRight.style.padding = "0";
    dictToggleRight.style.cursor = "pointer";

    const track = document.createElement("span");
    track.style.width = "46px";
    track.style.height = "26px";
    track.style.borderRadius = "999px";
    track.style.border = "1px solid rgba(255,255,255,0.14)";
    track.style.background = sfSettingDictationEnabled ? "rgba(229,9,20,0.90)" : "rgba(255,255,255,0.14)";
    track.style.position = "relative";
    track.style.display = "inline-block";

    const knob = document.createElement("span");
    knob.style.width = "20px";
    knob.style.height = "20px";
    knob.style.borderRadius = "999px";
    knob.style.background = "rgba(0,0,0,0.55)";
    knob.style.position = "absolute";
    knob.style.top = "2px";
    knob.style.left = sfSettingDictationEnabled ? "24px" : "2px";
    knob.style.transition = "left 120ms ease";

    track.appendChild(knob);
    dictToggleRight.appendChild(track);

    const syncDictToggleVisual = (checked: boolean) => {
        track.style.background = checked ? "rgba(229,9,20,0.90)" : "rgba(255,255,255,0.14)";
        knob.style.left = checked ? "24px" : "2px";
    };

    // Expose sync to showSettingsOverlay()
    sfSyncSettingsDictationToggleVisual = syncDictToggleVisual;

    dictToggleRight.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        sfSettingDictationEnabled = !sfSettingDictationEnabled;
        syncDictToggleVisual(sfSettingDictationEnabled);
    });

    dictToggleWrap.appendChild(dictToggleLeft);
    dictToggleWrap.appendChild(dictToggleRight);

    const audioSel = document.createElement("select");
    sfSettingsAudioSel = audioSel;
    fillOptions(audioSel, sfAvailableAudioLangs, sfSettingAudioLang);
    audioSel.addEventListener("change", () => {
        sfSettingAudioLang = audioSel.value;
    });

    const subSel = document.createElement("select");
    sfSettingsSubtitleSel = subSel;
    fillOptions(subSel, sfAvailableSubtitleLangs, sfSettingSubtitleLang);
    subSel.addEventListener("change", () => {
        sfSettingSubtitleLang = subSel.value;
    });

    const trSel = document.createElement("select");
    sfSettingsTranslateSel = trSel;
    fillOptions(trSel, sfAvailableSubtitleLangs, sfSettingTranslateLang);
    trSel.addEventListener("change", () => {
        sfSettingTranslateLang = trSel.value;
    });

    sectionWrap.appendChild(makeRow("받아쓰기 설정", dictToggleWrap));
    sectionWrap.appendChild(makeRow("오디오 언어 설정", audioSel));
    sectionWrap.appendChild(makeRow("자막 언어 설정",  subSel));
    sectionWrap.appendChild(makeRow("번역 언어 설정", trSel));

    const footer = document.createElement("div");
    footer.style.display = "flex";
    footer.style.justifyContent = "flex-end";
    footer.style.gap = "10px";
    footer.style.marginTop = "14px";

    const applyBtn = document.createElement("button");
    applyBtn.type = "button";
    applyBtn.textContent = "적용";
    applyBtn.style.padding = "10px 14px";
    applyBtn.style.borderRadius = "12px";
    applyBtn.style.border = "1px solid rgba(255,255,255,0.14)";
    applyBtn.style.background = "rgba(255,255,255,0.12)";
    applyBtn.style.color = "#fff";
    applyBtn.style.fontSize = "14px"
    applyBtn.style.cursor = "pointer";
    applyBtn.addEventListener("click", async () => {
        // Apply dictation ON/OFF (즉시 반영)
        toggleDictationMode(sfSettingDictationEnabled);
        
        // Apply audio immediately if changed
        const prevPref = await loadSfPrefs();
        const prevAudio:SfTrackCriteria = prevPref.preferredAudio;
        const sameCriteria = (a?: SfTrackCriteria | null, b?: SfTrackCriteria | null) => {
            return (
                (a?.bcp47 ?? null) === (b?.bcp47 ?? null) &&
                (a?.trackType ?? null) === (b?.trackType ?? null) &&
                (a?.rawTrackType ?? null) === (b?.rawTrackType ?? null)
            );
        };

        // Store only criteria (cross-title stable)
        const audioTrackObj = getAudioTrackByTrackId(sfSettingAudioLang);
        const learningTrackObj = getTimedTextTrackByTrackId(sfSettingSubtitleLang);
        const translateTrackObj = getTimedTextTrackByTrackId(sfSettingTranslateLang);

        const nextAudio: SfTrackCriteria = {
            bcp47: audioTrackObj?.bcp47 ? String(audioTrackObj.bcp47).toLowerCase() : null,
            trackType: audioTrackObj?.trackType ? String(audioTrackObj.trackType) : null,
            rawTrackType: (audioTrackObj as any)?.rawTrackType ? String((audioTrackObj as any).rawTrackType) : null,
        };

        const nextLearning: SfTrackCriteria = {
            bcp47: learningTrackObj?.bcp47 ? String(learningTrackObj.bcp47).toLowerCase() : null,
            trackType: learningTrackObj?.trackType ? String(learningTrackObj.trackType) : null,
            rawTrackType: (learningTrackObj as any)?.rawTrackType ? String((learningTrackObj as any).rawTrackType) : null,
        };

        const nextTranslate: SfTrackCriteria = {
            bcp47: translateTrackObj?.bcp47 ? String(translateTrackObj.bcp47).toLowerCase() : null,
            trackType: translateTrackObj?.trackType ? String(translateTrackObj.trackType) : null,
            rawTrackType: (translateTrackObj as any)?.rawTrackType ? String((translateTrackObj as any).rawTrackType) : null,
        };

        if (nextAudio.bcp47 !== prevAudio.bcp47 || nextAudio.trackType !== prevAudio.trackType || nextAudio.rawTrackType !== prevAudio.rawTrackType) {
            window.postMessage(
                { type: "PLAYER_SetAudio", source: "SubFluent", trackId: sfSettingAudioLang, bcp47: nextAudio.bcp47 },
                "*"
            );
        }

        // Request TTML only when subtitle/translate prefs changed.
        // Use meta/key-based request so we can disambiguate same-bcp47 tracks (e.g., en SUB vs en CC).
        // If selection/meta is missing, default bcp47 to English ("en").
        const learningChanged = !sameCriteria(prevPref.preferredLearning, nextLearning);
        const translateChanged = !sameCriteria(prevPref.preferredTranslate, nextTranslate);

        if (learningChanged || translateChanged) {
            const items: Array<{ subType: "learning" | "translate"; key: string; meta: TimedTextTrackMeta }> = [];
            const movieId = contentState.movieId;
            if(!movieId) return;
            const bucket = contentState.getBucket(movieId);

            if (learningChanged) {
                const learningMeta: TimedTextTrackMeta = {
                    bcp47: (nextLearning.bcp47 || "en").trim().toLowerCase(),
                    trackType: nextLearning.trackType ? String(nextLearning.trackType).trim().toLowerCase() : null,
                    rawTrackType: nextLearning.rawTrackType ? String(nextLearning.rawTrackType).trim().toLowerCase() : null,
                };
                const trackKey = makeTrackKey(learningMeta);
                if(!bucket?.has(trackKey)){
                    items.push({ subType: "learning", key: makeTrackKey(learningMeta), meta: learningMeta });
                }else{
                    try{
                        const cached: any = bucket?.get(trackKey as any);
                        const sub: any = cached?.subtitle;
                        const cues: any[] = Array.isArray(sub?.cues) ? sub.cues : [];
                        if (cues.length > 0) {
                            const merged = mergeCuesByTime(cues as CueLike[]);
                            sfLatestMovieId = movieId;
                            sfLatestLearningMerged = merged;
                        } 
                    } catch (e) {
                        subFluentError("[SubFluent] failed to apply cached translate from bucket:", e);
                    }
                }
            }

            if (translateChanged) {
                const translateMeta: TimedTextTrackMeta = {
                    bcp47: (nextTranslate.bcp47 || "en").trim().toLowerCase(),
                    trackType: nextTranslate.trackType ? String(nextTranslate.trackType).trim().toLowerCase() : null,
                    rawTrackType: nextTranslate.rawTrackType ? String(nextTranslate.rawTrackType).trim().toLowerCase() : null,
                };
                const trackKey = makeTrackKey(translateMeta);
                if(!bucket?.has(trackKey)) {
                    items.push({ subType: "translate", key: makeTrackKey(translateMeta), meta: translateMeta });
                } else {
                    // ✅ bucket에 이미 있으면 요청 스킵 + 즉시 적용(translate만 교체)
                    try {
                        const cached: any = bucket?.get(trackKey as any);
                        const sub: any = cached?.subtitle;
                        const cues: any[] = Array.isArray(sub?.cues) ? sub.cues : [];
                        if (cues.length > 0) {
                            const merged = mergeCuesByTime(cues as CueLike[]);
                            sfLatestMovieId = movieId;
                            sfLatestNativeMerged = merged;
                        } 
                    } catch (e) {
                        subFluentError("[SubFluent] failed to apply cached translate from bucket:", e);
                    }
                }
            }

            if(items.length > 0){
                window.postMessage(
                    {
                        type: "SF_REQUEST_TimedText",
                        source: "SubFluent",
                        items,
                    },
                    "*"
                );

                // // ✅ 일부(예: translate)가 bucket 캐시에 이미 있었으면, 요청 응답 기다리지 말고 즉시 UI 반영
                // if (appliedCached) {
                //     rebuildCueWindowIfReady();
                // }
            }else{
                rebuildCueWindowIfReady();
            }
        }

        await saveSfPrefs({
            dictationEnabled: sfSettingDictationEnabled,
            preferredAudio: nextAudio,
            preferredLearning: nextLearning,
            preferredTranslate: nextTranslate,
        });

        // Update in-memory currentAudio snapshot (best-effort)
        const list = contentState.audioList;
        const track = list.find((t) => String((t as any)?.trackId || "") === String(sfSettingAudioLang || "")) || null;

        contentState.setPlayerReady({
            movieId: contentState.movieId ?? null,
            audioList: contentState.audioList,
            trackList: contentState.timedTextTrackList,
            currentAudio: (track ?? null) as AudioTrack | null,
        });

        hideSettingsOverlay();
    });

    footer.appendChild(applyBtn);

    box.appendChild(topBar);
    box.appendChild(desc);
    box.appendChild(sectionWrap);
    box.appendChild(footer);

    // 밖 클릭 시 닫기
    sfSettingsOverlay.addEventListener("click", (e) => {
        if (e.target === sfSettingsOverlay) {
            e.preventDefault();
            e.stopPropagation();
            hideSettingsOverlay();
        }
    });

    // 내부 클릭은 전파만 막기
    box.addEventListener("click", (e) => e.stopPropagation());

    sfSettingsOverlay.appendChild(box);
    ensureMounted(sfSettingsOverlay);

    // Esc로 닫기
    window.addEventListener(
        "keydown",
        (e) => {
            if (!sfSettingsOpen) return;
            if (e.key !== "Escape") return;
            e.preventDefault();
            e.stopPropagation();
            hideSettingsOverlay();
        },
        true
    );
}

async function showSettingsOverlay() {
  ensureSettingsOverlay();
  if (!sfSettingsOverlay) return;

  const prefs = await loadSfPrefs();

  // dictation 토글(모달 안 스위치)
  sfSettingDictationEnabled = !!prefs.dictationEnabled;
  sfSyncSettingsDictationToggleVisual?.(sfSettingDictationEnabled);

  // bcp47 -> 이번 타이틀의 trackId로 best-effort 매핑
  // If prefs are missing/unmatched, keep derived defaults.
  // Keep defaults derived from current title lists.
  ensureTrackIdDefaultsInitialized();

  // 1) Audio: always prefer CURRENT Netflix audio (what user is actually hearing now)
  const curAudioTrackId = contentState.currentAudio?.trackId as string | undefined;
  if (curAudioTrackId) {
    sfSettingAudioLang = curAudioTrackId;
  }

  // 2) Sub/Translate: prefer current extension selection (learning/native).
  // If current selection is empty or not in this title’s list, fall back to prefs mapping.
  const subFromPrefs = pickTimedTrackIdByCriteria(prefs.preferredLearning);
  const trFromPrefs = pickTimedTrackIdByCriteria(prefs.preferredTranslate);

  const subtitleList = contentState.timedTextTrackList || [];
  const hasSub = !!subtitleList.find((x: any) => x?.trackId === sfSettingSubtitleLang);
  const hasTr = !!subtitleList.find((x: any) => x?.trackId === sfSettingTranslateLang);

  if (!sfSettingSubtitleLang || !hasSub) {
    sfSettingSubtitleLang = subFromPrefs || sfSettingSubtitleLang;
  }
  if (!sfSettingTranslateLang || !hasTr) {
    sfSettingTranslateLang = trFromPrefs || sfSettingTranslateLang;
  }

  // Refresh selects to reflect latest lists + selected values
  refreshSettingsSelects();

  sfSettingsOpen = true;
  sfSettingsOverlay.style.display = "flex";
  remountAllSubFluentUi();
}

function hideSettingsOverlay() {
    if (!sfSettingsOverlay) return;
    sfSettingsOpen = false;
    sfSettingsOverlay.style.display = "none";
    // keep refs (modal is reused), but selection will be refreshed on next open
}
// ===== SubFluent Settings UI end =====

function showDictationOverlay(ls: number, expected: string, native: string, key: string, video: HTMLVideoElement | null) {
    // pause video while dictating
    try {
        video?.pause?.();
    } catch {
        // ignore
    }

    ensureDictationOverlay();
    if (!sfOverlay || !sfInput) return;

    // 동일 클러스터에 대해 중복 호출 방지
    if (sfLastDictationKey === key && sfOverlay.style.display !== "none") return;
    sfLastDictationKey = key;

    sfExpectedStart = ls;
    sfExpectedText = expected;
    sfNativeText = native;
    sfDictationVideo = video;

    // reset UI
    const stateEl = document.getElementById("__sf_state");
    const expectedEl = document.getElementById("__sf_expected");
    const answerEl = document.getElementById("__sf_answer");
    const nativeEl = document.getElementById("__sf_native");

    if (stateEl) stateEl.innerHTML = "";
    if (answerEl) answerEl.innerHTML = "";
    if (expectedEl) {
        expectedEl.innerHTML = "";
        expectedEl.style.display = "none";
    }
    if (nativeEl) nativeEl.textContent = sfNativeText ? `Meaning: ${sfNativeText}` : "";

    sfOverlay.style.display = "flex";
    remountAllSubFluentUi();
    updateSubtitleOverlayVisibility();
    enableDictationFocusGuard();
    setTimeout(() => sfInput?.focus(), 0);
}

function hideDictationOverlay(keepPaused: boolean) {
    window.postMessage({ type: "PLAYER_SEEK", source: "SubFluent" }, "*");

    if (!sfOverlay) return;
    disableDictationFocusGuard();
    sfOverlay.style.display = "none";
    updateSubtitleOverlayVisibility();

    if (!keepPaused) {
        try {
            sfDictationVideo?.play?.();
        } catch {
            // ignore
        }
    }
}

// Create early (SPA-safe)
if (document.body) {
    startPlayerObserver();
} else {
    window.addEventListener("DOMContentLoaded", () => startPlayerObserver(), { once: true });
}


function escapeHtml(s: string) {
    return String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]!));
}


function startCueLogging(subtitleMap: Map<string, CueData>) {
    // stop previous loop
    stopCueLogging?.();

    let running = true;
    let lastVideo: HTMLVideoElement | null = null;
    let lastT = -1;
    let lastLearningKey: string | null = null;

    // Dictation: cue 끝나기 아주 직전에 트리거 (더 늦게 = 끝에 가깝게)
    const DICTATION_LEAD_SEC = 0.05; // 80ms (추천: 0.05~0.15)

    let curStart = 0;
    let curEnd = 0;
    let curKey: string | null = null;
    let curLearnText = "";
    let curNativeText = "";
    let lastDictationTriggerKey: string | null = null;

    const clusters = buildClusters(subtitleMap);
    let clusterPtr = 0;

    function buildClusters(subtitleCueMap: Map<string, CueData>): Cluster[] {
        const clusters: Cluster[] = [];

        for (const [key, v] of subtitleCueMap.entries()) {
            clusters.push({ key, ls: v.start, le: v.end, learn: v.learn, native: v.native });
        }

        clusters.sort((x, y) => x.ls - y.ls || x.le - y.le);
        return clusters;
    }

    const normalizeText = (s: string) => s.replace(/\s+/g, " ").trim();

    const shouldSkipDictation = (s: string): boolean => {
        const t = normalizeText(s || "");
        if (!t) return true;

        // Entirely bracketed meta lines like [muffled], [music], (sigh), etc.
        if (/^\[[^\]]+\]$/.test(t)) return true;
        if (/^\([^\)]+\)$/.test(t)) return true;

        // If there is no alphanumeric character at all, treat it as symbols only (e.g., !!!, ---, …)
        if (!/[\p{L}\p{N}]/u.test(t)) return true;

        return false;
    };

    const tick = () => {
        //if(isWatchPage() === false) return;
        if (!running) return;

        const video = getVideoEl();
        if (!video) {
            requestAnimationFrame(tick);
            return;
        }

        // video element swapped? reset indices/pointers so we log immediately
        if (lastVideo !== video) {
            lastVideo = video;
            lastLearningKey = null;
            clusterPtr = 0;
            lastT = -1;

            curStart = 0;
            curEnd = 0;
            curKey = null;
            curLearnText = "";
            curNativeText = "";
            lastDictationTriggerKey = null;
        }

        const t = video.currentTime;

        // seek/backward jump 방어
        if (lastT >= 0 && t < lastT - 0.5) {
            clusterPtr = 0;
            lastLearningKey = null;

            curStart = 0;
            curEnd = 0;
            curKey = null;
            curLearnText = "";
            curNativeText = "";
            lastDictationTriggerKey = null;
        }
        lastT = t;

        while (clusterPtr < clusters.length) {
            const c = clusters[clusterPtr];

            // 아직 해당 클러스터 시작 전이면 대기
            if (t < c.ls) break;

            // 이미 끝난 클러스터면 다음으로
            if (t >= c.le) {
                clusterPtr++;
                continue;
            }

            // 현재 클러스터 구간 진입: c.ls <= t < c.le
            if (lastLearningKey !== c.key) {
                lastLearningKey = c.key;

                const learnText = normalizeText(c.learn.join(" "));
                const nativeText = normalizeText(c.native.join(" "));

                // cache current cue for end-of-cue dictation trigger
                curStart = c.ls;
                curEnd = c.le;
                curKey = c.key;

                curLearnText = learnText;
                curNativeText = nativeText;

                setSubtitleText(learnText, nativeText);
                updateSubtitleOverlayVisibility();
            }

            // Dictation trigger: 현재 cue 끝나기 직전(한 번만) — 매 tick에서 체크
            if (sfDictationMode && curKey && lastDictationTriggerKey !== curKey) {
                if (t >= curEnd - DICTATION_LEAD_SEC) {
                    // mark as handled once per cue
                    lastDictationTriggerKey = curKey;

                    // Skip dictation for meta/symbol-only cues like [~~~], (~~~), !!!
                    if (!shouldSkipDictation(curLearnText)) {
                        showDictationOverlay(curStart, curLearnText, curNativeText, curKey, video);
                    }
                }
            }

            break; // 한 tick에 하나만 처리
        }

        requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);

    stopCueLogging = () => {
        running = false;
        hideDictationOverlay(false);
        sfLastDictationKey = null;
        clearSubtitleText();
        updateSubtitleOverlayVisibility();
    };
}

function collapseCueMapToSentenceMap(
    subtitleCueMap: Map<string, CueData>,
    opts?: { gapSec?: number }
): Map<string, CueData> {
    const gapSec = opts?.gapSec ?? 0.8;

    const entries = Array.from(subtitleCueMap.entries())
        .map(([key, v]) => ({ key, v }))
        .sort((a, b) => a.v.start - b.v.start || a.v.end - b.v.end);

    const norm = (s: string) => (s || "").replace(/\s+/g, " ").trim();
    const endsSentence = (t: string) => /[.!?]["')\]]*$/.test(norm(t));
    const isMetaLine = (t: string) => {
        const s = norm(t);
        if (!s) return false;
        if (/^\[[^\]]+\]$/.test(s)) return true;
        if (/^\([^\)]+\)$/.test(s)) return true;
        if (s.includes("♪") || s.includes("♫")) return true;
        return false;
    };

    const dedupeKeepOrder = (arr: string[]) => {
        const seen = new Set<string>();
        const out: string[] = [];
        for (const x of arr) {
            const t = norm(x);
            if (!t) continue;
            if (seen.has(t)) continue;
            seen.add(t);
            out.push(t);
        }
        return out;
    };

    const out = new Map<string, CueData>();

    let bufStart = 0;
    let bufEnd = 0;
    let bufLearn: string[] = [];
    let bufNative: string[] = [];
    let bufHasAny = false;

    const flush = (idx: number) => {
        if (!bufHasAny) return;
        out.set(`SENT_${idx}`, {
            start: bufStart,
            end: bufEnd,
            learn: dedupeKeepOrder(bufLearn),
            native: dedupeKeepOrder(bufNative),
        });
        bufHasAny = false;
        bufLearn = [];
        bufNative = [];
    };

    let sentIdx = 0;

    for (let i = 0; i < entries.length; i++) {
        const cur = entries[i].v;
        const next = entries[i + 1]?.v;

        const curLearnText = norm(cur.learn.join(" "));

        // meta lines: keep standalone (don’t attach to dialogue)
        if (isMetaLine(curLearnText)) {
            flush(sentIdx++);
            out.set(`SENT_${sentIdx++}`, {
                start: cur.start,
                end: cur.end,
                learn: dedupeKeepOrder(cur.learn),
                native: dedupeKeepOrder(cur.native),
            });
            continue;
        }

        if (!bufHasAny) {
            bufHasAny = true;
            bufStart = cur.start;
            bufEnd = cur.end;
        } else {
            bufEnd = Math.max(bufEnd, cur.end);
        }

        bufLearn.push(...cur.learn);
        bufNative.push(...cur.native);

        const gapToNext = next ? (next.start - cur.end) : Number.POSITIVE_INFINITY;
        const shouldBreakByPunct = endsSentence(curLearnText);
        const shouldBreakByGap = gapToNext >= gapSec;

        if (shouldBreakByPunct || shouldBreakByGap) {
            flush(sentIdx++);
        }
    }

    flush(sentIdx++);
    return out;
}

function generateWindow(movieId: string, learningCuesRaw: CueLike[], nativeCuesRaw: CueLike[], callback: Function) {
    const EPS = 0.020;
    const RATIO_MIN = 0.38;

    const normalizeText = (s: string) => s.replace(/\s+/g, " ").trim();

    const learningCues = learningCuesRaw.map(c => ({ ...c }));
    const nativeCues = nativeCuesRaw.map(c => ({ ...c }));
    const subtitleCueMap = new Map<string, CueData>();

    for (let i = 0; i < learningCues.length; i++) {
        const learningCue = learningCues[i];

        const ls = learningCue.start;
        const le = learningCue.end;

        const key = movieId + "_#" + i;

        if (!subtitleCueMap.has(key)) {
            subtitleCueMap.set(key, { start: ls, end: le, learn: [learningCue.text], native: [] });
        } else {
            subtitleCueMap.get(key)?.learn.push(learningCue.text);
            continue;
        }

        for (let j = 0; j < nativeCues.length; j++) {
            const nativeCue = nativeCues[j];
            const ns = nativeCue.start;
            const ne = nativeCue.end;

            if (ns >= le) break;
            if (ne <= ls) continue;

            const overlapStart = Math.max(ns, ls);
            const overlapEnd = Math.min(ne, le);
            let overlap = overlapEnd - overlapStart;

            if (overlap > 0) {
                const lDuration = Math.max(le - ls, 1e-16);
                const nDuration = Math.max(ne - ns, 1e-6);
                const lRatio = overlap / lDuration;
                const nRatio = overlap / nDuration;

                if (lRatio <= RATIO_MIN && nRatio <= RATIO_MIN) continue;

                if (lRatio >= RATIO_MIN || nRatio >= RATIO_MIN) {
                    subtitleCueMap.get(key)?.native.push(nativeCue.text);
                }
            } else {
                // C) "거의 맞닿은" 케이스(경계만 살짝 어긋남) 허용
                // 예: n.end 가 Ls 근처거나 n.start 가 Le 근처인 경우
                const nearBoundary = Math.abs(ne - ls) <= EPS || Math.abs(ns - le) <= EPS;

                if (nearBoundary) {
                    // 경계만 닿는 애들은 텍스트가 짧은 효과음/전환일 수도 있으니
                    // 최소 길이 필터를 넣고 싶으면 여기서 처리해도 됨
                    const text = normalizeText(nativeCue.text || "") + " || nearBoundary";
                    if (text.length > 0) {
                        subtitleCueMap.get(key)?.native.push(text);
                        nativeCues.splice(j, 1);
                    }
                }
            }
        }
    }
    const mapToUse = sfDictationMode ? collapseCueMapToSentenceMap(subtitleCueMap, { gapSec: 0.8 }) : subtitleCueMap;
    callback(mapToUse);
}

// Stop logging when movie changes or page unloads
contentState.subscribeMovieId((next) => {
    // movieId가 바뀌면 이전 루프는 중단
    if (!next) {
        stopCueLogging?.();
        stopCueLogging = null;
    }
});


// NOTE: Netflix is SPA; `beforeunload` may not fire on back/route changes.
// We keep a lightweight fallback for real unloads only.
window.addEventListener("pagehide", () => {
    stopCueLogging?.();
    stopCueLogging = null;

    stopPlayerObserver();
});

function mergeCuesByTime(cues: CueLike[]): CueLike[] {
    if (cues.length === 0) return [];

    // 1) 시간순 정렬 (start -> end). 원본 순서를 마지막 tie-break로 유지하기 위해 idx를 붙임
    const sorted = cues
        .map((c, idx) => ({ c: { ...c }, idx }))
        .sort((a, b) => (a.c.start - b.c.start) || (a.c.end - b.c.end) || (a.idx - b.idx));

    const merged: CueLike[] = [];

    let group: Array<{ c: CueLike; idx: number }> = [sorted[0]];

    const flush = () => {
        // 2) 동일 start/end 그룹 내부 정렬: 위(y 작은) -> 왼쪽(x 작은) -> 원래 순서(idx)
        group.sort((a, b) => {
            const ay = a.c.regionY ?? Number.POSITIVE_INFINITY;
            const by = b.c.regionY ?? Number.POSITIVE_INFINITY;
            if (ay !== by) return ay - by;

            const ax = a.c.regionX ?? Number.POSITIVE_INFINITY;
            const bx = b.c.regionX ?? Number.POSITIVE_INFINITY;
            if (ax !== bx) return ax - bx;

            return a.idx - b.idx;
        });

        const head = group[0].c;
        const text = group
            .map(x => x.c.text)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();

        merged.push({
            start: head.start,
            end: head.end,
            text,
            regionX: head.regionX,
            regionY: head.regionY,
        });
    };

    for (let i = 1; i < sorted.length; i++) {
        const cur = sorted[i];
        const prev = group[group.length - 1];

        if (cur.c.start === prev.c.start && cur.c.end === prev.c.end) {
            group.push(cur);
        } else {
            flush();
            group = [cur];
        }
    }

    flush();
    return merged;
}

// When both subtitles ready, start time-based cue logging
contentState.subscribeSubtitlesReady(({ movieId, bucket }) => {
    // bucket: Record<trackKey, StoredTimedText>
    const entries: StoredTimedText[] = bucket ? (Object.values(bucket as any) as StoredTimedText[]) : [];

    // Desired mapping (settings):
    // - subtitleLang = learning
    // - translateLang = native
    const learningTrackObj = getTimedTextTrackByTrackId(sfSettingSubtitleLang);
    const nativeTrackObj = getTimedTextTrackByTrackId(sfSettingTranslateLang);

    const toMeta = (t: any | null): TimedTextTrackMeta | null => {
        if (!t) return null;
        return {
            bcp47: t?.bcp47 != null ? String(t.bcp47).toLowerCase() : null,
            trackType: t?.trackType != null ? String(t.trackType) : null,
            rawTrackType: (t as any)?.rawTrackType != null ? String((t as any).rawTrackType) : null,
        };
    };

    const learningMeta = toMeta(learningTrackObj);
    const nativeMeta = toMeta(nativeTrackObj);

    const norm = (v: any) => String(v ?? "").trim().toLowerCase();

    const metaMatches = (cand: TimedTextTrackMeta, want: TimedTextTrackMeta): boolean => {
        // Want가 가진 필드만 비교(unknown/null은 무시)
        if (want.bcp47 && norm(cand.bcp47) !== norm(want.bcp47)) return false;
        if (want.trackType && String(cand.trackType || "") !== String(want.trackType)) return false;
        if (want.rawTrackType && String(cand.rawTrackType || "") !== String(want.rawTrackType)) return false;
        return true;
    };

    const findByMeta = (want: TimedTextTrackMeta | null): StoredTimedText | undefined => {
        if (!want) return undefined;

        // 1) key로 직접 매칭(가능하면)
        try {
            const k = makeTrackKey(want);
            const direct = (bucket as any)?.[k] as StoredTimedText | undefined;
            if (direct?.subtitle) return direct;
        } catch {
            // ignore
        }

        // 2) meta 필드로 스캔 매칭 (bcp47 + (trackType/rawTrackType) 우선)
        return entries.find((it) => it?.meta && metaMatches(it.meta, want));
    };

    let learningStored = findByMeta(learningMeta);
    let nativeStored = findByMeta(nativeMeta);

    // Fallback: pick first two available entries if settings don't match this title
    if (!learningStored || !nativeStored) {
        const e1 = entries[0];
        const e2 = entries[1];
        if (!learningStored && e1) learningStored = e1;
        if (!nativeStored && e2) nativeStored = e2;
    }

    const learningSub = learningStored?.subtitle as any;
    const nativeSub = nativeStored?.subtitle as any;

    if (!learningSub || !nativeSub) return;

    const next = contentState.nextMovieId;
    if (next === movieId) {
        contentState.setMovieId(movieId);
    }

    const nativeCues = mergeCuesByTime((nativeSub.cues ?? []) as CueLike[]);
    const learningCues = mergeCuesByTime((learningSub.cues ?? []) as CueLike[]);

    // cache for mode-switch rebuild
    sfLatestMovieId = movieId;
    sfLatestLearningMerged = learningCues;
    sfLatestNativeMerged = nativeCues;

    rebuildCueWindowIfReady();
});

// --- TTML URL capture via page hook (pageScript) ---
const PAGE_HOOK_SOURCE = "SubFluent";

// Listen for messages from the injected page hook
window.addEventListener("message", async (ev) => {
    const d = ev.data;
    if (d?.source !== PAGE_HOOK_SOURCE) return;

    if (d?.type === "PLAYER_READY") {
        const incomingMovieId = ev.data?.movieId != null ? String(ev.data.movieId) : null;
        const prevMovieId = contentState.movieId != null ? String(contentState.movieId) : null;

        if (incomingMovieId && incomingMovieId !== prevMovieId) {
            resetSubtitleSessionState(`PLAYER_READY movie changed: ${prevMovieId ?? "null"} -> ${incomingMovieId}`);
        }
        // Save player/track info into contentState (single source of truth)

        contentState.setPlayerReady({
            movieId: d.movieId ?? null,
            audioList: (d.audioList ?? []) as AudioTrack[],
            trackList: (d.trackList ?? []) as TimedTextTrack[],
            currentAudio: (d.currentAudio ?? null) as AudioTrack | null,
        });

        const movieId = d.movieId;
        contentState.setMovieId(movieId);
        startHideNetflixTimedTextObserver();

        // Mirror lists locally for existing mapping/UI code
        sfAvailableSubtitleLangs = contentState.timedTextTrackList;
        sfAvailableAudioLangs = contentState.audioList;

        // Initialize non-hardcoded defaults from current title track lists
        ensureTrackIdDefaultsInitialized();

        // Restore persisted pref
        const prefs = await loadSfPrefs();

        // Restore dictation mode immediately (so UI visibility/icon match on refresh)
        sfDictationMode = !!prefs.dictationEnabled;

        // Also reflect into settings modal state (opened later)
        sfSettingDictationEnabled = sfDictationMode;

        // Restore preferred languages into current title trackIds (best-effort, cross-title via criteria)
        const audioFromPrefs = pickAudioTrackIdByCriteria(prefs.preferredAudio);
        const subFromPrefs = pickTimedTrackIdByCriteria(prefs.preferredLearning);
        const trFromPrefs = pickTimedTrackIdByCriteria(prefs.preferredTranslate);

        if (audioFromPrefs) sfSettingAudioLang = audioFromPrefs;
        if (subFromPrefs) sfSettingSubtitleLang = subFromPrefs;
        if (trFromPrefs) sfSettingTranslateLang = trFromPrefs;

        // Apply UI updates (safe even if buttons not mounted yet)
        updateSubtitleOverlayVisibility();
        updateDictationControlbarIcon();

        // If settings modal is open, keep its selects in sync with latest track lists
        if (sfSettingsOpen) {
            refreshSettingsSelects();
        }

        // If subtitles are already cached, rebuild window to match mode
        rebuildCueWindowIfReady();

        // Build requested timed-text metas using TrackKey (not bcp47-only)
        const toTimedMeta = (t: any | null, fallbackBcp47: string): TimedTextTrackMeta => {
            const b = String(t?.bcp47 ?? fallbackBcp47 ?? "").toLowerCase();
            return {
                bcp47: b || null,
                trackType: t?.trackType != null ? String(t.trackType) : null,
                rawTrackType: (t as any)?.rawTrackType != null ? String((t as any).rawTrackType) : null,
            };
        };

        // Receive prefetch TTML payload (from pageHook)
        try {
            const preRaw = (d as any)?.prefetchTimedText;
            const preItems = Array.isArray(preRaw) ? preRaw : preRaw ? [preRaw] : [];
            if (preItems.length > 0) {
                // Feed prefetched TTML into contentState immediately (so bucket has initial subtitles)
                for (const it of preItems) {
                    try {
                        const ttml = String((it as any)?.ttml || "");
                        const meta = (it as any)?.meta as TimedTextTrackMeta | undefined;
                        if (!ttml || !meta) continue;

                        const ttmlSubtitle = parseTtmlSubtitle(ttml);
                        contentState.setSubtitleForMovie(movieId, meta, ttmlSubtitle);
                    } catch (e) {
                        subFluentError("[SubFluent] prefetch item parse/store failed:", e);
                    }
                }
            }
        } catch (e) {
            subFluentError("[SubFluent] PLAYER_READY prefetchTimedText parse failed:", e);
        }

        // Prefer the current title's selected trackIds (most accurate), otherwise fall back to stored prefs.
        const learningTrackObj = getTimedTextTrackByTrackId(sfSettingSubtitleLang);
        const translateTrackObj = getTimedTextTrackByTrackId(sfSettingTranslateLang);

        const learningMeta: TimedTextTrackMeta = learningTrackObj
            ? toTimedMeta(learningTrackObj as any, "en")
            : {
                bcp47: prefs.preferredLearning?.bcp47 ? String(prefs.preferredLearning.bcp47).toLowerCase() : "en",
                trackType: prefs.preferredLearning?.trackType != null ? String(prefs.preferredLearning.trackType) : null,
                rawTrackType: prefs.preferredLearning?.rawTrackType != null ? String(prefs.preferredLearning.rawTrackType) : null,
            };

        const translateMeta: TimedTextTrackMeta = translateTrackObj
            ? toTimedMeta(translateTrackObj as any, "ko")
            : {
                bcp47: prefs.preferredTranslate?.bcp47 ? String(prefs.preferredTranslate.bcp47).toLowerCase() : "en",
                trackType: prefs.preferredTranslate?.trackType != null ? String(prefs.preferredTranslate.trackType) : null,
                rawTrackType: prefs.preferredTranslate?.rawTrackType != null ? String(prefs.preferredTranslate.rawTrackType) : null,
            };

        const learningKey = makeTrackKey(learningMeta);
        const translateKey = makeTrackKey(translateMeta);

        if (contentState.getSubtitlesState(d.movieId) === "waiting0" || contentState.getSubtitlesState(d.movieId) === "waiting1") {
            const items:Array<{subType:"learning"| "translate",key:string,meta:TimedTextTrackMeta}> = [];
            const bucket = contentState.getBucket(movieId);

            if(!bucket?.has(learningKey)){
                items.push({subType:"learning",key:learningKey,meta:learningMeta});
            }else {
                try{
                    const cached: any = bucket?.get(learningKey as any);
                    const sub: any = cached?.subtitle;
                    const cues: any[] = Array.isArray(sub?.cues) ? sub.cues : [];
                    if (cues.length > 0) {
                        const merged = mergeCuesByTime(cues as CueLike[]);
                        sfLatestMovieId = movieId;
                        sfLatestLearningMerged = merged;
                    }
                } catch (e) {
                    subFluentError("[SubFluent] failed to apply cached translate from bucket:", e);
                }
            }
            
            if(!bucket?.has(translateKey)){
                items.push({subType:"translate",key:translateKey,meta:translateMeta});
            }else {
                try{
                    const cached: any = bucket?.get(translateKey as any);
                    const sub: any = cached?.subtitle;
                    const cues: any[] = Array.isArray(sub?.cues) ? sub.cues : [];
                    if (cues.length > 0) {
                        const merged = mergeCuesByTime(cues as CueLike[]);
                        sfLatestMovieId = movieId;
                        sfLatestNativeMerged = merged;
                    }
                } catch (e) {
                    subFluentError("[SubFluent] failed to apply cached translate from bucket:", e);
                }
            }

            window.postMessage(
                {
                    type: "SF_REQUEST_TimedText",
                    source: "SubFluent",
                    items: items,
                },
                "*"
            );
        }
    }

    if (d?.type === "TTML_TEXT") {
        const movieId = d.movieId as string;
        const trackMeta = d.trackMeta
        const raw = d.ttml as string;

        // parse first so we can preview in logs
        const ttmlSubtitle = parseTtmlSubtitle(raw);
        contentState.setSubtitleForMovie(movieId, trackMeta, ttmlSubtitle);
        return;
    }
});

// --- Netflix native subtitle layer toggle (do NOT remove, just hide) ---
function setNetflixTimedTextVisible(visible: boolean) {
    const el = document.querySelector('div.player-timedtext') as HTMLElement | null;
    if (!el) return;

    // store original display once
    const ds = el.dataset as any;
    if (ds.sfOrigDisplay == null) {
        ds.sfOrigDisplay = el.style.display || "";
    }

    if (visible) {
        el.style.display = ds.sfOrigDisplay || "";
        el.removeAttribute("aria-hidden");
    } else {
        el.style.display = "none";
        el.setAttribute("aria-hidden", "true");
    }
}

function hideNetflixTimedText() {
    setNetflixTimedTextVisible(false);
}
let sfHideNfTimedTextObserver: MutationObserver | null = null;

function startHideNetflixTimedTextObserver() {
  if (sfHideNfTimedTextObserver) return;

  // 1) 즉시 1회 숨김
  hideNetflixTimedText();

  // 2) Netflix SPA 리렌더로 자막 레이어가 재생성되므로 계속 숨김 유지
  sfHideNfTimedTextObserver = new MutationObserver(() => {
    hideNetflixTimedText();
  });

  const root = document.documentElement || document.body;
  sfHideNfTimedTextObserver.observe(root, { childList: true, subtree: true });
}

function stopHideNetflixTimedTextObserver() {
  if (!sfHideNfTimedTextObserver) return;
  sfHideNfTimedTextObserver.disconnect();
  sfHideNfTimedTextObserver = null;
}

function getPlayerEl(): HTMLElement | null {
    return document.querySelector('div[data-uia="player"]') as HTMLElement | null;
}

// --- Flag-container watcher utilities ---
let lastPlayerEl: HTMLElement | null = null;
let stopWatchFlagContainer: (() => void) | null = null;
let rootPlayerObserver: MutationObserver | null = null;

// Cleanup when player is removed/replaced (SPA route/back)
function cleanupOnPlayerRemoved() {
    try {
        // stop cue loop + hide overlays
        stopCueLogging?.();
        stopCueLogging = null;

        hideDictationOverlay(false);
        sfLastDictationKey = null;
        clearSubtitleText();
        updateSubtitleOverlayVisibility();

        // unmount controlbar watchers
        stopWatchFlagContainer?.();
        stopWatchFlagContainer = null;

        // clear mount marker so next player re-mount works
        lastPlayerEl = null;
        stopHideNetflixTimedTextObserver();
    } catch {
        // ignore
    }
}


function getFlagContainer(root: ParentNode = document): HTMLElement | null {
    return root.querySelector(".watch-video--flag-container") as HTMLElement | null;
}

function getFlagContainerForAudioSubtitleButton(): HTMLButtonElement | null {
    const btn = document.querySelector('button[data-uia="control-audio-subtitle"]') as HTMLButtonElement | null;
    return btn || null;
}

// --- Controlbar button handlers (reusable) ---
function toggleDictationMode(next?: boolean) {
    const willEnable = typeof next === "boolean" ? next : !sfDictationMode;
    if (willEnable === sfDictationMode) return;

    sfDictationMode = willEnable;

    if (!sfDictationMode) {
        // 끌 때는 overlay 숨기고 재생 재개
        hideDictationOverlay(false);
        sfLastDictationKey = null;
    } else {
        // 켤 때는 자막 UI 비활성화(숨김) + 텍스트도 비워둠(선택)
        hideNetflixTimedText();
        clearSubtitleText();
    }

    rebuildCueWindowIfReady();
    updateSubtitleOverlayVisibility();
    updateDictationControlbarIcon();
    void saveSfPrefs({ dictationEnabled: sfDictationMode });
}

function onDictationControlbarClick(ev: MouseEvent) {
    ev.preventDefault();
    ev.stopPropagation();

    toggleDictationMode();
}

function onSettingsControlbarClick(ev: MouseEvent) {
    ev.preventDefault();
    ev.stopPropagation();
    void showSettingsOverlay();
}

// --- Dictation button icon swap (CC <-> Dictation) ---
let sfDictationBtnSvg: SVGSVGElement | null = null;
let sfDictationBtnPath: SVGPathElement | null = null;

const SF_ICON_DICTATION = {
    dataIcon: "SubFluentDictationMedium",
    strokeWidth: "1.8",
    pathD:
        "M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M8 8h9 M8 12h9 M8 16h8 M15 12.8l5-5 1.4 1.4-5 5 M14.4 13.4l1.4 1.4-2.2 3.8-1.8.3.3-1.8z",
} as const;

const SF_ICON_CC = {
    dataIcon: "SubFluentCCMedium",
    strokeWidth: "2",
    pathD:
        "M5 6h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z M10.2 10.4c-1.2-.9-3.2-.2-3.2 1.6s2 2.5 3.2 1.6 M16.0 10.4c-1.2-.9-3.2-.2-3.2 1.6s2 2.5 3.2 1.6",
} as const;

function updateDictationControlbarIcon() {
    if (!sfDictationBtnSvg || !sfDictationBtnPath) return;

    const icon = sfDictationMode ? SF_ICON_CC : SF_ICON_DICTATION;

    sfDictationBtnSvg.setAttribute("data-icon", icon.dataIcon);
    sfDictationBtnSvg.setAttribute("stroke-width", icon.strokeWidth);
    sfDictationBtnPath.setAttribute("d", icon.pathD);
}


// --- Mount buttons into Netflix controlbar container ---
function mountSubFluentControls(flagEl: HTMLElement) {
    const hasDictation = !!flagEl.querySelector('[data-uia="control-subfluent-dictation"]');
    const hasSettings = !!flagEl.querySelector('[data-uia="control-subfluent-settings"]');

    // If already mounted but refs are missing, recover svg/path refs for icon swapping
    if (hasDictation && (!sfDictationBtnSvg || !sfDictationBtnPath)) {
        const btn = flagEl.querySelector('[data-uia="control-subfluent-dictation"]') as HTMLElement | null;
        if (btn) {
            sfDictationBtnSvg = btn.querySelector("svg") as SVGSVGElement | null;
            sfDictationBtnPath = btn.querySelector("svg path") as SVGPathElement | null;
            updateDictationControlbarIcon();
        }
    }

    // Netflix may recreate/empty the flag container during SPA rerenders.
    // Guard against missing structure to avoid crashing the observer.
    const firstWrap = flagEl.children?.[0] as HTMLElement | undefined;
    const firstBtn = (firstWrap?.children?.[0] as HTMLElement | undefined) ?? undefined;
    const firstControl = (firstBtn?.children?.[0] as HTMLElement | undefined) ?? undefined;

    // If Netflix hasn't rendered any control button yet, bail out and let the watcher call us again.
    if (!firstWrap || !firstBtn || !firstControl) {
        return;
    }

    const wrapClass = "nf-medium " + (firstWrap.classList?.value || "");
    const btnClass = "nf-btn " + (firstBtn.classList?.value || "");
    const controlClass = "nf-control " + (firstControl.classList?.value || "");

    // 둘 다 이미 있으면 중복 방지
    if (hasDictation && hasSettings) {
        flagEl.dataset.sfMounted = "1";
        return;
    }

    const svgNS = "http://www.w3.org/2000/svg";

    const createBtn = (opts: {
        ariaLabel: string;
        dataUia: string;
        dataIcon: string;
        strokeWidth: string;
        pathD: string;
        onClick: (ev: MouseEvent) => void;
        useGroup?: boolean;
        groupTransform?: string;
    }) => {
        // <div class="medium nf-medium">
        const wrap = document.createElement("div");
        wrap.className = wrapClass;

        // <button ...>
        const btn = document.createElement("button");
        btn.className = btnClass;
        btn.type = "button";
        btn.setAttribute("aria-label", opts.ariaLabel);
        btn.setAttribute("data-uia", opts.dataUia);

        // ✅ 핸들러 연결 (재사용 가능)
        btn.addEventListener("click", opts.onClick);

        // <div class="control-medium nf-control" role="presentation">
        const control = document.createElement("div");
        control.className = controlClass;
        control.setAttribute("role", "presentation");

        // <svg ...>
        const svg = document.createElementNS(svgNS, "svg");
        svg.setAttribute("class", "nf-icon");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("width", "24");
        svg.setAttribute("height", "24");
        svg.setAttribute("data-icon", opts.dataIcon);
        svg.setAttribute("aria-hidden", "true");
        svg.setAttribute("xmlns", svgNS);
        svg.setAttribute("fill", "none");
        svg.setAttribute("role", "img");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", opts.strokeWidth);
        svg.setAttribute("stroke-linecap", "round");
        svg.setAttribute("stroke-linejoin", "round");

        const path = document.createElementNS(svgNS, "path");
        path.setAttribute("d", opts.pathD);

        if (opts.useGroup) {
            const g = document.createElementNS(svgNS, "g");
            g.setAttribute("transform", opts.groupTransform || "");
            g.appendChild(path);
            svg.appendChild(g);
        } else {
            svg.appendChild(path);
        }

        control.appendChild(svg);
        btn.appendChild(control);
        wrap.appendChild(btn);

        return wrap;
    };

    // 1) 받아쓰기(종이+연필)
    if (!hasDictation) {
        const dictationWrap = createBtn({
            ariaLabel: "SubDictate 받아쓰기",
            dataUia: "control-subfluent-dictation",
            dataIcon: SF_ICON_DICTATION.dataIcon,
            strokeWidth: SF_ICON_DICTATION.strokeWidth,
            pathD: SF_ICON_DICTATION.pathD,
            onClick: onDictationControlbarClick,
        });
        flagEl.appendChild(dictationWrap);

        // capture svg/path refs for icon swapping
        sfDictationBtnSvg = dictationWrap.querySelector("svg") as SVGSVGElement | null;
        sfDictationBtnPath = dictationWrap.querySelector("svg path") as SVGPathElement | null;

        // set correct initial icon based on current mode
        updateDictationControlbarIcon();
    }

    // 2) 설정 (기존 Netflix 자막 버튼 자리에 SubFluent 설정 버튼)
    if (!hasSettings) {
        const origBtn = getFlagContainerForAudioSubtitleButton();
        if (!origBtn) {
            // If not found yet, we'll be called again by the watcher.
            return;
        }

        // Create our button shell using Netflix classes via createBtn
        const settingsWrap = createBtn({
            ariaLabel: "SubDictate 설정",
            dataUia: "control-subfluent-settings",
            // placeholder (will be replaced by cloned Netflix SVG)
            dataIcon: "SubtitlesMedium",
            strokeWidth: "2",
            pathD: "M0 0",
            onClick: onSettingsControlbarClick,
        });

        // Clone Netflix subtitle SVG (fill-based icon) and swap into our button
        const origSvg = origBtn.querySelector("svg") as SVGSVGElement | null;
        if (origSvg) {
            const cloned = origSvg.cloneNode(true) as SVGSVGElement;
            const targetSvg = settingsWrap.querySelector("svg") as SVGSVGElement | null;
            if (targetSvg) {
                targetSvg.replaceWith(cloned);
            }
        }

        // Replace the whole wrapper (div.medium) to preserve layout
        const origWrap = (origBtn.closest("div.medium") as HTMLElement | null) ?? (origBtn.parentElement as HTMLElement | null);
        if (origWrap) {
            origWrap.replaceWith(settingsWrap);
        } else {
            origBtn.replaceWith(settingsWrap);
        }
    }

    // 마커
    flagEl.dataset.sfMounted = "1";
}

// Watch ONLY under the current player element to minimize overhead.
// Calls onChange when the `.watch-video--flag-container` element appears/disappears.
function watchFlagContainerUnderPlayer(playerEl: HTMLElement, onChange: (el: HTMLElement | null) => void) {
    let last: HTMLElement | null = getFlagContainer(playerEl);
    onChange(last);

    const mo = new MutationObserver(() => {
        const cur = getFlagContainer(playerEl);
        if (cur === last) return;
        last = cur;
        onChange(cur);
    });

    mo.observe(playerEl, { childList: true, subtree: true });
    return () => mo.disconnect();
}

function attachPlayerObserver() {
    const playerEl = getPlayerEl();

    // Player removed (SPA route/back)
    if (!playerEl) {
        if (lastPlayerEl) {
            cleanupOnPlayerRemoved();
        }
        return;
    }

    // Same element -> nothing to do
    if (lastPlayerEl === playerEl) return;

    // Player element changed: stop old watcher and attach a new one
    if (lastPlayerEl) {
        cleanupOnPlayerRemoved();
    }

    lastPlayerEl = playerEl;

    stopWatchFlagContainer = watchFlagContainerUnderPlayer(playerEl, (flagEl) => {
        if (!flagEl) {
            return;
        }
        // Avoid double mount
        if (flagEl.dataset.sfMounted === "1") return;

        // Mount on the discovered flag container
        mountSubFluentControls(flagEl);
    });
}

function startPlayerObserver() {
    // Prevent duplicate root observers (SPA re-init safe)
    if (rootPlayerObserver) return;

    // Try attaching immediately (in case the player already exists)
    attachPlayerObserver();

    // Watch for Netflix SPA rerenders that replace the player element
    rootPlayerObserver = new MutationObserver(() => {
        // Re-attach or cleanup depending on current DOM state
        attachPlayerObserver();
    });

    rootPlayerObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
    });
}

function stopPlayerObserver() {
    stopWatchFlagContainer?.();
    stopWatchFlagContainer = null;

    if (rootPlayerObserver) {
        rootPlayerObserver.disconnect();
        rootPlayerObserver = null;
    }

    lastPlayerEl = null;
}