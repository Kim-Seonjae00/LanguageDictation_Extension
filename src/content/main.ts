console.log("[SubFluent] content script loaded");

import { Msg, type DictationResult, type SendDictation, type ExtMessage } from "../shared/protocol";
import { parseTtml}  from "../shared/ttmlParser"

// --- TTML URL capture via page hook (pageScript) ---
const PAGE_HOOK_SOURCE = "SubFluent";
const downloadedTimedTextedTrackList = new Map<string, any>();

// Listen for messages from the injected page hook
window.addEventListener("message", async (ev) => {
    const d = ev.data;
    if (d?.source !== PAGE_HOOK_SOURCE) return;

    if (d?.type === "HOOK_READY") {
        console.log("[SubFluent] page hook ready");
        return;
    }

    if (d?.type === "TTML_TEXT") {
        const ttmlDocument = parseTtml(d.ttml)
        const nttm = ttmlDocument.meta.nttm;
        if(!nttm) return;
        const k = nttm["nttm:movieID"] + d.langType;
        if(!k) return;

        const v = {
            cues: ttmlDocument.cues,
            styles: ttmlDocument.styles,
            type: nttm["nttm:textType"]
        }
        downloadedTimedTextedTrackList.set(k, v);
        console.log("[SubFluent] TrackList : ", downloadedTimedTextedTrackList)
        return;
    }

    if(d?.type === "LOAD_SUBTITLE") {
        console.log("[SubFluent] request to load subtitle for id:", d.trackId);
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
                console.log("[SubFluent] received response from background:", response);
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