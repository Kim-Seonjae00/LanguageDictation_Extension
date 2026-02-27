// src/content/pageHook.ts
import { setSubFluentLogLevel, subFluentDebug, subFluentError, subFluentInfo } from "../shared/util";
import type { PlayerFacade } from "../shared/player";
import type { TimedTextTrackMeta } from "./state/contentState";

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
    const isWatch = () => location.pathname.startsWith("/watch/");
    let playerFacade: any = null; // raw Netflix player (live object)

    // --- TimedText helpers and request cache ---
    type TimedTextKind = "CC" | "SUBS" | "FORCED" | "NONE" | "UNKNOWN";

    const norm = (s: string | null | undefined) => String(s || "").toLowerCase();
    const primary = (s: string) => norm(s).split("-")[0];

    const kindFromNttmTextType = (nttmTextTypeRaw: string): TimedTextKind => {
        const t = String(nttmTextTypeRaw || "").trim().toUpperCase();
        if (!t) return "UNKNOWN";
        if (t.includes("FORCED")) return "FORCED";
        if (t.startsWith("CC") || t.includes("CAPTION")) return "CC";
        if (t.startsWith("SUB") || t.includes("SUBTITLE")) return "SUBS";
        return "UNKNOWN";
    };

    const toTrackMeta = (t: any): TimedTextTrackMeta => {
        return {
            bcp47: t?.bcp47 != null ? String(t.bcp47).trim().toLowerCase() : null,
            trackType: t?.trackType != null ? String(t.trackType).trim().toLowerCase() : null,
            rawTrackType: t?.rawTrackType != null ? String(t.rawTrackType).trim().toLowerCase() : null,
        };
    };

    // Prefetch TTML cache (first-load / non-requested TTML)
    // We assume prefetch is at most one meaningful item per first-load.
    type PrefetchTrack = {
        key: string;
        meta: TimedTextTrackMeta;
        ttml: string;
        at: number;
    };

    const setPrefetchTrack = (t: PrefetchTrack | null) => {
        const hooks = g[PAGE_NS].hooks;
        hooks.prefetchTimedText = t;
    };

    const consumePrefetchTrack = (): PrefetchTrack | null => {
        const hooks = g[PAGE_NS].hooks;
        const t = (hooks.prefetchTimedText as PrefetchTrack | null) ?? null;
        hooks.prefetchTimedText = null;
        return t;
    };

    // Best-effort synthesize meta when we didn't initiate a request.
    // NOTE: TTML may miss xml:lang; in that case bcp47 can be null.
    const synthesizeMetaFromTtml = (bcp47: string | null, kind: TimedTextKind): TimedTextTrackMeta => {
        const b = bcp47 != null ? String(bcp47).trim().toLowerCase() : null;

        // Minimal, stable-ish defaults from observed kind
        // (Used only for prefetch cache keys; requested flows use real player track meta.)
        if (kind === "CC") {
            return { bcp47: b, trackType: "assistive", rawTrackType: "closedcaptions" };
        }
        if (kind === "SUBS") {
            return { bcp47: b, trackType: "primary", rawTrackType: "subtitles" };
        }
        if (kind === "FORCED") {
            return { bcp47: b, trackType: "primary", rawTrackType: "forcednarrative" };
        }

        return { bcp47: b, trackType: null, rawTrackType: null };
    };

    const setRequestedTimedText = (items: TimedTextTrackMeta[]) => {
        g[PAGE_NS].hooks.requestedTimedText = items;
        g[PAGE_NS].hooks.requestedTimedTextAt = Date.now();
    };

    const getRequestedTimedText = (): TimedTextTrackMeta[] => {
        const items = g[PAGE_NS]?.hooks?.requestedTimedText;
        return Array.isArray(items) ? items : [];
    };

    const consumeRequestedTimedTextAtIndex = (index: number): TimedTextTrackMeta | null => {
        const items = getRequestedTimedText();
        if (!Array.isArray(items) || items.length === 0) return null;
        if (index < 0 || index >= items.length) return null;

        const removed = items.splice(index, 1)[0] || null;
        // Persist the mutated array back (keep lifecycle consistent)
        setRequestedTimedText(items);
        return removed;
    };

    const matchRequestedTimedText = (
        bcp47: string | null,
        kind: TimedTextKind
    ): { meta: TimedTextTrackMeta; index: number } | null => {
        const req = getRequestedTimedText();
        if (req.length === 0) return null;

        const b = bcp47 ? norm(bcp47) : "";
        const pb = b ? primary(b) : "";

        // Map observed kind -> expected rawTrackType token (best-effort)
        const wantRawToken = kind === "CC" ? "caption" : kind === "SUBS" ? "sub" : kind === "FORCED" ? "forced" : "";

        const findIndex = (pred: (r: TimedTextTrackMeta) => boolean): number => {
            for (let i = 0; i < req.length; i++) {
                if (pred(req[i])) return i;
            }
            return -1;
        };

        const rawHas = (r: TimedTextTrackMeta) => {
            const raw = norm(r?.rawTrackType);
            if (!wantRawToken) return true; // unknown kind: don't filter by raw
            return raw.includes(wantRawToken);
        };

        // priority:
        // 1) exact bcp47 + raw-kind match
        // 2) primary(bcp47) + raw-kind match
        // 3) exact bcp47
        // 4) primary(bcp47)
        let idx = findIndex((r) => norm(r?.bcp47) === b && rawHas(r));
        if (idx >= 0) return { meta: req[idx], index: idx };

        idx = findIndex((r) => primary(norm(r?.bcp47)) === pb && rawHas(r));
        if (idx >= 0) return { meta: req[idx], index: idx };

        idx = findIndex((r) => norm(r?.bcp47) === b);
        if (idx >= 0) return { meta: req[idx], index: idx };

        idx = findIndex((r) => primary(norm(r?.bcp47)) === pb);
        if (idx >= 0) return { meta: req[idx], index: idx };

        return null;
    };

    // --- TTML sequencing helpers ---
    // We want to setTimedTextTrack() one-by-one and only move to the next
    // after the XHR hook has forwarded TTML_TEXT to the content script.
    type TtmlWaiter = {
        resolve: () => void;
        reject: (e: any) => void;
        timer: any;
    };

    const getTtmlWaiters = (): TtmlWaiter[] => {
        const hooks = g[PAGE_NS].hooks;
        if (!hooks.ttmlWaiters) hooks.ttmlWaiters = [];
        return hooks.ttmlWaiters as TtmlWaiter[];
    };

    const hasPendingTtmlWaiter = (): boolean => {
        try {
            const q = getTtmlWaiters();
            return Array.isArray(q) && q.length > 0;
        } catch {
            return false;
        }
    };

    const notifyNextTtmlArrived = () => {
        const q = getTtmlWaiters();
        const w = q.shift();
        if (!w) return;
        try {
            clearTimeout(w.timer);
        } catch {
            // ignore
        }
        w.resolve();
    };

    const waitForNextTtmlForward = (timeoutMs = 8000): Promise<void> => {
        return new Promise<void>((resolve, reject) => {
            const q = getTtmlWaiters();
            const w: TtmlWaiter = {
                resolve,
                reject,
                timer: setTimeout(() => {
                    try {
                        // remove self if still queued
                        const idx = q.indexOf(w);
                        if (idx >= 0) q.splice(idx, 1);
                    } catch {
                        // ignore
                    }
                    reject(new Error("timeout waiting for TTML_TEXT"));
                }, timeoutMs),
            };
            q.push(w);
        });
    };
    // --- TTML sequencing helpers end ---


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
            seek: (time: any) => p?.seek?.(time),
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
            getAudioTrackList: (h: any) => p?.getAudioTrackList?.(h),
            setAudioTrack: (track: any) => p?.setAudioTrack?.(track),

            // --- text / timed text ---
            getTextTrack: () => p?.getTextTrack?.(),
            getTextTrackList: (h?: any) => p?.getTextTrackList?.(h),
            setTextTrack: (track: any) => p?.setTextTrack?.(track),

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

    window.addEventListener("message", (event) => {
        const d = event.data;
        if (!d || d.source !== SRC) return;
        if (d.type === "PLAYER_SEEK") playerFacade?.seek(d.start?d.start:playerFacade.getCurrentTime() - 250);

        // removed duplicate norm/primary declarations; now using top-level helpers

        const desiredBcp47 = norm(d.audioBcp47);
        const desiredTrackId = String(d.trackId || "");

        const findByTrackId = (id: string, list:any[]): any | null => {
            if (!id) return null;
            return list.find((t) => String(t?.trackId || "") === id) || null;
        };

        const findByBcp47 = (b: string, list:any[]): any | null => {
            if (!b) return null;
            const pb = primary(b);
            return (
                list.find((t) => norm(t?.bcp47) === b) ||
                list.find((t) => primary(norm(t?.bcp47)) === pb) ||
                null
            );
        };
        if (d.type === "SF_REQUEST_TimedText") {
            if (!playerFacade?.setTimedTextTrack) return;
            // NOTE: do NOT trust track objects coming from postMessage (structured clone breaks them).
            // Always resolve real track objects from the live player list in page world.
            const list = playerFacade?.getTimedTextTrackList?.() as any[] | undefined;
            if (!Array.isArray(list) || list.length === 0) {
                return;
            }

            type ReqItem = {
                subType: "learning" | "translate";
                key?: string;
                meta?: TimedTextTrackMeta;
            };

            const hasItems = Array.isArray(d.items) && d.items.length > 0;

            const resolveTimedTextTrackByMeta = (m: any, tracks: any[]): any | null => {
                if (!m) return null;
                const b = norm(m?.bcp47);
                if (!b) return null;
                const pb = primary(b);
                const wantTrackType = m?.trackType != null ? String(m.trackType) : "";
                const wantRaw = m?.rawTrackType != null ? String(m.rawTrackType) : "";

                const eqTrackType = (t: any) => (wantTrackType ? String(t?.trackType || "") === wantTrackType : true);
                const eqRaw = (t: any) => (wantRaw ? String(t?.rawTrackType || "") === wantRaw : true);

                // priority:
                // 1) exact bcp47 + raw + trackType
                // 2) primary(bcp47) + raw + trackType
                // 3) exact bcp47 + raw
                // 4) primary(bcp47) + raw
                // 5) exact bcp47
                // 6) primary(bcp47)
                const find = (pred: (t: any) => boolean) => tracks.find(pred) || null;

                return (
                    find((t) => norm(t?.bcp47) === b && eqRaw(t) && eqTrackType(t)) ||
                    find((t) => primary(norm(t?.bcp47)) === pb && eqRaw(t) && eqTrackType(t)) ||
                    find((t) => norm(t?.bcp47) === b && eqRaw(t)) ||
                    find((t) => primary(norm(t?.bcp47)) === pb && eqRaw(t)) ||
                    find((t) => norm(t?.bcp47) === b) ||
                    find((t) => primary(norm(t?.bcp47)) === pb) ||
                    null
                );
            };

            if (hasItems) {
                const items = (d.items as ReqItem[]).filter((it) => it && it.meta);
                // Build a plain-meta snapshot of the tracks we are about to request.
                // We will use this later in the TTML XHR hook to classify TTML_TEXT without relying on getTimedTextTrack() timing.
                try {
                    const metas: TimedTextTrackMeta[] = [];

                    for (const it of items) {
                        const t = resolveTimedTextTrackByMeta(it.meta, list);
                        if (!t) continue;
                        metas.push(toTrackMeta(t));
                    }

                    // Persist requested context (can be empty)
                    setRequestedTimedText(metas);
                } catch (e) {
                    subFluentError("[pageHook] failed to build requested timedText metas", e);
                }

                (async () => {
                    try {
                        const seen = new Set<string>();
                        let lastTrackId = "";
                        for (const it of items) {
                            const track = resolveTimedTextTrackByMeta(it.meta, list);
                            if (!track) continue;

                            const tid = String(track?.trackId || "");
                            // If multiple items map to the same underlying track, Netflix may NOT refetch TTML.
                            // In that case waiting for TTML_TEXT would timeout, so we dedupe by trackId.
                            if (tid && seen.has(tid)) {
                                continue;
                            }
                            if (tid) seen.add(tid);

                            try {
                                await Promise.resolve(playerFacade.setTimedTextTrack(track));

                                // If track didn't actually change, don't wait for a new TTML network fetch.
                                if (tid && tid === lastTrackId) {
                                    continue;
                                }
                                lastTrackId = tid;

                                await waitForNextTtmlForward(10_000);
                            } catch (e) {
                                subFluentError(
                                    "[pageHook] setTimedTextTrack/TTML sequencing failed (items):",
                                    { subType: it.subType, bcp47: it?.meta?.bcp47, trackId: track?.trackId },
                                    e
                                );
                            }
                        }
                    } finally {
                        setRequestedTimedText([]);
                    }
                })();

                return;
            }

            // -----------------------------
            // Legacy protocol fallback
            // -----------------------------
            const learning = norm(d.learning);
            const translate = norm(d.translate);

            const langs = [learning, translate].filter(Boolean);
            if (langs.length === 0) {
                return;
            }

            // Build a plain-meta snapshot of the tracks we are about to request.
            // We will use this later in the TTML XHR hook to classify TTML_TEXT without relying on getTimedTextTrack() timing.
            try {
                const metas: TimedTextTrackMeta[] = [];
                const learningTrack = learning ? findByBcp47(learning, list) : null;
                const translateTrack = translate ? findByBcp47(translate, list) : null;

                if (learningTrack) metas.push(toTrackMeta(learningTrack));
                if (translateTrack) metas.push(toTrackMeta(translateTrack));

                // Fallback: if we couldn't resolve either, keep empty.
                setRequestedTimedText(metas);
            } catch (e) {
                subFluentError("[pageHook] failed to build requested timedText metas", e);
            }

            (async () => {
                try {
                    const seen = new Set<string>();
                    let lastTrackId = "";
                    for (const b of langs) {
                        const track = findByBcp47(b, list);
                        if (!track) continue;

                        const tid = String(track?.trackId || "");
                        if (tid && seen.has(tid)) continue;
                        if (tid) seen.add(tid);

                        try {
                            await Promise.resolve(playerFacade.setTimedTextTrack(track));

                            if (tid && tid === lastTrackId) {
                                continue;
                            }
                            lastTrackId = tid;

                            await waitForNextTtmlForward(10_000);
                        } catch (e) {
                            subFluentError("[pageHook] setTimedTextTrack/TTML sequencing failed:", { bcp47: b, trackId: track?.trackId }, e);
                        }
                    }
                } finally {
                    setRequestedTimedText([]);
                }
            })();
        }
        if (d.type === "PLAYER_SetAudio") {
            if (!playerFacade?.setAudioTrack) return;

            // priority: explicit trackId > bcp47
            const list = playerFacade?.getAudioTrackList()
            const track = findByTrackId(desiredTrackId, list) || findByBcp47(desiredBcp47, list);
            if (!track) return;

            try {
                // Normalize promise/void return
                Promise.resolve(playerFacade.setAudioTrack(track))
                    .catch((e) => {
                        subFluentError("[pageHook] setAudioTrack failed:", { bcp47: desiredBcp47, trackId: desiredTrackId }, e);
                    });
                initializeTextTrack();
            } catch (e) {
                subFluentError("[pageHook] setAudioTrack threw:", { bcp47: desiredBcp47, trackId: desiredTrackId }, e);
            }
        }
    });

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

    const initializeTextTrack = () => {
        // Guard: playerFacade must exist
        if (!playerFacade?.setTimedTextTrack) return;

        const trackList = playerFacade?.getTimedTextTrackList();
        if (!Array.isArray(trackList) || trackList.length === 0) return;

        const noneTrack = trackList.find(isNoneTimedTextTrack) || null;
        if (!noneTrack) {
            return;
        }

        try {
           // playerFacade.setTimedTextTrack(noneTrack);
           subFluentDebug("pass initialize");
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

    async function initPlayerChain() {
        const ns = (window as any)[PAGE_NS];
        ns.hooks ??= {};
        
        if (ns.hooks.initPlayerChainInFlight) {
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
                const list = player?.getTimedTextTrackList?.();
                return Array.isArray(list) && list.length > 0 ? list : null;
            }, "trackList");

            const audioList = await pollUntil<any[]>(() => {
                const list = player?.getAudioTrackList?.();
                return Array.isArray(list) && list.length > 0 ? list : null;
            }, "audioList");
            
            playerFacade = createPlayerFacade(player);
            const currentTrack = playerFacade.getTimedTextTrack?.();
            const currentAudio = playerFacade.getAudioTrack?.();

            // Initialize to NONE(Off/끄기) once playerFacade is ready
            initializeTextTrack();
            // Prepare PREFETCH TTML payload to include in PLAYER_READY (do NOT post TTML_TEXT before ready)
            // Most-recent-first so content can optionally apply latest cached subtitles first.
            // Prepare PREFETCH TTML payload to include in PLAYER_READY (do NOT post TTML_TEXT before ready)
            let prefetchTimedText: PrefetchTrack | null = null;
            try {
                prefetchTimedText = consumePrefetchTrack();
            } catch (e) {
                subFluentError("[pageHook] failed to prepare PREFETCH for PLAYER_READY", e);
            }
            // If we have a prefetched TTML but no reliable meta yet, attach meta from the current timed-text track.
            if (prefetchTimedText && prefetchTimedText.meta) {
                const b = currentTrack?.bcp47 != null ? String(currentTrack.bcp47).trim().toLowerCase() : null;
                const tt = currentTrack?.trackType != null ? String(currentTrack.trackType).trim().toLowerCase() : null;
                const raw = currentTrack?.rawTrackType != null ? String(currentTrack.rawTrackType).trim().toLowerCase() : null;

                if (b) prefetchTimedText.meta.bcp47 = b;
                if (tt) prefetchTimedText.meta.trackType = tt;
                if (raw) prefetchTimedText.meta.rawTrackType = raw;
            }
            
            subFluentDebug(prefetchTimedText, playerFacade.getTimedTextTrack());
            post({
                type: "PLAYER_READY",
                movieId: playerFacade.getMovieId(),
                currentTrack: currentTrack,
                currentAudio: currentAudio,
                trackList: trackList,
                audioList: audioList || [],
                prefetchTimedText,
            });
            
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

                            initPlayerChain();
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

    function sendMessageToContentScript() {
        const looksLikeTtml = (text: string): boolean => {
            const head = text.trimStart().slice(0, 200).toLowerCase();
            return head.startsWith("<tt") || head.includes("<tt ") || head.includes("<tt>");
        };

        const readXhrResponseTextSafe = (xhr: XMLHttpRequest): string => {
            try {
                const rt = (xhr as any).responseType as string;
                // responseText is only valid for "" or "text"
                if (!rt || rt === "text") {
                    return typeof (xhr as any).responseText === "string" ? (xhr as any).responseText : "";
                }
                if (rt === "arraybuffer") {
                    const buf = (xhr as any).response;
                    if (buf && buf instanceof ArrayBuffer) {
                        try {
                            return new TextDecoder("utf-8").decode(new Uint8Array(buf));
                        } catch {
                            // Fallback: best-effort latin1 style decode
                            let s = "";
                            const u8 = new Uint8Array(buf);
                            for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
                            return s;
                        }
                    }
                    return "";
                }
                // blob/document/json etc. are ignored here
                return "";
            } catch {
                return "";
            }
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
                // Only attach our load listener for timed-text candidate requests.
                // This avoids touching unrelated Netflix endpoints (e.g., msl_v1 router) and reduces noise.
                const url = String((this as any).__subfluent_url || "");
                const shouldAttach = url.includes(".nflxvideo.net");

                if (shouldAttach && !(this as any).__subfluent_loadAttached) {
                    (this as any).__subfluent_loadAttached = true;

                    this.addEventListener("load", () => {
                        try {
                            let ct = "";
                            try {
                                ct = this.getResponseHeader("content-type") || "";
                            } catch {
                                ct = "";
                            }

                            // TTML hook (timed text)
                            if (isHookingUrl(url, hookingSettings.ttmlXhrHook)) {
                                const isXmlLike =
                                    ct.includes("text/xml") || ct.includes("application/xml") || ct.includes("application/octet-stream");
                                if (isXmlLike) {
                                    const maybeText = readXhrResponseTextSafe(this as any);
                                    if (maybeText && looksLikeTtml(maybeText) && isWatch()) {
                                        // If we have no explicit requested list (and no pending waiter), treat it as PREFETCH.
                                        // Prefetch may happen before playerFacade is ready, so store with empty meta/movieId.
                                        const req = getRequestedTimedText();
                                        const isRequestedFlow = (Array.isArray(req) && req.length > 0) || hasPendingTtmlWaiter();

                                        if (!isRequestedFlow) {
                                            try {
                                                const prefetchMeta: TimedTextTrackMeta = { bcp47: null, trackType: null, rawTrackType: null };
                                                const key = `prefetch:${Date.now()}`;
                                                setPrefetchTrack({ key, meta: prefetchMeta, ttml: maybeText, at: Date.now() });
                                            } catch (e) {
                                                subFluentError("[pageHook] failed to cache PREFETCH TTML", e);
                                            }
                                            return;
                                        }

                                        // Requested TTML: derive meta from current live player timedText track.
                                        let outgoingMeta: TimedTextTrackMeta | null = null;
                                        let movieId: string | null = null;
                                        try {
                                            movieId = playerFacade?.getMovieId?.()
                                                ? playerFacade.getMovieId?.()
                                                : extractNumericId(location.pathname);
                                        } catch {
                                            movieId = extractNumericId(location.pathname);
                                        }
                                        try {
                                            const live = playerFacade?.getTimedTextTrack?.();
                                            outgoingMeta = live ? toTrackMeta(live) : null;
                                        } catch {
                                            outgoingMeta = null;
                                        }

                                        post({
                                            type: "TTML_TEXT",
                                            ttml: maybeText,
                                            movieId: movieId,
                                            trackMeta: outgoingMeta,
                                        });

                                        // Notify the sequencer that a TTML has been forwarded.
                                        notifyNextTtmlArrived();
                                        return;
                                    }
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
    }

    // 1) Initialize player separately; once ready, kick track list fetch if available
    sendMessageToContentScript();
    initPlayerChain();
})();
