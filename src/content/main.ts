import { Msg, type DictationResult, type SendDictation, type ExtMessage } from "../shared/protocol";
import { parseTtmlSubtitle, type Cue } from "../shared/ttmlParser"
import { setSubFluentLogLevel, subFluentDebug, subFluentInfo, subFluentWarn } from "../shared/util";
import { contentState } from "./state/contentState";
setSubFluentLogLevel("DEBUG");

// --- Cue time-based logging (NO DOM, console only) ---
type CueLike = { start: number; end: number; text: string; id?: string };
// type CueData = { id: string; start:number; end:number; text:string[]};

function getVideoEl(): HTMLVideoElement | null {
    return document.querySelector("video");
}

let stopCueLogging: (() => void) | null = null;

function startCueLogging(movieId: string, nativeCues: CueLike[], learningCues: CueLike[]) {
    // stop previous loop
    stopCueLogging?.();

    let running = true;
    let lastVideo: HTMLVideoElement | null = null;
    let lastT = -1;
    let lastLearningKey = null;

    // 포인터 기반으로 native cue를 빠르게 스캔하기 위한 인덱스
    let nativePtr = 0;
    

    const normalizeText = (s: string) => s.replace(/\s+/g, " ").trim();

    const tick = () => {
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
            nativePtr = 0;
            lastT = -1;
        }

        const t = video.currentTime;

        // seek/backward jump 방어: 시간이 크게 뒤로 가면 포인터 리셋
        if (lastT >= 0 && t < lastT - 0.5) {
            nativePtr = 0;
        }
        lastT = t;

        requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);

    stopCueLogging = () => {
        running = false;
    };
}

// function sortCues(cues:CueLike[]):Cue[]{
//     const sortedCues:Cue[] = [];
//     const textParts:string[] = [];

//     for(cue)


//     return sortedCues;
// }

function generateWindow(movieId:string, learningCuesRaw:CueLike[], nativeCuesRaw:CueLike[], callback:Function){
    const EPS = 0.012;
    const RATIO_MIN = 0.3;
    const RATIO_MAX = 0.8;
    const normalizeText = (s: string) => s.replace(/\s+/g, " ").trim();

    const learningCues = learningCuesRaw.map(c => ({ ...c }));
    const nativeCues = nativeCuesRaw.map(c => ({ ...c }));
    const subtitleCueMap = new Map<string,{learn:string[],native:string[]}>();

    for(let i=0;i<learningCues.length;i++){
        const learningCue = learningCues[i];
        
        const ls = learningCue.start;
        let le = learningCue.end;

        const key = ls+"::"+le;

        let overlap = 0;


        if(!subtitleCueMap.has(key)){
            subtitleCueMap.set(key,{learn:[learningCue.text], native:[]});
        }else{
            subtitleCueMap.get(key)?.learn.push(learningCue.text);
            continue;
        }

        for(let j=0;j<nativeCues.length;j++){
            const nativeCue = nativeCues[j];
            const ns = nativeCue.start;
            if (ns >= le) break;

            const ne = nativeCue.end;
            
            const overlapStart = Math.max(ns, ls);
            const overlapEnd = Math.min(ne, le);
            overlap = overlapEnd - overlapStart;

            if(overlap > 0){
                const lDuration = Math.max(le - ls,1e-16);
                const nDuration = Math.max(ne - ns, 1e-6);

                const lRatio = overlap / lDuration;
                const nRatio = overlap / nDuration;

                if(lRatio <= RATIO_MIN && nRatio <= RATIO_MIN) continue;
                if(lRatio >= RATIO_MAX && nRatio >= RATIO_MAX){
                    subtitleCueMap.get(key)?.native.push(nativeCue.text);
                }else if(RATIO_MIN < lRatio && lRatio < RATIO_MAX){

                }else if(RATIO_MIN < nRatio && nRatio <RATIO_MAX){

                }else if(){

                }
                nativeCues.splice(j, 1);
            }else {
                // C) "거의 맞닿은" 케이스(경계만 살짝 어긋남) 허용
                // 예: n.end 가 Ls 근처거나 n.start 가 Le 근처인 경우
                const nearBoundary = Math.abs(ne - ls) <= EPS || Math.abs(ns - le) <= EPS;

                if (nearBoundary) {
                    // 경계만 닿는 애들은 텍스트가 짧은 효과음/전환일 수도 있으니
                    // 최소 길이 필터를 넣고 싶으면 여기서 처리해도 됨
                    const text = normalizeText(nativeCue.text || "") + " || nearBoundary";
                    if (text.length > 0){ 
                        subtitleCueMap.get(key)?.native.push(text);
                        nativeCues.splice(j, 1);
                    }
                }
            }
        }
    }

    const subtitle = {learn:learningCues, native:nativeCues};
    callback(movieId, subtitle);
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


    const next = contentState.nextMovieId;
    if (next === movieId) {
        contentState.setMovieId(movieId);
        contentState.setNextMovieId(null);
    }

    // bucket.native / bucket.learning 의 cues 배열을 사용
    const nativeCues = (bucket.native.cues ?? []) as CueLike[];
    const learningCues = (bucket.learning.cues ?? []) as CueLike[];

    generateWindow(movieId, learningCues, nativeCues, startCueLogging);
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
        if (!contentState.movieId)
            return;
        let movieId = contentState.movieId;
        if (contentState.isSubtitlesReady(movieId)) {
            subFluentDebug("isSubtitlesReady(movieId):", movieId);
            if (contentState.nextMovieId) {
                movieId = contentState.nextMovieId;
                subFluentDebug("isSubtitlesReady(nextmovieId):", movieId);
            }
        }

        const lang = d.langType;
        const ttmlSubtitle = parseTtmlSubtitle(d.ttml)

        contentState.setSubtitleForMovie(movieId, lang, ttmlSubtitle);
        subFluentDebug("TTML_TEXT movieId:", movieId)
        subFluentDebug("downloadedTimedTextedTrackList", contentState.getSubtitles())
        return;
    }

    if (d?.type === "LICENSED_MANIFEST") {
        if (!contentState.movieId) {
            contentState.setMovieId(d.movieId);
            subFluentDebug("FirsttMovieID", d.movieId)
        }
        else {
            contentState.setNextMovieId(d.movieId);
            subFluentDebug("d.movieID", d.movieId, "nextMovieID", contentState.nextMovieId)
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