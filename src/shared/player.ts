export type PlayerFacade = {
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
        seek: (time: any) => any;
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
        getAudioTrackList?: (h: any) => any;
        setAudioTrack?: (track: any) => Promise<any>;

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