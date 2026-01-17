import { Msg, type DictationResult, type SendDictation, type ExtMessage } from "../shared/protocol";
import { parseTtmlSubtitle}  from "../shared/ttmlParser"
import {setSubFluentLogLevel, subFluentDebug, subFluentInfo } from "../shared/util";
import { contentState } from "./state/contentState";
setSubFluentLogLevel("DEBUG");

contentState.subscribeSubtitlesReady(({ movieId, bucket }) => {
    subFluentInfo("subtitles ready", { movieId, native: !!bucket.native, learning: !!bucket.learning });
});

// --- Cue time-based logging (NO DOM, console only) ---
type CueLike = { start: number; end: number; text: string; id?: string };

function getVideoEl(): HTMLVideoElement | null {
    return document.querySelector("video");
}

function findActiveCueIndex(cues: CueLike[], t: number, hintIdx: number): number {
    if (!cues.length) return -1;

    // fast path: check previous index and neighbors
    if (hintIdx >= 0 && hintIdx < cues.length) {
        const c = cues[hintIdx];
        if (t >= c.start && t < c.end) return hintIdx;
        const prev = cues[hintIdx - 1];
        if (prev && t >= prev.start && t < prev.end) return hintIdx - 1;
        const next = cues[hintIdx + 1];
        if (next && t >= next.start && t < next.end) return hintIdx + 1;
    }

    // binary search (assumes cues sorted by start)
    let lo = 0;
    let hi = cues.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const c = cues[mid];
        if (t < c.start) hi = mid - 1;
        else if (t >= c.end) lo = mid + 1;
        else return mid;
    }
    return -1;
}

let stopCueLogging: (() => void) | null = null;

function startCueLogging(movieId: string, nativeCues: CueLike[], learningCues: CueLike[]) {
    // stop previous loop
    stopCueLogging?.();

    let running = true;
    let lastNativeIdx = -1;
    let lastLearningIdx = -1;
    let lastVideo: HTMLVideoElement | null = null;

    const tick = () => {
        if (!running) return;

        const video = getVideoEl();
        if (!video) {
            requestAnimationFrame(tick);
            return;
        }

        // video element swapped? reset indices so we log immediately
        if (lastVideo !== video) {
            lastVideo = video;
            lastNativeIdx = -1;
            lastLearningIdx = -1;
        }

        const t = video.currentTime;

        const nIdx = findActiveCueIndex(nativeCues, t, lastNativeIdx);
        const lIdx = findActiveCueIndex(learningCues, t, lastLearningIdx);

        const changed = nIdx !== lastNativeIdx || lIdx !== lastLearningIdx;
        if (changed) {
            lastNativeIdx = nIdx;
            lastLearningIdx = lIdx;

            const n = nIdx >= 0 ? nativeCues[nIdx] : null;
            const l = lIdx >= 0 ? learningCues[lIdx] : null;

            subFluentInfo("cue", {
                movieId,
                t,
                native: n ? { start: n.start, end: n.end, text: n.text } : null,
                learning: l ? { start: l.start, end: l.end, text: l.text } : null,
            });
        }

        requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);

    stopCueLogging = () => {
        running = false;
    };
}

// Stop logging when movie changes or page unloads
contentState.subscribeMovieId((next) => {
    // movieId가 바뀌면 이전 루프는 중단
    if (!next) {
        stopCueLogging?.();
        subFluentDebug("stopCueLogging::movieId X")
        stopCueLogging = null;
    }
});


window.addEventListener("beforeunload", () => {
    stopCueLogging?.();
    subFluentDebug("stopCueLogging::beforeuload")
    stopCueLogging = null;
});

// When both subtitles ready, start time-based cue logging
contentState.subscribeSubtitlesReady(({ movieId, bucket }) => {
    if (!bucket.native || !bucket.learning) return;

    // bucket.native / bucket.learning 의 cues 배열을 사용
    const nativeCues = (bucket.native.cues ?? []) as CueLike[];
    const learningCues = (bucket.learning.cues ?? []) as CueLike[];
    subFluentDebug("subtitlemovieId", movieId)
    const next = contentState.nextMovieId;
    if(next === movieId){
        contentState.setMovieId(movieId);
        // contentState.setNextMovieId(null);
        subFluentDebug("nextSubtitle",movieId);
    }

    startCueLogging(movieId, nativeCues, learningCues);
});

// --- TTML URL capture via page hook (pageScript) ---
const PAGE_HOOK_SOURCE = "SubFluent";


