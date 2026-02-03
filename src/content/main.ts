import { Msg, type DictationResult, type SendDictation, type ExtMessage } from "../shared/protocol";
import { parseTtmlSubtitle, type Cue } from "../shared/ttmlParser";
import { setSubFluentLogLevel, subFluentDebug, subFluentInfo, subFluentWarn } from "../shared/util";
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

// ===== [SF ADDED] Dictation overlay (v1) =====
let sfDictationMode = false; // default OFF
let sfOverlay: HTMLDivElement | null = null;
let sfInput: HTMLInputElement | null = null;
let sfExpectedText = "";
let sfNativeText = "";
let sfLastDictationKey: string | null = null;

let sfDictationVideo: HTMLVideoElement | null = null;

// ===== [SF ADDED] Dictation focus + keyboard guard =====
let sfFocusGuardOn = false;
let sfFocusGuardTimer: number | null = null;

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

        // Esc는 어디서든 Netflix로 전달 차단 (우리 overlay 닫기)
        if (ev.key === "Escape") {
            ev.preventDefault();
            ev.stopPropagation();
            return;
        }

        // input에 포커스가 없으면 Netflix 단축키/컨트롤을 완전히 차단
        if (!isInputFocused) {
            ev.preventDefault();
            ev.stopPropagation();
            return;
        }

        // input 포커스일 때는 타이핑을 보장하기 위해 기본 전파는 두되,
        // Netflix 쪽에서 keyup/keydown으로 컨트롤을 훔치는 케이스가 있으면 아래 한 줄을 켜서 실험 가능:
        // ev.stopPropagation();
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
// ===== [SF ADDED] end =====

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
    title.style.fontSize = "16px";
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
        hideDictationOverlay(true);
    });

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
    topBar.appendChild(titleWrap);
    topBar.appendChild(closeBtn);

    const hint = document.createElement("div");
    hint.id = "__sf_hint";
    hint.textContent = "Type what you hear. Enter = submit · Esc = close";
    hint.style.fontSize = "13px";
    hint.style.opacity = "0.82";
    hint.style.marginBottom = "12px";

    // native hint line (optional)
    const nativeLine = document.createElement("div");
    nativeLine.id = "__sf_native";
    nativeLine.style.fontSize = "13px";
    nativeLine.style.opacity = "0.78";
    nativeLine.style.marginBottom = "10px";
    nativeLine.style.color = "rgba(255,255,255,0.85)";

    const expected = document.createElement("div");
    expected.id = "__sf_expected";
    expected.style.fontSize = "14px";
    expected.style.opacity = "0.92";
    expected.style.marginBottom = "10px";
    expected.style.display = "none";
    expected.style.padding = "10px 12px";
    expected.style.borderRadius = "12px";
    expected.style.border = "1px solid rgba(255,255,255,0.10)";
    expected.style.background = "rgba(255,255,255,0.06)";

    const result = document.createElement("div");
    result.id = "__sf_result";
    result.style.fontSize = "14px";
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
    sfInput.style.fontSize = "18px";
    sfInput.style.padding = "12px 14px";
    sfInput.style.borderRadius = "12px";
    sfInput.style.border = "1px solid rgba(255,255,255,0.14)";
    sfInput.style.outline = "0";
    sfInput.style.boxSizing = "border-box";
    sfInput.style.background = "rgba(255,255,255,0.08)";
    sfInput.style.color = "#fff";
    sfInput.style.caretColor = "#fff";
    (sfInput.style as any).backdropFilter = "blur(6px)";

    sfInput.addEventListener("keydown", (e) => {
        if (!sfInput) return;

        if (e.key === "Escape") {
            hideDictationOverlay(true);
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

                        // 성공하면 overlay 닫고 재생 재개
                        hideDictationOverlay(false);
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
    document.body.appendChild(sfOverlay);
}

function showDictationOverlay(expected: string, native: string, key: string, video: HTMLVideoElement | null) {
    ensureDictationOverlay();
    if (!sfOverlay || !sfInput) return;

    // 동일 클러스터에 대해 중복 호출 방지
    if (sfLastDictationKey === key && sfOverlay.style.display !== "none") return;
    sfLastDictationKey = key;

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
    if (nativeEl) nativeEl.textContent = sfNativeText ? `Hint (native): ${sfNativeText}` : "";

    // pause video while dictating
    try {
        video?.pause?.();
    } catch {
        // ignore
    }

    sfOverlay.style.display = "flex";
    enableDictationFocusGuard();
    setTimeout(() => sfInput?.focus(), 0);
}

function hideDictationOverlay(keepPaused: boolean) {
    if (!sfOverlay) return;
    disableDictationFocusGuard();
    sfOverlay.style.display = "none";

    if (!keepPaused) {
        try {
            sfDictationVideo?.play?.();
        } catch {
            // ignore
        }
    }
}

// ===== [SF ADDED] Dictation toggle button (bottom-right) =====
let sfToggleBtn: HTMLButtonElement | null = null;

function ensureDictationToggleButton() {
    if (sfToggleBtn) return;

    sfToggleBtn = document.createElement("button");
    sfToggleBtn.id = "__subfluent_dictation_toggle";
    sfToggleBtn.type = "button";

    // Position
    sfToggleBtn.style.position = "fixed";
    sfToggleBtn.style.right = "16px";
    sfToggleBtn.style.bottom = "16px";
    sfToggleBtn.style.zIndex = "2147483647";

    // Look
    sfToggleBtn.style.padding = "10px 12px";
    sfToggleBtn.style.borderRadius = "999px";
    sfToggleBtn.style.border = "0";
    sfToggleBtn.style.cursor = "pointer";
    sfToggleBtn.style.fontSize = "13px";
    sfToggleBtn.style.fontWeight = "700";
    sfToggleBtn.style.boxShadow = "0 8px 28px rgba(0,0,0,0.35)";

    // Avoid Netflix focus outlines weirdness
    sfToggleBtn.style.outline = "none";

    const setLabel = () => {
        if (!sfToggleBtn) return;
        sfToggleBtn.textContent = sfDictationMode ? "Dictation: ON" : "Dictation: OFF";
        sfToggleBtn.style.background = sfDictationMode ? "rgba(140,255,160,0.95)" : "rgba(255,255,255,0.92)";
        sfToggleBtn.style.color = sfDictationMode ? "#0b2a12" : "#111";
    };

    setLabel();

    sfToggleBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();

        sfDictationMode = !sfDictationMode;
        subFluentInfo("[DictationMode]", sfDictationMode ? "ON" : "OFF");

        if (!sfDictationMode) {
            // 끌 때는 overlay 숨기고 재생 재개
            hideDictationOverlay(false);
            sfLastDictationKey = null;
        }

        setLabel();
    });

    document.body.appendChild(sfToggleBtn);
}

