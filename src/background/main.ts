import { Msg, type DictationResult } from "../shared/protocol";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === Msg.DICTATION_SEND) {
        console.log("[BG] received dictation send message:", sender, msg);

        const expected = msg.payload.expected;
        const actual = msg.payload.actual;

        const expectedWords = expected.trim().split(/\s+/);
        const actualWords = actual.trim().split(/\s+/);
        const wrong: number[] = [];

        for (let i = 0; i < expectedWords.length; i++) {
            console.log("[BG] comparing words at index", i, ":", expectedWords[i], "vs", actualWords[i]);
            if (expectedWords[i] !== actualWords[i]) {
                console.log("[BG] word mismatch at index", i, ":", expectedWords[i], "!=", actualWords[i]);
                wrong.push(i);
            }
        }

        const correct = wrong.length === 0;

        console.log("[BG] result :", { correct, wrong });
        const result: DictationResult = { correct, wrong, sendDictation: { expected, actual } };
        sendResponse({ type: Msg.DICTATION_RESULT, payload: result });
    }

    // 비동기 응답 가능하게
    return true;
});