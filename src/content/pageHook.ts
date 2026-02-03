// src/content/pageHook.ts
import { setSubFluentLogLevel, subFluentDebug, subFluentError } from "../shared/util";
setSubFluentLogLevel("DEBUG"); // 개발 중
// setSubFluentLogLevel("INFO"); // 평소
// setSubFluentLogLevel("WARN"); // 배포
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
    const isWatch = () => location.pathname.startsWith("/watch/");

    let playerFacade: any = null; // raw Netflix player (live object)

    type PlayerFacade = {
        // --- core / ids ---
        getMovieId: () => any;
        getXid?: () => any;
        getPlaybackContextId?: () => any;

        // --- readiness / state ---
        getReady: () => boolean;
        isReady?: () => boolean;
        getBusy?: () => any;

        // --- playback basic ---
        getCurrentTime?: () => number;
        getBufferedTime?: () => number;
        getDuration?: () => number;
        getPaused?: () => boolean;
        getPlaying?: () => boolean;
        isPaused?: () => boolean;
        isPlaying?: () => boolean;
        getEnded?: () => boolean;
        isEnded?: () => boolean;
        getMuted?: () => boolean;
        isMuted?: () => boolean;
        getVolume?: () => number;
        getPlaybackRate?: () => number;

        // --- playback navigation / segments / tricks ---
        getSegmentTime?: () => any;
        getTimeCodes?: () => any;
        goToNextSegment?: (h: any, k: any) => any;
        getTrickPlayFrame?: (h: any) => any;

        // --- element / sizing ---
        getElement?: () => any;
        getVideoSize?: () => any;
        getCropAspectRatio?: () => any;

        // --- diagnostics / logs / errors ---
        getError?: () => any;
        induceError?: (h: any) => any;
        getDiagnostics?: () => any;
        getAdditionalLogInfo?: () => any;

        // --- audio ---
        getAudioTrack?: () => any;
        getAudioTrackList?: () => any;
        getMaxRecommendedAudioIndex?: () => any;

        // --- text / timed text ---
        getTextTrack?: () => any;
        getTextTrackList?: (h: any) => any;

        getTimedTextTrack: () => any;
        getTimedTextTrackList: (h?: any) => any;
        setTimedTextTrack: (track: any) => Promise<any>;

        getTimedTextSettings?: () => any;
        getTimedTextVisibility?: () => any;

        getMaxRecommendedTextIndex?: (h: any) => any;
        getMaxRecommendedTimedTextIndex?: (h: any) => any;

        // --- managers ---
        getAdManager?: () => any;
        getLivePlaybackManager?: () => any;
        getPlaygraphManager?: () => any;

        // --- network / congestion ---
        getCongestionInfo?: (h: any) => any;

        // --- internal (you logged iVa / iVa property) ---
        iVa?: any;
    };

    function createPlayerFacade(p: any): PlayerFacade {
        return {
            // --- core / ids ---
            getMovieId: () => p?.getMovieId?.(),
            getXid: () => p?.getXid?.(),
            getPlaybackContextId: () => p?.getPlaybackContextId?.(),

            // --- readiness / state ---
            getReady: () => p?.getReady?.(),
            isReady: () => p?.isReady?.(),
            getBusy: () => p?.getBusy?.(),

            // --- playback basic ---
            getCurrentTime: () => p?.getCurrentTime?.(),
            getBufferedTime: () => p?.getBufferedTime?.(),
            getDuration: () => p?.getDuration?.(),
            getPaused: () => p?.getPaused?.(),
            getPlaying: () => p?.getPlaying?.(),
            isPaused: () => p?.isPaused?.(),
            isPlaying: () => p?.isPlaying?.(),
            getEnded: () => p?.getEnded?.(),
            isEnded: () => p?.isEnded?.(),
            getMuted: () => p?.getMuted?.(),
            isMuted: () => p?.isMuted?.(),
            getVolume: () => p?.getVolume?.(),
            getPlaybackRate: () => p?.getPlaybackRate?.(),

            // --- playback navigation / segments / tricks ---
            getSegmentTime: () => p?.getSegmentTime?.(),
            getTimeCodes: () => p?.getTimeCodes?.(),
            goToNextSegment: (h: any, k: any) => p?.goToNextSegment?.(h, k),
            getTrickPlayFrame: (h: any) => p?.getTrickPlayFrame?.(h),

            // --- element / sizing ---
            getElement: () => p?.getElement?.(),
            getVideoSize: () => p?.getVideoSize?.(),
            getCropAspectRatio: () => p?.getCropAspectRatio?.(),

            // --- diagnostics / logs / errors ---
            getError: () => p?.getError?.(),
            induceError: (h: any) => p?.induceError?.(h),
            getDiagnostics: () => p?.getDiagnostics?.(),
            getAdditionalLogInfo: () => p?.getAdditionalLogInfo?.(),

            // --- audio ---
            getAudioTrack: () => p?.getAudioTrack?.(),
            getAudioTrackList: () => p?.getAudioTrackList?.(),
            getMaxRecommendedAudioIndex: () => p?.getMaxRecommendedAudioIndex?.(),

            // --- text / timed text ---
            getTextTrack: () => p?.getTextTrack?.(),
            getTextTrackList: (h?: any) => p?.getTextTrackList?.(h),

            getTimedTextTrack: () => p?.getTimedTextTrack?.(),
            getTimedTextTrackList: (h?: any) => p?.getTimedTextTrackList?.(h),
            setTimedTextTrack: (track: any) => p?.setTimedTextTrack?.(track),

            getTimedTextSettings: () => p?.getTimedTextSettings?.(),
            getTimedTextVisibility: () => p?.getTimedTextVisibility?.(),

            getMaxRecommendedTextIndex: (h: any) => p?.getMaxRecommendedTextIndex?.(h),
            getMaxRecommendedTimedTextIndex: (h: any) => p?.getMaxRecommendedTimedTextIndex?.(h),

            // --- managers ---
            getAdManager: () => p?.getAdManager?.(),
            getLivePlaybackManager: () => p?.getLivePlaybackManager?.(),
            getPlaygraphManager: () => p?.getPlaygraphManager?.(),

            // --- network / congestion ---
            getCongestionInfo: (h: any) => p?.getCongestionInfo?.(h),

            // --- internal ---
            iVa: p?.iVa,
        };
    }
    
    const post = (data: any) => {
        window.postMessage({ source: SRC, ...data }, "*");
    };

    const isNoneTimedTextTrack = (t: any): boolean => {
        if (!t) return false;

        // Most reliable flags when present
        if (t?.isNoneTrack === true) return true;
        if (t?.noneTrack === true) return true;

        const id = String(t?.trackId || "");
        // Some titles include explicit NONE token
        if (id.includes("NONE") || id.includes(";NONE;")) return true;

        // displayName varies by locale: 끄기 / Off / None / 자막 끄기
        const name = String(t?.displayName || "");
        if (/(끄기|off|none)/i.test(name)) return true;

        return false;
    };

    const initializeTextTrack = (trackList: any[]) => {
        // Guard: playerFacade must exist
        if (!playerFacade?.setTimedTextTrack) return;
        if (!Array.isArray(trackList) || trackList.length === 0) return;

        const noneTrack = trackList.find(isNoneTimedTextTrack) || null;
        if (!noneTrack) {
            subFluentDebug("[initializeTextTrack] NONE track not found");
            return;
        }

        try {
            playerFacade.setTimedTextTrack(noneTrack);
        } catch (e) {
            subFluentError("[initializeTextTrack] setTimedTextTrack(NONE) failed:", e);
        }
    };

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
                        reject(new Error(`timeout: ${label}`));
                    }
                } catch (e) {
                    clearInterval(timer);
                    reject(e);
                }
            }, 300);
        });
    }

    async function initPlayerChain(callback: () => void) {
        const ns = (window as any)[PAGE_NS];
        ns.hooks ??= {};
        
        if (ns.hooks.initPlayerChainInFlight) {
            subFluentDebug("initPlayerChain already in-flight. skip.");
            return null;
        }
        
        ns.hooks.initPlayerChainInFlight = true;
        ns.hooks.initPlayerChainInFlightAt = Date.now();
        
        try {
            const appContext = await pollUntil<any>(() => {
                const netflix = (window as any).netflix;
                return netflix?.appContext;
            }, "appContext");
            
            const videoPlayer = await pollUntil<any>(() => {
                return appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
            }, "videoPlayer");
            
            const sessionId = await pollUntil<string>(() => {
                return videoPlayer?.getAllPlayerSessionIds?.()?.[0];
            }, "sessionId");
            
            const player = await pollUntil<any>(() => {
                return videoPlayer?.getVideoPlayerBySessionId?.(sessionId);
            }, "player");
            
            const trackList = await pollUntil<any[]>(() => {
                return player?.getTimedTextTrackList?.();
            }, "trackList");
            
            playerFacade = createPlayerFacade(player);

            // Initialize to NONE(Off/끄기) once playerFacade is ready
            initializeTextTrack(trackList);
            post({ type: "PLAYER_READY", movieId: playerFacade.getMovieId?.() });
            callback();
            
            // ---- start monitoring (singleton) ----
            if (!ns.hooks.monitoringTimer) {
                ns.hooks.lastReinitAt ??= 0;

                ns.hooks.monitoringTimer = setInterval(() => {
                    try {
                        if (!playerFacade) return;

                        const notReady = playerFacade.getReady?.() === false;

                        // 쿨다운: 너무 자주 재init 방지
                        if (notReady) {
                            const now = Date.now();
                            if (now - ns.hooks.lastReinitAt < 1500) return;
                            ns.hooks.lastReinitAt = now;

                            subFluentDebug("[monitor] player not ready -> reinit");
                            initPlayerChain(callback);
                        }
                    } catch (e) {
                        subFluentError("[monitor] error", e);
                    }
                }, 200); // 100ms는 너무 빡셈. 200~500ms 추천
            }

            return playerFacade;
        } catch (e) {
            subFluentError("initPlayerChain failed:", e);
            return null;
        } finally {
            ns.hooks.initPlayerChainInFlight = false;
        }
    }

    async function getDownloadableTrackList(): Promise<void> {
        const trackList = await pollUntil<any[]>(() => {
            const list = playerFacade?.getTimedTextTrackList?.();
            return Array.isArray(list) && list.length > 0 ? list : null;
        }, "TTML tracks");

        const fiteredTracks = trackList?.filter((track: any) => {
            const lang = track?.bcp47?.toLowerCase() || "";
            return TEST_LANG.includes(lang);
        });

        requestTTMLForTrack(fiteredTracks, trackList);
    }

    function requestTTMLForTrack(trackList: any[], allTrackList: any[]) {
        if (!playerFacade?.setTimedTextTrack) {
            subFluentDebug("[requestTTMLForTrack] playerFacade not ready. skip.");
            return;
        }
        if (!trackList?.length) {
            subFluentDebug("no matching timed text tracks found");
            return;
        }
        for (const track of trackList) {
            try {
                playerFacade.setTimedTextTrack(track);
            } catch (e) {
                subFluentError("setTimedTextTrack failed:", e);
            }
        }
        initializeTextTrack(allTrackList);
    }

    function sendMessageToContentScript() {
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

        (async function initHook() {
            const ns = (window as any)[PAGE_NS];
            ns.hooks ??= {};
            if (ns.hooks.xhrHookInstalled) {
                return;
            }
            ns.hooks.xhrHookInstalled = true;

            // Keep original methods only once (avoid wrapper-of-wrapper)
            ns.hooks.origXhrOpen ??= XMLHttpRequest.prototype.open;
            ns.hooks.origXhrSend ??= XMLHttpRequest.prototype.send;

            const hookingSettings: Record<"ttmlXhrHook", HookSetting> = {
                ttmlXhrHook: {
                    host: ".nflxvideo.net",
                    pathIncludes: "/",
                    requiredParams: ["o", "v", "e", "t"],
                },
            };

            const origOpen = (window as any)[PAGE_NS].hooks.origXhrOpen as typeof XMLHttpRequest.prototype.open;
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

            function extractNumericId(pathname: string): string | null {
                const m = pathname.match(/(\d+)/);
                return m ? m[1] : null;
            }

            const origSend = (window as any)[PAGE_NS].hooks.origXhrSend as typeof XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | BodyInit | null) {
                // Avoid attaching multiple load listeners if send wrapper is ever re-entered
                if (!(this as any).__subfluent_loadAttached) {
                    (this as any).__subfluent_loadAttached = true;

                    this.addEventListener("load", () => {
                        try {
                            const url = String((this as any).__subfluent_url || "");
                            const ct = this.getResponseHeader("content-type") || "";

                            // 2) TTML hook (timed text)
                            if (isHookingUrl(url, hookingSettings.ttmlXhrHook)) {
                                const isXml = ct.includes("text/xml") || ct.includes("application/xml");
                                if (isXml) {
                                    const maybeText = typeof (this as any).responseText === "string" ? (this as any).responseText : "";
                                    const bcp47 = getLangFromTtml(maybeText)
                                    const isBcp47Match = TEST_LANG.includes(bcp47 ?? "");
                                    const movieId = playerFacade?.getMovieId?.()?playerFacade.getMovieId?.():extractNumericId(location.pathname);

                                    if (maybeText && looksLikeTtml(maybeText) && isBcp47Match && isWatch()) {
                                        const langType = bcp47 == learningLang ? "learning" : "native";
                                        post({ type: "TTML_TEXT", langType: langType, ttml: maybeText, movieId: movieId });
                                        return;
                                    }
                                    // Remove risky re-initialization from every TTML response (it can run before playerFacade exists).
                                    // if(playerFacade != null && playerFacade.getTimedTextTrackList != null){
                                    //     initializeTextTrack(playerFacade.getTimedTextTrackList?.());
                                    // }
                                }
                            }
                        } catch (e) {
                            subFluentError("SubFluent: error in XHR hook : ", e);
                        }
                    });
                }

                return origSend.call(this, body as any);
            };
        }());

        // expose for initPlayerChain callback (so we can trigger it once player is ready)
        (window as any)[PAGE_NS].hooks.getDownloadableTrackList = getDownloadableTrackList;
    }

    // 1) Initialize player separately; once ready, kick track list fetch if available
    sendMessageToContentScript();
    initPlayerChain(getDownloadableTrackList);
})();

