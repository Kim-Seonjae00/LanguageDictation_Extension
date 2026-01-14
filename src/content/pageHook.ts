// src/content/pageHook.ts

(function () {
    // ===== 0) 중복 주입 방지 (page world 전역 플래그) =====
    const PAGE_NS = "__SUBFLUENT__";
    const g = window as any;
    g[PAGE_NS] ??= {};

    // pageHook 자체 중복 실행 방지
    if (g[PAGE_NS].pageHookInjected) {
        return;
    }
    g[PAGE_NS].pageHookInjected = true;
    g[PAGE_NS].pageHookInjectedAt = Date.now();

    // 훅 상태 보관용
    g[PAGE_NS].hooks ??= {};

    const SRC = "SubFluent";
    const learningLang = "en";
    const nativeLang = "ko";
    const TEST_LANG = [learningLang, nativeLang];
    let playerFacade: any = null; // raw Netflix player (live object)

    type PlayerFacade = {
        getMovieId: () => any;
        getTimedTextTrack: () => any;
        getTimedTextTrackList: () => any;
        setTimedTextTrack: (track: any) => Promise<any>;
        getReady: () => boolean;
    };

    function createPlayerFacade(p: any): PlayerFacade {
        return {
            getMovieId: () => p?.getMovieId?.(),
            getTimedTextTrack: () => p?.getTimedTextTrack?.(),
            getTimedTextTrackList: () => p?.getTimedTextTrackList?.(),
            setTimedTextTrack: (track: any) => p?.setTimedTextTrack?.(track),
            getReady: () => p?.getReady?.(),
        };
    }
    // pageHook.ts (page world)
    // ===== 1) 공용 폴링 유틸 =====
    function pollUntil<T>(getter: () => T | null | undefined | false, label: string): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const start = Date.now();
            const timer = setInterval(() => {
                try {
                    const v = getter();
                    if (v) {
                        clearInterval(timer);
                        resolve(v as T);
                        return;
                    }

                    if (Date.now() - start > 15_000) {
                        clearInterval(timer);
                        reject(new Error(`[SubFluent] timeout: ${label}`));
                    }
                } catch (e) {
                    clearInterval(timer);
                    reject(e);
                }
            }, 300);
        });
    }

    // ===== 3) 메인: appContext -> videoPlayer -> sessionId -> player =====
    // NOTE: 회차 전환 등으로 player를 다시 잡아야 할 때, 연속 호출로 중복 폴링/중복 콜백이 발생할 수 있음.
    // page world 전역 플래그로 "재초기화 진행 중"이면 스킵한다.
    async function initPlayerChain(callback: () => void) {
        const ns = (window as any)[PAGE_NS];
        ns.hooks ??= {};

        // 중복 재초기화 방지 (fire-and-forget 재호출 대비)
        if (ns.hooks.initPlayerChainInFlight) {
            console.log("[SubFluent] initPlayerChain already in-flight. skip.");
            return null;
        }

        ns.hooks.initPlayerChainInFlight = true;
        ns.hooks.initPlayerChainInFlightAt = Date.now();

        try {
            // A) appContext
            const appContext = await pollUntil<any>(() => {
                const netflix = (window as any).netflix;
                return netflix?.appContext;
            }, "appContext");

            // B) videoPlayer (appContext 있어도 videoPlayer가 늦게 생길 수 있음)
            const videoPlayer = await pollUntil<any>(() => {
                return appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
            }, "videoPlayer");

            // C) sessionId (재생 세션 생길 때까지)
            const sessionId = await pollUntil<string>(() => {
                return videoPlayer?.getAllPlayerSessionIds?.()?.[0];
            }, "sessionId");

            // D) player (sessionId로 player 인스턴스가 나올 때까지)
            const player = await pollUntil<any>(() => {
                return videoPlayer?.getVideoPlayerBySessionId?.(sessionId);
            }, "player");

            playerFacade = createPlayerFacade(player);
            callback();
            return playerFacade;
        } catch (e) {
            console.warn("[SubFluent] initPlayerChain failed:", e);
            return null;
        } finally {
            // 반드시 해제 (실패/성공 모두)
            ns.hooks.initPlayerChainInFlight = false;
        }
    }

    function sendMessageToContentScript() {
        const post = (data: any) => window.postMessage({ source: SRC, ...data }, "*");

        const looksLikeTtml = (text: string): boolean => {
            const head = text.trimStart().slice(0, 200).toLowerCase();
            return head.startsWith("<tt") || head.includes("<tt ") || head.includes("<tt>");
        };

        const getLangFromTtml = (ttml: string): string | null => {
        // <tt ... xml:lang="vi"> 또는 xml:lang='vi'
            const m = ttml.match(/<tt\b[^>]*\bxml:lang\s*=\s*["']([^"']+)["']/i);
            return m?.[1]?.toLowerCase() ?? null;
        };

        type HookSetting = {
            host: string;
            pathIncludes: string;
            requiredParams: readonly string[];
        };

        const isHookingUrl = (rawUrl: string, setting: HookSetting): boolean => {
            try {
                const u = new URL(rawUrl, window.location.href);

                if (u.protocol !== "https:") return false;
                if (!u.hostname.endsWith(setting.host)) return false;
                if (!u.pathname.includes(setting.pathIncludes)) return false;
                if (!setting.requiredParams.every((p) => u.searchParams.has(p))) return false;

                return true;
            } catch {
                return false;
            }
        };

        const getMainContentViewableId = (rawUrl: string): string | null => {
            try {
                const u = new URL(rawUrl, window.location.href);
                return u.searchParams.get("mainContentViewableId");
            } catch {
                return null;
            }
        };

        (async function initHook(callback: () => Promise<void>) {
            const hookingSettings: Record<"ttmlXhrHook" | "licensedManifestXhrHook", HookSetting> = {
                ttmlXhrHook: {
                    host: ".nflxvideo.net",
                    pathIncludes: "/",
                    requiredParams: ["o", "v", "e", "t"],
                },
                licensedManifestXhrHook: {
                    host: "www.netflix.com",
                    pathIncludes: "/msl/playapi/cadmium/licensedmanifest/1",
                    requiredParams: [
                        "reqAttempt",
                        "reqName",
                        "reqId",
                        "mainContentViewableId",
                        "clienttype",
                        "uiversion",
                        "browsername",
                        "browserversion",
                        "osname",
                        "osversion",
                    ],
                },
            };

            const origOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function (
                this: XMLHttpRequest,
                method: string,
                url: string | URL,
                async?: boolean,
                user?: string | null,
                password?: string | null
            ) {
                (this as any).__subfluent_url = String(url);
                return origOpen.call(this, method, url as any, async as any, user as any, password as any);
            };

            const origSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | BodyInit | null) {
                this.addEventListener("load", () => {
                    try {
                        const url = String((this as any).__subfluent_url || "");
                        const ct = this.getResponseHeader("content-type") || "";

                        // 1) Licensed Manifest hook (episode start / switching)
                        if (isHookingUrl(url, hookingSettings.licensedManifestXhrHook)) {
                            if (!playerFacade?.getReady?.()) {
                                console.log("[SubFluent] player not ready yet. try re-init player chain.");
                                // fire-and-forget: in-flight 가드가 있으니 연속 호출되어도 1번만 돈다.
                                //initPlayerChain(getDownloadableTrackList);
                            }
                            const trackId = getMainContentViewableId(url);
                            const respText = typeof (this as any).responseText === "string" ? (this as any).responseText : "";
                            console.log("[SubFluent] checking URL for hooking:", url);
                            post({
                                type: "LOAD_SUBTITLE",
                                url,
                                trackId,
                                status: (this as any).status,
                                contentType: ct,
                                responseText: respText,
                                via: "xhr",
                            });
                            return;
                        }

                        // 2) TTML hook (timed text)
                        if (isHookingUrl(url, hookingSettings.ttmlXhrHook)) {
                            const isXml = ct.includes("text/xml") || ct.includes("application/xml");
                            if (isXml) {
                                const maybeText = typeof (this as any).responseText === "string" ? (this as any).responseText : "";
                                const bcp47 = getLangFromTtml(maybeText)
                                const isBcp47Match = TEST_LANG.includes(bcp47 ?? "");
                                console.log("[SubFluent] bcp47 = ",bcp47," ",isBcp47Match)
                                if (maybeText && looksLikeTtml(maybeText) && isBcp47Match) {
                                    const langType = bcp47 == learningLang ? "::l" : "::n";
                                    post({ type: "TTML_TEXT", langType: langType, ttml: maybeText });
                                    return;
                                }
                            }
                        }
                    } catch(e) {
                        console.log("SubFluent: error in XHR hook : ", e);
                    }
                });

                return origSend.call(this, body as any);
            };
            post({ type: "HOOK_READY", hooks: ["TTML_XHR", "LICENSEDMANIFEST_XHR"] });
            try {
                await callback();
            } catch (e) {
                console.warn("[SubFluent] initHook callback failed:", e);
            }
        }(getDownloadableTrackList));

        // expose for initPlayerChain callback (so we can trigger it once player is ready)
        (window as any)[PAGE_NS].hooks.getDownloadableTrackList = getDownloadableTrackList;

        async function getDownloadableTrackList(): Promise<void> {
            const trackList = await pollUntil<any[]>(() => {
                const list = playerFacade?.getTimedTextTrackList?.();
                return Array.isArray(list) && list.length > 0 ? list : null;
            }, "TTML tracks");

            console.log("[SubFluent] fetched timed text track list:", trackList);
            const fiteredTracks = trackList?.filter((track: any) => {
                const lang = track?.bcp47?.toLowerCase() || "";
                return TEST_LANG.includes(lang);
            });
            console.log("[SubFluent] filtered timed text tracks:", fiteredTracks);
            requestTTMLForTrack(fiteredTracks);
        }

        function requestTTMLForTrack(trackList: any[]) {
            if (!trackList?.length) {
                console.log("[SubFluent] no matching timed text tracks found");
                return;
            }

            for (const track of trackList) {
                console.log("[SubFluent] requesting timed text track:", track);
                try {
                    playerFacade.setTimedTextTrack(track);
                } catch (e) {
                    console.warn("[SubFluent] setTimedTextTrack failed:", e);
                }
            }
        }
    }
    
    // 1) Install XHR hooks ASAP (avoid missing the very first licensedManifest on initial load)
    sendMessageToContentScript();

    // 2) Initialize player separately; once ready, kick track list fetch if available
    initPlayerChain(() => {
    });
})();