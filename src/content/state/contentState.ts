// src/content/state/contentState.ts
// In-memory (non-persistent) state container for the content script.
// NOTE: This is NOT localStorage/chrome.storage. It resets on reload.

import { type TtmlSubtitle } from "../../shared/ttmlParser";

export type LangType = "native" | "learning";

export type SubtitlesState = "waiting0" | "waiting1" | "ready" | "active";

type Unsubscribe = () => void;

type MovieIdListener = (next: string | null, prev: string | null) => void;

type SubtitlesChangedPayload = {
  movieId: string;
  lang: LangType;
  subtitle: TtmlSubtitle;
};
type SubtitlesChangedListener = (payload: SubtitlesChangedPayload) => void;

type SubtitlesReadyPayload = {
  movieId: string;
  state: SubtitlesState;
  bucket: Required<Record<LangType, TtmlSubtitle>>;
};

type SubtitlesReadyListener = (payload: SubtitlesReadyPayload) => void;

/**
 * ContentState
 * - Content script에서만 쓰는 in-memory 상태 저장소
 * - Pub/Sub(구독) 형태로 변경 사항을 외부에 알림
 */
export class ContentState {
  private _movieId: string | null = null;
  private _nextMovieId: string | null = null;
  // movieId -> { native, learning }
  private _downloadedTimedTextedTrackList: Map<
    string,
    Partial<Record<LangType, TtmlSubtitle>>
  > = new Map();

  private _movieIdListeners = new Set<MovieIdListener>();
  private _subtitlesChangedListeners = new Set<SubtitlesChangedListener>();
  private _subtitlesReadyListeners = new Set<SubtitlesReadyListener>();
  private _readyMovies = new Set<string>();

  // -------------------- movieId --------------------
  get movieId(): string | null {
    return this._movieId;
  }

  get nextMovieId(): string | null{
    return this._nextMovieId;
  }

  setMovieId(next: string | null): void {
    const prev = this._movieId;
    if (prev === next) return;

    // 전략 A: 현재 보고 있는 movieId만 유지 (이전 movieId 데이터는 제거)
    if (prev) {
      this._downloadedTimedTextedTrackList.delete(prev);
      this._readyMovies.delete(prev);
    }

    this._movieId = next;
    for (const fn of this._movieIdListeners) {
      try {
        fn(next, prev);
      } catch {
        // ignore subscriber errors
      }
    }
  }

  setNextMovieId(next: string | null): void {
    const prev = this._nextMovieId;
    if(prev === next) return;

    if(prev){
      this._readyMovies.delete(prev);
    }
    this._nextMovieId = next;
  }

  subscribeMovieId(fn: MovieIdListener): Unsubscribe {
    this._movieIdListeners.add(fn);
    return () => this._movieIdListeners.delete(fn);
  }

  // -------------------- subtitles(store) --------------------
  /**
   * movieId 버킷을 가져오거나 없으면 생성
   */
  private ensureBucket(movieId: string): Partial<Record<LangType, TtmlSubtitle>> {
    const existing = this._downloadedTimedTextedTrackList.get(movieId);
    if (existing) return existing;

    const created: Partial<Record<LangType, TtmlSubtitle>> = {};
    this._downloadedTimedTextedTrackList.set(movieId, created);
    return created;
  }

  /**
   * 특정 movieId에 해당하는 자막(native/learning)을 저장
   */
  setSubtitle(movieId: string, lang: LangType, subtitle: TtmlSubtitle): void {
    const bucket = this.ensureBucket(movieId);
    bucket[lang] = subtitle;

    // 두 언어(native/learning)가 모두 채워졌는지 체크
    const native = bucket.native;
    const learning = bucket.learning;
    if (native && learning && !this._readyMovies.has(movieId)) {
      this._readyMovies.add(movieId);
      const readyBucket = { native, learning } as Required<Record<LangType, TtmlSubtitle>>;
      const state = this.getSubtitlesState(movieId);
      for (const fn of this._subtitlesReadyListeners) {
        try {
          fn({ movieId, state, bucket: readyBucket });
        } catch {
          // ignore subscriber errors
        }
      }
    }

    for (const fn of this._subtitlesChangedListeners) {
      try {
        fn({ movieId, lang, subtitle });
      } catch {
        // ignore subscriber errors
      }
    }
  }

  /**
   * 현재 movieId 기준으로 저장 (movieId가 null이면 no-op)
   */
  setSubtitleForMovie(movieId: string,lang: LangType, subtitle: TtmlSubtitle): void {
    if (this._movieId !== movieId && this._nextMovieId !== movieId) return;
    this.setSubtitle(movieId, lang, subtitle);
  }

  getSubtitle(movieId: string, lang: LangType): TtmlSubtitle | undefined {
    return this._downloadedTimedTextedTrackList.get(movieId)?.[lang];
  }

  getSubtitles() {
    return this._downloadedTimedTextedTrackList;
  }

  /**
   * 현재 movieId 기준 조회
   */
  getSubtitleForCurrentMovie(lang: LangType): TtmlSubtitle | undefined {
    if (!this._movieId) return undefined;
    return this.getSubtitle(this._movieId, lang);
  }

  getBucket(movieId: string): Partial<Record<LangType, TtmlSubtitle>> | undefined {
    return this._downloadedTimedTextedTrackList.get(movieId);
  }

  /**
   * 자막 상태 계산
   * - waiting0: native/learning 둘 다 없음
   * - waiting1: 둘 중 하나만 있음
   * - ready: 둘 다 있으나 현재 movieId가 아님
   * - active: 둘 다 있고 현재 movieId임
   */
  getSubtitlesState(movieId: string): SubtitlesState {
    const b = this._downloadedTimedTextedTrackList.get(movieId);
    const hasNative = !!b?.native;
    const hasLearning = !!b?.learning;

    if (!hasNative && !hasLearning) return "waiting0";
    if (hasNative !== hasLearning) return "waiting1";

    // both
    return this._movieId === movieId ? "active" : "ready";
  }

  /**
   * movieId 한 개의 데이터만 제거
   */
  clearMovie(movieId: string): void {
    this._downloadedTimedTextedTrackList.delete(movieId);
  }

  /**
   * 전체 초기화
   */
  reset(): void {
    this._movieId = null;
    this._downloadedTimedTextedTrackList.clear();
    this._readyMovies.clear();
  }

  subscribeSubtitlesChanged(fn: SubtitlesChangedListener): Unsubscribe {
    this._subtitlesChangedListeners.add(fn);
    return () => this._subtitlesChangedListeners.delete(fn);
  }

  /**
   * 특정 movieId 버킷이 native/learning 모두 채워졌는지
   */
  isSubtitlesReady(movieId: string): boolean {
    const b = this._downloadedTimedTextedTrackList.get(movieId);
    return !!(b?.native && b?.learning);
  }

  /**
   * 현재 movieId 기준으로 native/learning 모두 채워졌는지
   */
  isSubtitlesReadyForCurrentMovie(): boolean {
    if (!this._movieId) return false;
    return this.isSubtitlesReady(this._movieId);
  }

  /**
   * native/learning 두 개가 모두 채워지는 "첫 순간"에만 1회 호출됨(중복 TTML 방지)
   */
  subscribeSubtitlesReady(fn: SubtitlesReadyListener): Unsubscribe {
    this._subtitlesReadyListeners.add(fn);
    return () => this._subtitlesReadyListeners.delete(fn);
  }
}

export const contentState = new ContentState();