// Create early (SPA-safe)
if (document.body) {
    ensureDictationToggleButton();
} else {
    window.addEventListener("DOMContentLoaded", () => ensureDictationToggleButton(), { once: true });
}
// ===== [SF ADDED] end =====

// ===== [SF ADDED] escapeHtml =====
function escapeHtml(s: string) {
    return String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]!));
}
// ===== [SF ADDED] end =====

function startCueLogging(movieId: string, subtitleMap: Map<string, CueData>) {
    // stop previous loop
    stopCueLogging?.();
    subFluentDebug("startCueLogging for movieId:", movieId);

    let running = true;
    let lastVideo: HTMLVideoElement | null = null;
    let lastT = -1;
    let lastLearningKey: string | null = null;

    // ===== [SF ADDED] dictation uses previous cue =====
    let prevClusterKey: string | null = null;
    let prevLearnText: string = "";
    let prevNativeText: string = "";
    // ===== [SF ADDED] end =====

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
    const isWatchPage = (): boolean => location.pathname.startsWith("/watch/");
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

            // ===== [SF ADDED] reset prev cue tracking =====
            prevClusterKey = null;
            prevLearnText = "";
            prevNativeText = "";
            // ===== [SF ADDED] end =====
        }

        const t = video.currentTime;

        // seek/backward jump 방어
        if (lastT >= 0 && t < lastT - 0.5) {
            clusterPtr = 0;
            lastLearningKey = null;

            // ===== [SF ADDED] reset prev cue tracking on seek-back =====
            prevClusterKey = null;
            prevLearnText = "";
            prevNativeText = "";
            // ===== [SF ADDED] end =====
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

                // ===== [SF ADDED] dictation trigger (use previous cue) =====
                if (sfDictationMode) {
                    // 다음 대사 시작 시점에, 직전 대사를 받아쓰기
                    if (prevClusterKey && prevLearnText) {
                        showDictationOverlay(prevLearnText, prevNativeText, prevClusterKey, video);
                    }
                }

                // 다음 전환을 위해 현재를 prev로 저장
                prevClusterKey = c.key;
                prevLearnText = learnText;
                prevNativeText = nativeText;
                // ===== [SF ADDED] end =====
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
        prevClusterKey = null;
        prevLearnText = "";
        prevNativeText = "";
        subFluentDebug("stopCueLogging for movieId:", movieId);
    };
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
    callback(movieId, subtitleCueMap);
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
    if (!bucket.native || !bucket.learning) return;


    const next = contentState.nextMovieId;
    if (next === movieId) {
        contentState.setMovieId(movieId);
        //contentState.setNextMovieId(null);
    }

    // bucket.native / bucket.learning 의 cues 배열을 사용
    const nativeCues = mergeCuesByTime((bucket.native.cues ?? []) as CueLike[]);
    const learningCues = mergeCuesByTime((bucket.learning.cues ?? []) as CueLike[]);
    generateWindow(movieId, learningCues, nativeCues, startCueLogging);
});

// --- TTML URL capture via page hook (pageScript) ---
const PAGE_HOOK_SOURCE = "SubFluent";


// Listen for messages from the injected page hook
window.addEventListener("message", async (ev) => {
    const d = ev.data;
    if (d?.source !== PAGE_HOOK_SOURCE) return;

    if (d?.type === "PLAYER_READY") {
        window.postMessage({ source: "SubFluent", type: "ACK", requestId: d.requestId }, "*");
        contentState.setMovieId(d.movieId);
    }

    if (d?.type === "TTML_TEXT") {
        subFluentDebug("Received TTML_TEXT message:", d.langType, "loaded", d.movieId);

        let movieId = d.movieId
        const lang = d.langType;
        const ttmlSubtitle = parseTtmlSubtitle(d.ttml)
        if (contentState.getSubtitlesState(movieId) === "active") {

        }

        contentState.setSubtitleForMovie(movieId, lang, ttmlSubtitle);
        return;
    }
});