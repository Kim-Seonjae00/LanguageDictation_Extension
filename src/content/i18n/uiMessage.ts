export type UiLocale = "ko" | "en" | "ja" | "zh" | "fr" | "de" | "es" | "it" | "pt";

export type UiMessages = {
    settingsTitle: string;
    dictationBadge: string;
    dictationHint: string;
    replayTitle: string;
    nextTitle: string;
    inputPlaceholder: string;
    expectedLabel: string;
    correct: string;
    wrong: string;
    close: string;
    nativeMeaningLabel: string;
    settingsDictation: string;
    settingsAudio: string;
    settingsSubtitle: string;
    settingsTranslate: string;
    settingsApply: string;
    settingsOnOff: string;
};

export const SF_UI_MESSAGES: Record<UiLocale, UiMessages> = {
    ko: {
        settingsTitle: "SubDictate 설정",
        dictationBadge: "받아쓰기",
        dictationHint: "들리는 문장을 입력하세요. <br>Enter = 제출 · Esc = 닫기",
        replayTitle: "다시 듣기",
        nextTitle: "다음",
        inputPlaceholder: "여기에 입력하세요...",
        expectedLabel: "정답",
        correct: "정답",
        wrong: "오답",
        close: "닫기",
        nativeMeaningLabel: "의미",
        settingsDictation: "받아쓰기 설정",
        settingsAudio: "오디오 언어 설정",
        settingsSubtitle: "자막 언어 설정",
        settingsTranslate: "번역 언어 설정",
        settingsApply: "적용",
        settingsOnOff: "ON / OFF",
    },
    en: {
        settingsTitle: "SubDictate Settings",
        dictationBadge: "DICTATION",
        dictationHint: "Type what you hear. <br>Enter = submit · Esc = close",
        replayTitle: "Replay",
        nextTitle: "Next",
        inputPlaceholder: "Type here...",
        expectedLabel: "Expected",
        correct: "Correct",
        wrong: "Wrong",
        close: "Close",
        nativeMeaningLabel: "Meaning",
        settingsDictation: "Dictation",
        settingsAudio: "Audio Language",
        settingsSubtitle: "Subtitle Language",
        settingsTranslate: "Translation Language",
        settingsApply: "Apply",
        settingsOnOff: "ON / OFF",
    },
    ja: {
        settingsTitle: "SubDictate 設定",
        dictationBadge: "ディクテーション",
        dictationHint: "聞こえた内容を入力してください。<br>Enter = 送信 · Esc = 閉じる",
        replayTitle: "もう一度聞く",
        nextTitle: "次へ",
        inputPlaceholder: "ここに入力してください...",
        expectedLabel: "正解",
        correct: "正解",
        wrong: "不正解",
        close: "閉じる",
        nativeMeaningLabel: "意味",
        settingsDictation: "ディクテーション設定",
        settingsAudio: "音声言語設定",
        settingsSubtitle: "字幕言語設定",
        settingsTranslate: "翻訳言語設定",
        settingsApply: "適用",
        settingsOnOff: "ON / OFF",
    },
    zh: {
        settingsTitle: "SubDictate 设置",
        dictationBadge: "听写",
        dictationHint: "请输入你听到的内容。<br>Enter = 提交 · Esc = 关闭",
        replayTitle: "重听",
        nextTitle: "下一句",
        inputPlaceholder: "请在这里输入...",
        expectedLabel: "正确答案",
        correct: "正确",
        wrong: "错误",
        close: "关闭",
        nativeMeaningLabel: "含义",
        settingsDictation: "听写设置",
        settingsAudio: "音频语言设置",
        settingsSubtitle: "字幕语言设置",
        settingsTranslate: "翻译语言设置",
        settingsApply: "应用",
        settingsOnOff: "ON / OFF",
    },
    fr: {
        settingsTitle: "Paramètres SubDictate",
        dictationBadge: "DICTÉE",
        dictationHint: "Tapez ce que vous entendez. <br>Entrée = valider · Échap = fermer",
        replayTitle: "Réécouter",
        nextTitle: "Suivant",
        inputPlaceholder: "Tapez ici...",
        expectedLabel: "Réponse attendue",
        correct: "Correct",
        wrong: "Incorrect",
        close: "Fermer",
        nativeMeaningLabel: "Sens",
        settingsDictation: "Dictée",
        settingsAudio: "Langue audio",
        settingsSubtitle: "Langue des sous-titres",
        settingsTranslate: "Langue de traduction",
        settingsApply: "Appliquer",
        settingsOnOff: "ON / OFF",
    },
    de: {
        settingsTitle: "SubDictate-Einstellungen",
        dictationBadge: "DIKTAT",
        dictationHint: "Geben Sie ein, was Sie hören. <br>Eingabe = senden · Esc = schließen",
        replayTitle: "Erneut abspielen",
        nextTitle: "Weiter",
        inputPlaceholder: "Hier eingeben...",
        expectedLabel: "Erwartet",
        correct: "Richtig",
        wrong: "Falsch",
        close: "Schließen",
        nativeMeaningLabel: "Bedeutung",
        settingsDictation: "Diktat",
        settingsAudio: "Audiosprache",
        settingsSubtitle: "Untertitelsprache",
        settingsTranslate: "Übersetzungssprache",
        settingsApply: "Anwenden",
        settingsOnOff: "ON / OFF",
    },
    es: {
        settingsTitle: "Configuración de SubDictate",
        dictationBadge: "DICTADO",
        dictationHint: "Escribe lo que escuchas. <br>Enter = enviar · Esc = cerrar",
        replayTitle: "Repetir",
        nextTitle: "Siguiente",
        inputPlaceholder: "Escribe aquí...",
        expectedLabel: "Esperado",
        correct: "Correcto",
        wrong: "Incorrecto",
        close: "Cerrar",
        nativeMeaningLabel: "Significado",
        settingsDictation: "Dictado",
        settingsAudio: "Idioma de audio",
        settingsSubtitle: "Idioma de subtítulos",
        settingsTranslate: "Idioma de traducción",
        settingsApply: "Aplicar",
        settingsOnOff: "ON / OFF",
    },
    it: {
        settingsTitle: "Impostazioni di SubDictate",
        dictationBadge: "DETTATO",
        dictationHint: "Digita ciò che senti. <br>Invio = invia · Esc = chiudi",
        replayTitle: "Riascolta",
        nextTitle: "Avanti",
        inputPlaceholder: "Digita qui...",
        expectedLabel: "Atteso",
        correct: "Corretto",
        wrong: "Errato",
        close: "Chiudi",
        nativeMeaningLabel: "Significato",
        settingsDictation: "Dettato",
        settingsAudio: "Lingua audio",
        settingsSubtitle: "Lingua sottotitoli",
        settingsTranslate: "Lingua traduzione",
        settingsApply: "Applica",
        settingsOnOff: "ON / OFF",
    },
    pt: {
        settingsTitle: "Configurações do SubDictate",
        dictationBadge: "DITADO",
        dictationHint: "Digite o que você ouve. <br>Enter = enviar · Esc = fechar",
        replayTitle: "Ouvir novamente",
        nextTitle: "Próximo",
        inputPlaceholder: "Digite aqui...",
        expectedLabel: "Esperado",
        correct: "Correto",
        wrong: "Incorreto",
        close: "Fechar",
        nativeMeaningLabel: "Significado",
        settingsDictation: "Ditado",
        settingsAudio: "Idioma do áudio",
        settingsSubtitle: "Idioma das legendas",
        settingsTranslate: "Idioma da tradução",
        settingsApply: "Aplicar",
        settingsOnOff: "ON / OFF",
    },
};

