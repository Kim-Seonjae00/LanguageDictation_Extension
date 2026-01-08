// src/content/pageHook.ts

(function () {
    const SRC = "SubFluent";
    const TEST_LANG = ["es", "ko"]
    let player: any = null;
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
    async function initPlayerChain(callback: (player: any) => void) {
        try {
            // A) appContext
            const appContext = await pollUntil<any>(() => {
                const netflix = (window as any).netflix;
                return netflix?.appContext;
            }, "appContext" );

            // B) videoPlayer (appContext 있어도 videoPlayer가 늦게 생길 수 있음)
            const videoPlayer = await pollUntil<any>(() => {
                return appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
            }, "videoPlayer");

            // C) sessionId (재생 세션 생길 때까지)
            const sessionId = await pollUntil<string>(() => {
                return videoPlayer?.getAllPlayerSessionIds?.()?.[0];
            }, "sessionId");

            // D) player (sessionId로 player 인스턴스가 나올 때까지)
            player = await pollUntil<any>(() => {
                return videoPlayer?.getVideoPlayerBySessionId?.(sessionId);
            }, "player");

            // ===== 4) (선택) sessionId 변경 감시: 다음화/전환 대비 =====
            watchSessionChanges(videoPlayer, sessionId);
            callback(player)
        } catch (e) {
            console.warn("[SubFluent] initPlayerChain failed:", e);
            return null;
        }
    }

    // ===== 4) (선택) sessionId가 바뀌면 다시 player 잡기 =====
    function watchSessionChanges(videoPlayer: any, initialSessionId: string) {
        let current = initialSessionId;

        setInterval(async () => {
            try {
                const next = videoPlayer?.getAllPlayerSessionIds?.()?.[0];
                if (!next || next === current) return;
                current = next;

                player = await pollUntil<any>(() => {
                    return videoPlayer?.getVideoPlayerBySessionId?.(current);
                }, "player (after session change)");
            } catch (e) {
                console.warn("[SubFluent] watchSessionChanges error:", e);
            }
        }, 500);
    }
    

    function sendMessageToContentScript(player : any) { 
        const post = (data: any) => window.postMessage({ source: SRC, ...data }, "*");

        const looksLikeTtml = (text: string): boolean => {
            const head = text.trimStart().slice(0, 200).toLowerCase();
            return head.startsWith("<tt") || head.includes("<tt ") || head.includes("<tt>");
        };

        const isTtmlCandidateUrl = (rawUrl: string): boolean => {
            try {
                const u = new URL(rawUrl, window.location.href);

                // Netflix timed-text URLs we care about are https and come from *.nflxvideo.net
                if (u.protocol !== "https:") return false;
                if (!u.hostname.endsWith(".nflxvideo.net")) return false;

                // Heuristic based on your sample: query params must include o, v, e, t
                const o = u.searchParams.get("o");
                const v = u.searchParams.get("v");
                const e = u.searchParams.get("e");
                const t = u.searchParams.get("t");
                if (!o || !v || !e || !t) return false;

                return true;
            } catch {
                return false;
            }
        };

        (function initHook(callback:() => void) {
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
                        const isNflx = isTtmlCandidateUrl(url);
                        const isXml = ct.includes("text/xml") || ct.includes("application/xml");
                        if (isNflx && isXml) {
                            const maybeText = typeof (this as any).responseText === "string" ? (this as any).responseText : "";
                            if (maybeText && looksLikeTtml(maybeText)) {
                                post({ type: "TTML_TEXT", url, contentType: ct, ttml: maybeText });
                                return;
                            }
                        }
                    } catch {
                        console.log("SubFluent: error in XHR hook");
                    }
                });
                return origSend.call(this, body as any);
            };
        

            post({ type: "HOOK_READY" });
            callback();
        }(requestSubtitleTrack));

        function requestSubtitleTrack() {
            const trackList = player?.getTimedTextTrackList?.().filter((track: any) => {
                const lang = track?.bcp47?.toLowerCase() || "";
                return TEST_LANG.includes(lang);
            });

            if (trackList?.length > 0) {
                for (const track of trackList) {
                    console.log("[SubFluent] requesting timed text track:", track);
                    player.setTimedTextTrack(track);
                }
            }
        }
    }

    initPlayerChain(sendMessageToContentScript);
})();