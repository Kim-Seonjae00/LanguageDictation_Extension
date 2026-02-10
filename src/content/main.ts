import { Msg, type DictationResult, type SendDictation, type ExtMessage, type TimedTextTrack, type AudioTrack } from "../shared/protocol";
import { parseTtmlSubtitle } from "../shared/ttmlParser";
import { setSubFluentLogLevel, subFluentDebug, subFluentInfo } from "../shared/util";
import { contentState } from "./state/contentState";

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
    title.textContent = "SubFluent Dictation";
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

let sfSettingAudioLang = "en";
let sfSettingSubtitleLang = "en";
let sfSettingTranslateLang = "ko";

// ===== Persistent Settings (chrome.storage.local) =====
const SF_SETTINGS_KEY = "sf_settings_v1" as const;

type SfGlobalPrefs = {
  version: 1;
  dictationEnabled: boolean;
  preferredAudioBcp47: string | null;
  preferredLearningBcp47: string | null;
  preferredTranslateBcp47: string | null;
  updatedAt: number;
};

const SF_DEFAULT_PREFS: SfGlobalPrefs = {
  version: 1,
  dictationEnabled: false,
  preferredAudioBcp47: null,
  preferredLearningBcp47: null,
  preferredTranslateBcp47: "ko",
  updatedAt: Date.now(),
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

async function loadSfPrefs(): Promise<SfGlobalPrefs> {
  const v = await sfStorageGet<SfGlobalPrefs>(SF_SETTINGS_KEY);
  if (!v || typeof v !== "object") return { ...SF_DEFAULT_PREFS, updatedAt: Date.now() };
  return { ...SF_DEFAULT_PREFS, ...v, version: 1 };
}

async function saveSfPrefs(patch: Partial<SfGlobalPrefs>): Promise<SfGlobalPrefs> {
  const prev = await loadSfPrefs();
  const next: SfGlobalPrefs = { ...prev, ...patch, version: 1, updatedAt: Date.now() };
  subFluentDebug("Saving SF prefs:", next);
  await sfStorageSet<SfGlobalPrefs>(SF_SETTINGS_KEY, next);
  return next;
}

// ===== bcp47 <-> trackId 매핑 =====
function getAudioBcp47ByTrackId(trackId: string): string | null {
  const t = sfAvailableAudioLangs.find((x: any) => x?.trackId === trackId);
  return (t?.bcp47 as string) || null;
}

function getTimedBcp47ByTrackId(trackId: string): string | null {
  const t = sfAvailableSubtitleLangs.find((x: any) => x?.trackId === trackId);
  if ((t as any)?.isNoneTrack) return null; // '끄기'
  return (t?.bcp47 as string) || null;
}

function pickAudioTrackIdByBcp47(bcp47: string | null): string {
  if (!bcp47) return sfSettingAudioLang;
  const t = sfAvailableAudioLangs.find((x: any) => x?.bcp47 === bcp47);
  return (t?.trackId as string) || sfSettingAudioLang;
}

function pickTimedTrackIdByBcp47(bcp47: string | null): string {
  if (!bcp47) {
    const off = sfAvailableSubtitleLangs.find((x: any) => (x as any)?.isNoneTrack);
    return (off?.trackId as string) || sfSettingSubtitleLang;
  }
  const t = sfAvailableSubtitleLangs.find((x: any) => x?.bcp47 === bcp47);
  return (t?.trackId as string) || sfSettingSubtitleLang;
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
    title.textContent = "SubFluent 설정";
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
    desc.textContent =
        "언어 목록은 아직 더미 데이터입니다. (나중에 Netflix에서 실제 언어 리스트를 받아와서 연결)";
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
            if (o.trackId === cur) opt.selected = true;
            sel.appendChild(opt);
        }
    };

    const makeRow = (label: string, help: string, bodyEl: HTMLElement) => {
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

        const h = document.createElement("div");
        h.textContent = help;
        h.style.fontSize = "12px";
        h.style.opacity = "0.72";

        head.appendChild(t);
        head.appendChild(h);

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
        subFluentDebug("[SubFluent] setting dictation enabled:", sfSettingDictationEnabled);
    });

    dictToggleWrap.appendChild(dictToggleLeft);
    dictToggleWrap.appendChild(dictToggleRight);

    const audioSel = document.createElement("select");
    fillOptions(audioSel, sfAvailableAudioLangs, sfSettingAudioLang);
    audioSel.addEventListener("change", () => {
        sfSettingAudioLang = audioSel.value;
        subFluentDebug("[SubFluent] setting audio lang:", sfSettingAudioLang);
    });

    const subSel = document.createElement("select");
    fillOptions(subSel, sfAvailableSubtitleLangs, sfSettingSubtitleLang);
    subSel.addEventListener("change", () => {
        sfSettingSubtitleLang = subSel.value;
        subFluentDebug("[SubFluent] setting subtitle lang:", sfSettingSubtitleLang);
    });

    const trSel = document.createElement("select");
    fillOptions(trSel, sfAvailableSubtitleLangs, sfSettingTranslateLang);
    trSel.addEventListener("change", () => {
        sfSettingTranslateLang = trSel.value;
        subFluentDebug("[SubFluent] setting translate lang:", sfSettingTranslateLang);
    });

    sectionWrap.appendChild(makeRow("받아쓰기 설정", "토글", dictToggleWrap));
    sectionWrap.appendChild(makeRow("오디오 언어 설정", "더미 목록", audioSel));
    sectionWrap.appendChild(makeRow("자막 언어 설정", "더미 목록", subSel));
    sectionWrap.appendChild(makeRow("번역 언어 설정", "더미 목록", trSel));

    const footer = document.createElement("div");
    footer.style.display = "flex";
    footer.style.justifyContent = "flex-end";
    footer.style.gap = "10px";
    footer.style.marginTop = "14px";

    const applyBtn = document.createElement("button");
    applyBtn.type = "button";
    applyBtn.textContent = "적용(더미)";
    applyBtn.style.padding = "10px 14px";
    applyBtn.style.borderRadius = "12px";
    applyBtn.style.border = "1px solid rgba(255,255,255,0.14)";
    applyBtn.style.background = "rgba(255,255,255,0.12)";
    applyBtn.style.color = "#fff";
    applyBtn.style.cursor = "pointer";
    applyBtn.addEventListener("click", async (e) => {
        // Apply dictation ON/OFF (즉시 반영)
        toggleDictationMode(sfSettingDictationEnabled);

        // trackId -> bcp47로 변환해서 저장(타이틀 바뀌어도 유지되게)
        const audioBcp47 = getAudioBcp47ByTrackId(sfSettingAudioLang);
        const learningBcp47 = getTimedBcp47ByTrackId(sfSettingSubtitleLang);
        const translateBcp47 = getTimedBcp47ByTrackId(sfSettingTranslateLang);

        await saveSfPrefs({
        dictationEnabled: sfSettingDictationEnabled,
        preferredAudioBcp47: audioBcp47,
        preferredLearningBcp47: learningBcp47,
        preferredTranslateBcp47: translateBcp47,
        });

        subFluentInfo("[SubFluent] apply settings (saved):", {
        dictationEnabled: sfSettingDictationEnabled,
        audioTrackId: sfSettingAudioLang,
        audioBcp47,
        learningTrackId: sfSettingSubtitleLang,
        learningBcp47,
        translateTrackId: sfSettingTranslateLang,
        translateBcp47,
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
  sfSettingAudioLang = pickAudioTrackIdByBcp47(prefs.preferredAudioBcp47);
  sfSettingSubtitleLang = pickTimedTrackIdByBcp47(prefs.preferredLearningBcp47);
  sfSettingTranslateLang = pickTimedTrackIdByBcp47(prefs.preferredTranslateBcp47);

  sfSettingsOpen = true;
  sfSettingsOverlay.style.display = "flex";
  remountAllSubFluentUi();
}

function hideSettingsOverlay() {
    if (!sfSettingsOverlay) return;
    sfSettingsOpen = false;
    sfSettingsOverlay.style.display = "none";
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


function startCueLogging(movieId: string, subtitleMap: Map<string, CueData>) {
    // stop previous loop
    stopCueLogging?.();
    //subFluentDebug("startCueLogging for movieId:", movieId);

    let running = true;
    let lastVideo: HTMLVideoElement | null = null;
    let lastT = -1;
    let lastLearningKey: string | null = null;

    // Dictation: cue 끝나기 아주 직전에 트리거 (더 늦게 = 끝에 가깝게)
    const DICTATION_LEAD_SEC = 0.25; // 80ms (추천: 0.05~0.15)

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

                subFluentInfo(
                    "L:", learnText,
                    "N:", nativeText
                );

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
        subFluentDebug("stopCueLogging for movieId:", movieId);
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
    callback(movieId, mapToUse);
}

// Stop logging when movie changes or page unloads
contentState.subscribeMovieId((next) => {
    // movieId가 바뀌면 이전 루프는 중단
    if (!next) {
        stopCueLogging?.();
        stopCueLogging = null;
    }
});


window.addEventListener("beforeunload", () => {
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
subFluentDebug("[SubFluent] registering subscribeSubtitlesReady()");
contentState.subscribeSubtitlesReady(({ movieId, bucket }) => {
    subFluentDebug("[SubFluent] subtitles ready for movieId:", movieId, bucket);
    subFluentDebug("[SubFluent] bucket flags:", {
        hasNative: !!bucket?.native,
        hasLearning: !!bucket?.learning,
        nativeCueLen: bucket?.native?.cues?.length ?? -1,
        learningCueLen: bucket?.learning?.cues?.length ?? -1,
    });
    if (!bucket.native || !bucket.learning) return;

    const next = contentState.nextMovieId;
    if (next === movieId) {
        contentState.setMovieId(movieId);
        //contentState.setNextMovieId(null);
    }

    // bucket.native / bucket.learning 의 cues 배열을 사용
    const nativeCues = mergeCuesByTime((bucket.native.cues ?? []) as CueLike[]);
    const learningCues = mergeCuesByTime((bucket.learning.cues ?? []) as CueLike[]);

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
        // Track lists first (needed for bcp47 <-> trackId mapping)
        contentState.setMovieId(d.movieId);
        sfAvailableSubtitleLangs = d.trackList;
        sfAvailableAudioLangs = d.audioList;

        // Restore persisted prefs
        const prefs = await loadSfPrefs();

        // Restore dictation mode immediately (so UI visibility/icon match on refresh)
        sfDictationMode = !!prefs.dictationEnabled;
        subFluentDebug("[SubFluent] restored dictation mode:", sfDictationMode);

        // Also reflect into settings modal state (opened later)
        sfSettingDictationEnabled = sfDictationMode;

        // Restore preferred languages into current title trackIds (best-effort)
        sfSettingAudioLang = pickAudioTrackIdByBcp47(prefs.preferredAudioBcp47);
        sfSettingSubtitleLang = pickTimedTrackIdByBcp47(prefs.preferredLearningBcp47);
        sfSettingTranslateLang = pickTimedTrackIdByBcp47(prefs.preferredTranslateBcp47);

        // Apply UI updates (safe even if buttons not mounted yet)
        updateSubtitleOverlayVisibility();
        updateDictationControlbarIcon();

        // If subtitles are already cached, rebuild window to match mode
        rebuildCueWindowIfReady();

        subFluentDebug("[SubFluent] PLAYER_READY:", {
            movieId: d.movieId,
            trackListLen: d.trackList?.length ?? 0,
            audioListLen: d.audioList?.length ?? 0,
            restored: {
                dictationEnabled: sfDictationMode,
                preferredAudioBcp47: prefs.preferredAudioBcp47,
                preferredLearningBcp47: prefs.preferredLearningBcp47,
                preferredTranslateBcp47: prefs.preferredTranslateBcp47,
            },
        });
    }

    if (d?.type === "TTML_TEXT") {
        const movieId = d.movieId as string;
        const lang = d.langType as string;
        const raw = d.ttml as string;

        subFluentDebug("[SubFluent] TTML_TEXT received:", {
            movieId,
            lang,
            ttmlLen: raw?.length ?? 0,
            currentMovieId: (contentState as any).movieId ?? undefined,
            nextMovieId: (contentState as any).nextMovieId ?? undefined,
        });

        // Robustness: ensure movieId is set so downstream 'ready' computation can complete.
        try {
            contentState.setMovieId(movieId);
        } catch {
            // ignore
        }

        const ttmlSubtitle = parseTtmlSubtitle(raw);
        contentState.setSubtitleForMovie(movieId, lang, ttmlSubtitle);

        subFluentDebug("[SubFluent] setSubtitleForMovie done:", {
            movieId,
            lang,
            state: contentState.getSubtitlesState(movieId),
        });

        return;
    }
});

function getPlayerEl(): HTMLElement | null {
    return document.querySelector('div[data-uia="player"]') as HTMLElement | null;
}

// --- Flag-container watcher utilities ---
let lastPlayerEl: HTMLElement | null = null;
let stopWatchFlagContainer: (() => void) | null = null;
let rootPlayerObserver: MutationObserver | null = null;

function getFlagContainer(root: ParentNode = document): HTMLElement | null {
    return root.querySelector(".watch-video--flag-container") as HTMLElement | null;
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
        clearSubtitleText();
    }

    rebuildCueWindowIfReady();
    updateSubtitleOverlayVisibility();
    updateDictationControlbarIcon();
    void saveSfPrefs({ dictationEnabled: sfDictationMode }).then(() => {
        chrome.storage.local.get("sf_settings_v1", console.log);
    });
}

function onDictationControlbarClick(ev: MouseEvent) {
    ev.preventDefault();
    ev.stopPropagation();

    toggleDictationMode();

    subFluentDebug("[SubFluent] dictation toggled:", sfDictationMode);
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

    const wrapClass = "nf-medium " + (flagEl.children[0]?.classList.value || "");
    const btnClass = "nf-btn " + (flagEl.children[0].children[0]?.classList.value || "");
    const controlClass = "nf-control " + (flagEl.children[0].children[0].children[0]?.classList.value || "");

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
            ariaLabel: "SubFluent 받아쓰기",
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

    // 2) 설정(톱니)
    if (!hasSettings) {
        const settingsWrap = createBtn({
            ariaLabel: "SubFluent 설정",
            dataUia: "control-subfluent-settings",
            dataIcon: "SubFluentSettingsMedium",
            strokeWidth: "2",
            useGroup: true,
            groupTransform: "translate(12 12) scale(0.94) translate(-12 -12)",
            pathD:
                "M15 12a3 3 0 1 1-6 0a3 3 0 1 1 6 0 M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V22a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
            onClick: onSettingsControlbarClick,
        });
        flagEl.appendChild(settingsWrap);
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
    if (!playerEl) return;

    // Same element -> nothing to do
    if (lastPlayerEl === playerEl) return;

    // Player element changed: stop old watcher and attach a new one
    stopWatchFlagContainer?.();
    stopWatchFlagContainer = null;

    lastPlayerEl = playerEl;

    stopWatchFlagContainer = watchFlagContainerUnderPlayer(playerEl, (flagEl) => {
        if (!flagEl) {
            return;
        }
        // Avoid double mount
        if (flagEl.dataset.sfMounted === "1") return;

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

    rootPlayerObserver?.disconnect();
    rootPlayerObserver = null;

    lastPlayerEl = null;
}