export function getUiLocale(): UiLocale {
    const lang = (navigator.language || "en").toLowerCase();

    if (lang === "ko" || lang.startsWith("ko-")) return "ko";
    if (lang === "ja" || lang.startsWith("ja-")) return "ja";
    if (lang === "zh" || lang.startsWith("zh-")) return "zh";
    if (lang === "fr" || lang.startsWith("fr-")) return "fr";
    if (lang === "de" || lang.startsWith("de-")) return "de";
    if (lang === "es" || lang.startsWith("es-")) return "es";
    if (lang === "it" || lang.startsWith("it-")) return "it";
    if (lang === "pt" || lang.startsWith("pt-")) return "pt";

    return "en";
}

export function t(locale?: UiLocale): UiMessages {
    const current = locale || getUiLocale();
    return SF_UI_MESSAGES[current] || SF_UI_MESSAGES.en;
}

export function tm<K extends keyof UiMessages>(key: K, locale?: UiLocale): UiMessages[K] {
    const keyName = String(key);

    try {
        const chromeMessage = chrome?.i18n?.getMessage?.(keyName);
        if (typeof chromeMessage === "string" && chromeMessage.length > 0) {
            return chromeMessage as UiMessages[K];
        }
    } catch {
        // ignore and fall back to in-file messages
    }

    return t(locale)[key];
}