// Listen for messages from the injected page hook
window.addEventListener("message", async (ev) => {
    const d = ev.data;
    if (d?.source !== PAGE_HOOK_SOURCE) return;

    if (d?.type === "HOOK_READY") {
        return;
    }

    if (d?.type === "TTML_TEXT") {
        if(!contentState.movieId) 
            return;
        let movieId = contentState.movieId;
        if(contentState.isSubtitlesReady(movieId)){
            subFluentDebug("isSubtitlesReady(movieId):", movieId);
            if(contentState.nextMovieId){
                movieId = contentState.nextMovieId;
                subFluentDebug("isSubtitlesReady(nextmovieId):", movieId);
            }
        }

        const lang = d.langType;
        const ttmlSubtitle = parseTtmlSubtitle(d.ttml)

        contentState.setSubtitleForMovie(movieId, lang, ttmlSubtitle);
        subFluentDebug("TTML_TEXT movieId:",movieId)
        subFluentDebug("downloadedTimedTextedTrackList", contentState.getSubtitles())
        return;
    }

    if(d?.type === "LICENSED_MANIFEST") {
        if(!contentState.movieId){
            contentState.setMovieId(d.movieId);
            subFluentDebug("FirsttMovieID", d.movieId)
        }
        else{
            contentState.setNextMovieId(d.movieId);
            subFluentDebug("d.movieID",d.movieId,"nextMovieID", contentState.nextMovieId)
        }


        subFluentDebug("manifest", d.movieId);
        return;
    }
});

let overlay: HTMLDivElement | null = null;
let input: HTMLInputElement | null = null;

function getExpectedText(): string {
    const node = document.querySelector<HTMLElement>("#answer");
    return node?.dataset?.answer?.trim() || "";
}

function showOverlay() {
    if (overlay) return;

    overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.zIndex = "999999";
    overlay.style.background = "rgba(0,0,0,0.6)";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";

    const box = document.createElement("div");
    box.style.background = "white";
    box.style.padding = "16px";
    box.style.borderRadius = "12px";
    box.style.width = "min(520px, 90vw)";

    const title = document.createElement("div");
    title.textContent = "SubFluent Dictation — type & press Enter";
    title.style.marginBottom = "10px";

    const result = document.createElement("div");
    result.id = "dictation-result";
    result.style.marginBottom = "10px";
    const state = document.createElement("span");
    const answer = document.createElement("span");
    const expectedText = document.createElement("span");

    input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Type here...";
    input.style.width = "100%";
    input.style.fontSize = "16px";
    input.style.padding = "10px";
    input.style.boxSizing = "border-box";

    input.addEventListener("keydown", (e) => {
        if (!input) return;

        if (e.key === "Enter") {

            const expected = getExpectedText();
            const actual = input.value;

            const payload: SendDictation = {
                expected,
                actual,
            };
            const msg: ExtMessage<typeof Msg.DICTATION_SEND> = { type: Msg.DICTATION_SEND, payload };
            chrome.runtime.sendMessage(msg, (response) => {
                subFluentDebug("received response from background:", response);
                if (response?.type === Msg.DICTATION_RESULT) {
                    const result = response.payload as DictationResult;
                    if (result.correct) {
                        state.innerHTML = "✅ Correct!";
                        answer.innerHTML = result.sendDictation.actual;
                        expectedText.innerHTML = '<span style="color: green;">' + result.sendDictation.expected + '</span>';
                    } else {
                        state.innerHTML = "❌ Wrong!";
                        answer.innerHTML = result.sendDictation.actual;
                        expectedText.innerHTML = result.sendDictation.expected;
                        const wrongIndices = new Set(result.wrong);
                        const answerWords = result.sendDictation.actual.trim().split(/\s+/);
                        const highlightedAnswer = answerWords.map((word, index) => {
                            if (wrongIndices.has(index)) {
                                return `<span style="color: red;">${word}</span>`;
                            }
                            return word;
                        }).join(" ");
                        answer.innerHTML = highlightedAnswer;
                    }
                }
            });

            input.value = "";
        }

        if (e.key === "Escape") {
            hideOverlay();
        }
    });

    box.appendChild(title);
    box.appendChild(input);

    result.appendChild(state);
    result.appendChild(document.createElement("br"));
    result.appendChild(expectedText);
    result.appendChild(document.createElement("br"));
    result.appendChild(answer);

    box.appendChild(result);

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    input.focus();
}

function hideOverlay() {
    overlay?.remove();
    overlay = null;
    input = null;
}

chrome.runtime.onMessage.addListener((msg: any) => {
    if (msg?.type === Msg.START) showOverlay();
    if (msg?.type === Msg.STOP) hideOverlay();
});