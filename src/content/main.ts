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

function startCueLogging(movieId: string, subtitleMap: Map<string, CueData>) {
    // stop previous loop
    stopCueLogging?.();
    subFluentDebug("startCueLogging for movieId:", movieId);
    subFluentDebug("learningSubtitle:", subtitleMap);
    let running = true;
    let lastVideo: HTMLVideoElement | null = null;
    let lastT = -1;
    let lastLearningKey: string | null = null;

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
            clusterPtr = 0;
            lastT = -1;
        }

        const t = video.currentTime;

        // seek/backward jump 방어
        if (lastT >= 0 && t < lastT - 0.5) {
            clusterPtr = 0;
            lastLearningKey = null;
        }
        lastT = t;

        while (clusterPtr < clusters.length) {
            const c = clusters[clusterPtr];

            // 아직 해당 클러스터 시작 전이면 대기
            if (t < c.ls) break;

            // 클러스터 구간 진입(처음 1번만)
            if (t >= c.ls && t < c.le) {
                // 중복 로그 방지(선택): key로 막기
                if (lastLearningKey !== c.key) {
                    lastLearningKey = c.key;

                    subFluentInfo(
                        "L:", normalizeText(c.learn.join(" ")),
                        "N:", normalizeText(c.native.join(" "))
                    );
                }
                break; // 한 tick에 하나만
            }

            // 이미 지난 클러스터면 다음으로
            clusterPtr++;
        }

        requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);

    stopCueLogging = () => {
        running = false;
    };
}

function generateWindow(movieId: string, learningCuesRaw: CueLike[], nativeCuesRaw: CueLike[], callback: Function) {
    const MatchState = {
        OneToOne: "OneToOne",
        OneToN: "OneToN",
        NToOne: "NToOne",
        NToM: "NToM",
        NoMatch: "NoMatch",
    } as const;
    type MatchState = typeof MatchState[keyof typeof MatchState];


    const EPS = 0.020;
    const RATIO_MIN = 0.35;
    const RATIO_MAX = 0.70;


    const normalizeText = (s: string) => s.replace(/\s+/g, " ").trim();

    const learningCues = learningCuesRaw.map(c => ({ ...c }));
    const nativeCues = nativeCuesRaw.map(c => ({ ...c }));
    const subtitleCueMap = new Map<string, CueData>();

    for (let i = 0; i < learningCues.length; i++) {
        let state: MatchState = "OneToOne";

        const learningCue = learningCues[i];

        const ls = learningCue.start;
        let le = learningCue.end;
        let lastNs = 0;
        let lastNe = 0;

        const key = movieId + "_#" + i;

        if (!subtitleCueMap.has(key)) {
            subtitleCueMap.set(key, { start: ls, end: le, learn: [learningCue.text], native: [] });
        } else {
            subtitleCueMap.get(key)?.learn.push(learningCue.text);
            continue;
        }

        for (let j = 0; j < nativeCues.length; j++) {
            const nativeCue = nativeCues[j];
            const ns = state === "OneToN" && (nativeCue.start - lastNe) < EPS ? lastNs : nativeCue.start;

            if (ns >= le) break;

            const ne = nativeCue.end;

            const overlapStart = Math.max(ns, ls);
            const overlapEnd = Math.min(ne, le);
            let overlap = overlapEnd - overlapStart;

            if (overlap > 0) {
                const lDuration = Math.max(le - ls, 1e-16);
                const nDuration = Math.max(ne - ns, 1e-6);
                const lRatio = overlap / lDuration;
                const nRatio = overlap / nDuration;

                if (lRatio <= RATIO_MIN && nRatio <= RATIO_MIN) continue;

                subFluentDebug("Matching native cue:", nativeCue.text, "with learning cue:", learningCue.text, "Lratio:", lRatio, "Nratio:", nRatio);
                if (lRatio >= RATIO_MAX && nRatio >= RATIO_MAX) {
                    // L:N = 1:1
                    subtitleCueMap.get(key)?.native.push(nativeCue.text);
                    state = "OneToOne";
                } else if (RATIO_MAX <= lRatio && nRatio < RATIO_MAX) {
                    // L:N = N:1
                    // le값만 변경
                    subtitleCueMap.get(key)?.native.push(nativeCue.text);

                    if (i + 1 < learningCues.length) {
                        const nextLearning = learningCues[i + 1];
                        if (nextLearning.start <= ne + EPS) {
                            le = nextLearning.end;
                            subtitleCueMap.get(key)?.learn.push(nextLearning.text);
                            subtitleCueMap.get(key)!.end = le;
                            i++; // 다음 learning cue 소비
                        }
                    }

                    state = "NToOne";
                } else if (RATIO_MAX <= nRatio && lRatio < RATIO_MAX) {
                    // L:N = 1:N
                    // ns값 기존 값 유지
                    subtitleCueMap.get(key)?.native.push(nativeCue.text);
                    lastNs = ns;
                    lastNe = ne;

                    state = "OneToN";
                } else {
                    // L:N = N:M
                    // - native도 여러 개가 붙을 수 있고
                    // - learning도 다음 cue들까지 이어서 하나의 클러스터로 묶일 수 있는 케이스
                    subtitleCueMap.get(key)?.native.push(nativeCue.text);

                    // OneToN처럼 ns를 고정(또는 유지)해서 다음 native와의 overlap 계산이 튀지 않게 함
                    lastNs = ns;

                    // 현재 native cue가 learning cue 구간을 넘어가면, learning 쪽도 다음 cue들을 소비하며 le를 확장
                    // (추가 "검색" 루프가 아니라, i 포인터를 앞으로 이동시키며 연속 cue만 흡수)
                    while (i + 1 < learningCues.length) {
                        const nextLearning = learningCues[i + 1];
                        // 다음 learning이 현재 learning 끝 직후로 이어지거나, 현재 native가 아직 다음 learning 시작까지 덮고 있으면 흡수
                        const shouldAbsorb = nextLearning.start <= le + EPS || nextLearning.start < ne - EPS;
                        if (!shouldAbsorb) break;

                        le = nextLearning.end;
                        subtitleCueMap.get(key)?.learn.push(nextLearning.text);
                        i++;

                        // 이미 le가 native의 끝을 충분히 덮으면(=현재 native가 한 덩어리로 설명 가능) 더 확장하지 않음
                        if (le >= ne - EPS) break;
                    }

                    state = "NToM";
                }

                // consume matched native cue
                nativeCues.splice(j, 1);
                j--;
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
        subFluentDebug("stopCueLogging::movieId X");
        stopCueLogging = null;
    }
});


window.addEventListener("beforeunload", () => {
    stopCueLogging?.();
    subFluentDebug("stopCueLogging::beforeuload");
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
        const ttmlSubtitle = parseTtmlSubtitle(d.ttml);

        contentState.setSubtitleForMovie(movieId, lang, ttmlSubtitle);
        subFluentDebug("TTML_TEXT movieId:", movieId);
        subFluentDebug("downloadedTimedTextedTrackList", contentState.getSubtitles());
        return;
    }

    if (d?.type === "LICENSED_MANIFEST") {
        if (!contentState.movieId) {
            contentState.setMovieId(d.movieId);
            subFluentDebug("FirsttMovieID", d.movieId);
        }
        else {
            contentState.setNextMovieId(d.movieId);
            subFluentDebug("d.movieID", d.movieId, "nextMovieID", contentState.nextMovieId);
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
                        expectedText.innerHTML = '<span style="color: green;">' + result.sendDictation.expected + "</span>";
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