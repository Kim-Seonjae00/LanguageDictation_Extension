import { Msg, type DictationResult, type SendDictation, type ExtMessage } from "../shared/protocol";
import { parseTtmlSubtitle, type Cue } from "../shared/ttmlParser"
import { setSubFluentLogLevel, subFluentDebug, subFluentInfo, subFluentWarn } from "../shared/util";
import { contentState } from "./state/contentState";
setSubFluentLogLevel("DEBUG");

// --- Cue time-based logging (NO DOM, console only) ---
type CueLike = { start: number; end: number; text: string; id?: string };
type SubTitleWindow = {key:String, start:number, end:number, learningSubtitle:string, nativeSubtitle:string };

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
    let lastLearningKey: string | null = null; // trigger key based on learning time window
    let lastVideo: HTMLVideoElement | null = null;
    let lastT = -1;

    // 포인터 기반으로 native cue를 빠르게 스캔하기 위한 인덱스
    let nativePtr = 0;

    // 되감기/점프 감지용: 마지막으로 처리한 learning 시작 시간
    let lastLStart = -Infinity;

    // 필요하면 ms면 120, 초면 0.12로 바꿔
    const EPS = 0.12;           // 경계 허용
    const RATIO_MIN = 0.33;   // learning 기준 overlap 비율
    const RATIO_MAX = 0.8;

    const normalizeText = (s: string) => s.replace(/\s+/g, " ").trim();

    // (선택) 되감기 시 nativePtr를 빠르게 되돌리기 위한 lowerBound
    const lowerBoundByEnd = (arr: CueLike[], target: number) => {
        // arr가 end 기준으로 시간순 정렬되어 있다는 가정 (보통 그렇지)
        let lo = 0, hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (arr[mid].end <= target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };

    const mergeCue = (lastCue: CueLike, nextCue: CueLike, mergedText:string):CueLike =>{
        return {start:lastCue.start,end:nextCue.end,text:mergedText,id:lastCue.id+"::"+nextCue}
    }

    const collectNativeTextsForLearning = (lIdx:number, L: CueLike, Lt: string): Array<CueLike> => {
        const syncNativeCues: CueLike[] = [];
        const Ls = L.start;
        const Le = L.end;
        const Ldur = Math.max(Le - Ls, 1e-6);

        // 되감기/점프백 감지: 시간이 뒤로 가면 nativePtr를 리셋(정확도 유지)
        if (Ls + EPS < lastLStart) {
            // 가장 안전한 방식: nativePtr=0; (느려도 확실)
            // nativePtr = 0;

            // 더 좋은 방식: 해당 시점으로 lowerBound (빠르고 안전)
            nativePtr = lowerBoundByEnd(nativeCues, Ls - EPS);
        }
        lastLStart = Ls;

        // 1) learning 시작 이전에 끝난 native들은 스킵 (EPS 포함)
        while (nativePtr < nativeCues.length && nativeCues[nativePtr].end <= Ls) {
            nativePtr++;
        }

        for (let i = nativePtr; i < nativeCues.length; i++) {
            const n = nativeCues[i];

            // 다음 native가 learning 끝 이후면 종료 (EPS 포함)
            if (n.start >= Le) break;

            // overlap with EPS 허용
            // "진짜 overlap" 계산은 EPS 없이 계산하고, 매칭 후보 판단만 EPS로 완화하는 편이 깔끔
            const overlapStart = Math.max(n.start, Ls);
            const overlapEnd = Math.min(n.end, Le);
            const overlap = overlapEnd - overlapStart;

            if (overlap > 0) {
                const Ndur = Math.max(n.end - n.start, 1e-6);
                const ratioL = overlap / Ldur; // learning 기준
                const ratioN = overlap / Ndur; // native 기준ㅌ

                // B) ratioL 또는 ratioN으로 컷
                if (ratioL >= 0.6 || ratioN >= 0.6 || (ratioL >= RATIO_MIN && ratioN >= RATIO_MIN)) {
                    const text = normalizeText(n.text || "") + " / rL: " + ratioL + " / rN: " + ratioN;
                    syncNativeCues.push({ ...n, text });
                } else {
                    subFluentInfo(movieId, "Lt:", Lt, "/ Nt:", normalizeText(n.text) + "(false)", "/ rL:", ratioL, "/ rN:", ratioN);
                }
            } else {
                // C) "거의 맞닿은" 케이스(경계만 살짝 어긋남) 허용
                // 예: n.end 가 Ls 근처거나 n.start 가 Le 근처인 경우
                const nearBoundary =
                    Math.abs(n.end - Ls) <= EPS || Math.abs(n.start - Le) <= EPS;

                if (nearBoundary) {
                    // 경계만 닿는 애들은 텍스트가 짧은 효과음/전환일 수도 있으니
                    // 최소 길이 필터를 넣고 싶으면 여기서 처리해도 됨
                    const text = normalizeText(n.text || "") + " || nearBoundary";
                    if (text.length > 0) syncNativeCues.push({ ...n, text });
                }
            }
        }

        //D) 비었으면 null
        return syncNativeCues;
    };

    const collectLearningTextForWindow = (idx: number): { key: string; text: string } | null => {
        if (idx < 0 || idx >= learningCues.length) return null;
        const base = learningCues[idx];
        const Ls = base.start;
        const Le = base.end;

        // key: 같은 시간 윈도우를 하나로 묶기
        const key = `${Ls}::${Le}`;

        // 같은 (start,end)를 가진 cue들을 모두 모아 표시 (여러 줄 자막 대응)
        const parts: string[] = [];

        // scan left
        for (let i = idx; i >= 0; i--) {
            const c = learningCues[i];
            if (c.start !== Ls || c.end !== Le) break;
            const trimmed = (c.text || "").trim();
            if (trimmed) parts.unshift(trimmed);
        }

        // scan right (idx+1..)
        for (let i = idx + 1; i < learningCues.length; i++) {
            const c = learningCues[i];
            if (c.start !== Ls || c.end !== Le) break;
            const trimmed = (c.text || "").trim();
            if (trimmed) parts.push(trimmed);
        }

        const text = parts.join(" ");
        return { key, text };
    };

    function loggingSubtileInfo(movieId: string, learningSubtitle: string, nativeSubtitles: Array<CueLike>) {
        const nativeSubtitle = nativeSubtitles.map(n => n.text).join(" | ");
        console.info("[SubFluent] ", movieId, " learning: ", learningSubtitle, " / native: ", nativeSubtitle)
    }

    
    const makeSubtitleWindow = (lIdx:number, allLearningCues:CueLike[], allNativeCues:CueLike[] ):SubTitleWindow => {
        let currentLearningCues = [];
        let currentNativeCues = [];

        const getCurrentLearningCues = (lIdx:number): CueLike[]=>{
            currentLearningCues.push(allLearningCues[lIdx]);
            return currentLearningCues;
        }

        const getCurrentNativeCues = (lIdx:number, currentLearningCue:CueLike): CueLike[] =>{
            type MatchState = "OneToOne" | "OneToN" | "NToOne" | "NToM";
            let state:MatchState = "OneToOne";

            let Ls = currentLearningCue.start;
            let Le = currentLearningCue.end;
            let lastNs = NaN;
            let lastNe = NaN
            
            // 되감기/점프백 감지: 시간이 뒤로 가면 nativePtr를 리셋(정확도 유지)
            if (Ls + EPS < lastLStart) {
                // 가장 안전한 방식: nativePtr=0; (느려도 확실)
                // nativePtr = 0;

                // 더 좋은 방식: 해당 시점으로 lowerBound (빠르고 안전)
                nativePtr = lowerBoundByEnd(nativeCues, Ls - EPS);
            }
            lastLStart = Ls;

            // 1) learning 시작 이전에 끝난 native들은 스킵 (EPS 포함)
            while (nativePtr < nativeCues.length && nativeCues[nativePtr].end <= Ls) {
                nativePtr++;
            }

            for(let i = nativePtr; i < allNativeCues.length; i++){
                const nativeCue = allNativeCues[i];
                let Ns = NaN;
                let Ne = NaN;

                if(state === "OneToOne"){
                    Ns = nativeCue.start;
                    Ne = nativeCue.end;
                }else if(state === "OneToN"){
                    Ns = nativeCue.start;
                    Ne = lastNe;
                }else if(state === "NToOne"){
                    Le = getCurrentLearningCues(lIdx+1).at(-1).end;
                }else if(state === "NToM"){

                }
                
                if (nativeCue.start >= Le) break;
                if (nativeCue.end <= Ls) continue;

                const overlapStart = Math.max(Ns, Ls);
                const overlapEnd = Math.min(Ne, Le);

                const overlap = overlapEnd - overlapStart;
                if (overlap > 0) {
                    const Ldur = Math.max(Le - Ls, 1e-6);
                    const Ndur = Math.max(Ne - Ns, 1e-6);

                    const ratioL = overlap / Ldur; // learning 기준
                    const ratioN = overlap / Ndur; // native 기준
                    const union = Ldur + Ndur - overlap; // 대사 합집합
                    const iou = overlap / Math.max(union, 1e-6);

                    if(ratioL<=RATIO_MIN && ratioN<=RATIO_MIN){
                        continue; //안맞는 대사
                    } 

                    if(ratioL>=RATIO_MAX && ratioN>=RATIO_MAX){
                    // 1) Learning:Native = 1:1
                        currentNativeCues.push(allNativeCues[i]);
                        state = "OneToOne";
                    }else if(ratioN >= RATIO_MAX){
                    // 2) Learning:Native : 1:N
                    // Native 더 찾아서 추가
                        currentNativeCues.push(allNativeCues[i]);
                        state = "OneToN";
                    }else if(ratioL >= RATIO_MAX) {
                        // 3) Learning:Native = N:1
                        // Learning 더 찾아서 추가
                        currentNativeCues.push(allNativeCues[i]);
                        state = "NToOne";
                    }else if (ratioL >= RATIO_MIN && ratioN >= RATIO_MIN && iou >= 0.3) {
                    // 4) Learning:Nativ = N:M 후보(일수도)
                    // Learning, Native 번걸아가면서 가져오며 다시 비교
                        currentNativeCues.push(allNativeCues[i]);
                        state = "NToM";
                    }

                }
                lastNs = Ns;
                lastNe = Ne;
            }

            return currentNativeCues;
        }

        return ;//윈도우 리턴해야함 아직 안만듬 나중에 할거
    }


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

        const hintIdx = 0; // we don't rely on previous index now; binary search handles it
        const lIdx = findActiveCueIndex(learningCues, t, hintIdx);
        const subTitleWindow = makeSubtitleWindow(lIdx, learningCues, nativeCues);

        // 트리거는 learning "시간 윈도우" 변경만 (멀티라인 영어 자막 누락 방지)
        const learningWindow = lIdx >= 0 ? collectLearningTextForWindow(lIdx) : null;
        const nextKey = subTitleWindow ? subTitleWindow.key : null;

        if (nextKey !== lastLearningKey) {
            lastLearningKey = nextKey;

            if (subTitleWindow) {
                // base cue로 native overlap 찾기 (가장 앞 1개)
                const base = learningCues[lIdx];
                const nativeTexts = collectNativeTextsForLearning(lIdx, base, subTitleWindow.text);
                loggingSubtileInfo(movieId, subTitleWindow.text, nativeTexts);
                // subFluentInfo("cue", {
                //     movieId,
                //     t,
                //     learning: learningWindow.text,
                //     native: nativeTexts,
                // });
            }
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


    const next = contentState.nextMovieId;
    if (next === movieId) {
        contentState.setMovieId(movieId);
        contentState.setNextMovieId(null);
    }

    // bucket.native / bucket.learning 의 cues 배열을 사용
    const nativeCues = (bucket.native.cues ?? []) as CueLike[];
    const learningCues = (bucket.learning.cues ?? []) as CueLike[];

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