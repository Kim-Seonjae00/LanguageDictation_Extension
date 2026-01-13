// src/content/pageHook.ts

(function () {
    const SRC = "SubFluent";
    const TEST_LANG = ["en", "ko"];
    let playerFacade: any = null; // raw Netflix player (live object)

    type PlayerFacade = {
        getMovieId: () => any;
        getTimedTextTrack: () => any;
        getTimedTextTrackList: () => any;
        setTimedTextTrack: (track: any) => Promise<any>;
        getReady:() => boolean;
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
    async function initPlayerChain(callback: () => void) {
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
        } catch (e) {
            console.warn("[SubFluent] initPlayerChain failed:", e);
            return null;
        }
    }

    function sendMessageToContentScript() {
        const post = (data: any) => window.postMessage({ source: SRC, ...data }, "*");

        const looksLikeTtml = (text: string): boolean => {
            const head = text.trimStart().slice(0, 200).toLowerCase();
            return head.startsWith("<tt") || head.includes("<tt ") || head.includes("<tt>");
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

        (function initHook(callback: () => void) {
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
                            if(!playerFacade?.getReady?.()) {
                                console.log("[SubFluent] player not ready yet, change the player.");
                                initPlayerChain(getDownloadableTrackList);
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
                                const isBcp47Match = TEST_LANG.includes(playerFacade?.getTimedTextTrack()?.bcp47?.toLowerCase() || "");
                                if (maybeText && looksLikeTtml(maybeText) && isBcp47Match) {
                                    post({ type: "TTML_TEXT", url, contentType: ct, ttml: maybeText });
                                    return;
                                }
                            }
                        }
                    } catch {
                        console.log("SubFluent: error in XHR hooka");
                    }
                });

                return origSend.call(this, body as any);
            };


            post({ type: "HOOK_READY", hooks: ["TTML_XHR", "LICENSEDMANIFEST_XHR"] });
            callback();
        }(getDownloadableTrackList));

        async function getDownloadableTrackList() {
            const trackList = await pollUntil<any>(() => {
                return playerFacade?.getTimedTextTrackList?.()
            }, "TTMl");
            console.log("[SubFluent] fetched timed text track list:", trackList);
            const fiteredTracks = trackList?.filter((track: any) => {
                const lang = track?.bcp47?.toLowerCase() || "";
                return TEST_LANG.includes(lang);
            });
            console.log("[SubFluent] filtered timed text tracks:", fiteredTracks);
            requestTTMLForTrack(fiteredTracks);
        }

        async function requestTTMLForTrack(trackList: any[]) {
            if (!trackList?.length) {
                console.log("[SubFluent] no matching timed text tracks found");
                return;
            }

            for (const track of trackList) {
                console.log("[SubFluent] requesting timed text track:", track);
                try {
                    await playerFacade.setTimedTextTrack(track);
                } catch (e) {
                    console.warn("[SubFluent] setTimedTextTrack failed:", e);
                }
            }
        }
    }

    initPlayerChain(sendMessageToContentScript);
})();