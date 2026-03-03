import { Msg, type DictationResult } from "../shared/protocol";

function normalizeForScoring(s: string): string {
    return (s || "")
        // remove [ ... ] and ( ... ) blocks (caption metadata)
        .replace(/\[[^\]]*\]/g, " ")
        .replace(/\([^)]*\)/g, " ")
        // remove speaker-leading hyphens: "-Hello" / "- Hello"
        .replace(/(^|\s)-\s*/g, "$1")
        // keep letters/numbers/spaces/apostrophes, drop other punctuation
        .replace(/[^a-zA-Z0-9\s']/g, " ")
        .toUpperCase()
        .replace(/\s+/g, " ")
        .trim();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === Msg.DICTATION_SEND) {
        console.log("[BG] received dictation send message:", sender, msg);

        const expected = msg.payload.expected;
        const actual = msg.payload.actual;

        const expectedNorm = normalizeForScoring(expected);
        const actualNorm = normalizeForScoring(actual);

        const expectedWords = expectedNorm ? expectedNorm.split(/\s+/) : [];
        const actualWords = actualNorm ? actualNorm.split(/\s+/) : [];

        const wrong: number[] = [];

        const maxLen = Math.max(expectedWords.length, actualWords.length);
        for (let i = 0; i < maxLen; i++) {
            const ew = expectedWords[i] ?? "";
            const aw = actualWords[i] ?? "";
            console.log("[BG] comparing words at index", i, ":", ew, "vs", aw);
            if (ew !== aw) {
                console.log("[BG] word mismatch at index", i, ":", ew, "!=", aw);
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