// src/content/state/contentState.ts
// In-memory (non-persistent) state container for the content script.
// NOTE: This is NOT localStorage/chrome.storage. It resets on reload.

import { type TtmlSubtitle } from "../../shared/ttmlParser";
import type { TimedTextTrack, AudioTrack } from "../../shared/protocol";

// Subtitles are stored by a normalized track-meta key (not just BCP-47).
// Reason: same bcp47 can exist as CC vs SUB, Assistive vs Primary, etc.
export type Bcp47 = string; // legacy alias (do not use as storage key)
export type TrackKey = string;

export type TimedTextTrackMeta = {
  bcp47: string | null;
  trackType: string | null;
  rawTrackType: string | null;
};

export type StoredTimedText = {
  key: TrackKey;
  meta: TimedTextTrackMeta;
  subtitle: TtmlSubtitle;
};

const norm = (v: any) => String(v ?? "").trim().toLowerCase();

export function makeTrackKey(meta: TimedTextTrackMeta): TrackKey {
  const b = meta?.bcp47 ? norm(meta.bcp47) : "";
  const tt = meta?.trackType ? norm(meta.trackType) : "";
  const rt = meta?.rawTrackType ? norm(meta.rawTrackType) : "";
  return `${b}|${tt}|${rt}`;
}

export type SubtitlesState = "waiting0" | "waiting1" | "ready" | "active";

type Unsubscribe = () => void;

type MovieIdListener = (next: string | null, prev: string | null) => void;

type SubtitlesChangedPayload = {
  movieId: string;
  key: TrackKey;
  meta: TimedTextTrackMeta;
  subtitle: TtmlSubtitle;
};
type SubtitlesChangedListener = (payload: SubtitlesChangedPayload) => void;

type SubtitlesReadyPayload = {
  movieId: string;
  state: SubtitlesState;
  // Snapshot of all timed-text stored for this movieId
  bucket: Record<TrackKey, StoredTimedText>;
};


type PlayerReadyPayload = {
  movieId: string | null;
  audioList: AudioTrack[];
  trackList: TimedTextTrack[];
  currentAudio: AudioTrack | null;
};

type PlayerReadyListener = (payload: PlayerReadyPayload) => void;

type SubtitlesReadyListener = (payload: SubtitlesReadyPayload) => void;

/**
 * ContentState
 * - Content script에서만 쓰는 in-memory 상태 저장소
 * - Pub/Sub(구독) 형태로 변경 사항을 외부에 알림
 */
export class ContentState {
  private _movieId: string | null = null;
  private _nextMovieId: string | null = null;
  // movieId -> (trackKey -> storedTimedText)
  private _downloadedTimedTextedTrackList: Map<string, Map<TrackKey, StoredTimedText>> = new Map();

  private _movieIdListeners = new Set<MovieIdListener>();
  private _subtitlesChangedListeners = new Set<SubtitlesChangedListener>();
  private _subtitlesReadyListeners = new Set<SubtitlesReadyListener>();
  private _readyMovies = new Set<string>();

  // ----- Player / track info (from pageHook PLAYER_READY) -----
  private _audioList: AudioTrack[] = [];
  private _timedTextTrackList: TimedTextTrack[] = [];
  private _currentAudio: AudioTrack | null = null;
  private _currentTimedText: TimedTextTrack | null = null;
  private _playerReadyListeners = new Set<PlayerReadyListener>();

  private _player: any = null;

  get player(): any {
    return this._player;
  }

  set player(next: any) {
    this._player = next;
  }

  // -------------------- tracks / player-ready --------------------
  get audioList(): AudioTrack[] {
    return this._audioList;
  }

  get timedTextTrackList(): TimedTextTrack[] {
    return this._timedTextTrackList;
  }

  get currentAudio(): AudioTrack | null {
    return this._currentAudio;
  }

  get currentTimedText(): TimedTextTrack | null {
    return this._currentTimedText;
  }

  setPlayerReady(payload: PlayerReadyPayload): void {
    // keep track info
    this._audioList = payload.audioList ?? [];
    this._timedTextTrackList = payload.trackList ?? [];
    this._currentAudio = payload.currentAudio ?? null;

    // movieId can be null (some titles/pages). If provided, also sync movieId.
    if (payload.movieId != null) {
      try {
        this.setMovieId(payload.movieId);
      } catch {
        // ignore
      }
    }

    for (const fn of this._playerReadyListeners) {
      try {
        fn(payload);
      } catch {
        // ignore subscriber errors
      }
    }
  }

  subscribePlayerReady(fn: PlayerReadyListener): Unsubscribe {
    this._playerReadyListeners.add(fn);
    return () => this._playerReadyListeners.delete(fn);
  }

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
  private ensureBucket(movieId: string): Map<TrackKey, StoredTimedText> {
    const existing = this._downloadedTimedTextedTrackList.get(movieId);
    if (existing) return existing;

    const created = new Map<TrackKey, StoredTimedText>();
    this._downloadedTimedTextedTrackList.set(movieId, created);
    return created;
  }

  /**
   * 특정 movieId에 해당하는 timedText(자막 트랙)을 저장
   * - key는 trackMeta(bcp47/trackType/rawTrackType/nttmTextType)로 구성
   */
  setSubtitle(movieId: string, trackMeta: TimedTextTrackMeta, subtitle: TtmlSubtitle): void {
    const bucket = this.ensureBucket(movieId);

    const meta: TimedTextTrackMeta = {
      bcp47: trackMeta?.bcp47 != null ? norm(trackMeta.bcp47) : null,
      trackType: trackMeta?.trackType != null ? norm(trackMeta.trackType) : null,
      rawTrackType: trackMeta?.rawTrackType != null ? norm(trackMeta.rawTrackType) : null,
    };

    const key = makeTrackKey(meta);
    if (!key) return;

    const stored: StoredTimedText = { key, meta, subtitle };
    bucket.set(key, stored);

    // "ready" heuristic: at least 2 distinct entries cached for this movieId.
    // NOTE: ready/active 상태에서는 매번 notify 하도록 유지.
    const state = this.getSubtitlesState(movieId);

    if (bucket.size >= 2) {
      if (!this._readyMovies.has(movieId)) {
        this._readyMovies.add(movieId);
      }

      const snapshot: Record<TrackKey, StoredTimedText> = {};
      for (const [k, v] of bucket.entries()) snapshot[k] = v;

      if (state === "ready" || state === "active") {
        for (const fn of this._subtitlesReadyListeners) {
          try {
            fn({ movieId, state, bucket: snapshot });
          } catch {
            // ignore subscriber errors
          }
        }
      }
    }

    for (const fn of this._subtitlesChangedListeners) {
      try {
        fn({ movieId, key, meta, subtitle });
      } catch {
        // ignore subscriber errors
      }
    }
  }

  /**
   * 현재 movieId 기준으로 저장 (movieId가 null이면 no-op)
   */
  setSubtitleForMovie(movieId: string, trackMeta: TimedTextTrackMeta, subtitle: TtmlSubtitle): void {
    if (this._movieId !== movieId && this._nextMovieId !== movieId) return;
    this.setSubtitle(movieId, trackMeta, subtitle);
  }

  getSubtitleByKey(movieId: string, key: TrackKey): TtmlSubtitle | undefined {
    const bucket = this._downloadedTimedTextedTrackList.get(movieId);
    if (!bucket) return undefined;
    return bucket.get(String(key || "").toLowerCase())?.subtitle;
  }

  getSubtitleByMeta(movieId: string, meta: TimedTextTrackMeta): TtmlSubtitle | undefined {
    const key = makeTrackKey(meta);
    return this.getSubtitleByKey(movieId, key);
  }

  getSubtitles() {
    return this._downloadedTimedTextedTrackList;
  }

  /**
   * 현재 movieId 기준 조회
   */
  getSubtitleForCurrentMovieByKey(key: TrackKey): TtmlSubtitle | undefined {
    if (!this._movieId) return undefined;
    return this.getSubtitleByKey(this._movieId, key);
  }

  getSubtitleForCurrentMovieByMeta(meta: TimedTextTrackMeta): TtmlSubtitle | undefined {
    if (!this._movieId) return undefined;
    return this.getSubtitleByMeta(this._movieId, meta);
  }

  getBucket(movieId: string): Map<TrackKey, StoredTimedText> | undefined {
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
    const size = b ? b.size : 0;

    if (size === 0) return "waiting0";
    if (size === 1) return "waiting1";

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
    return (b?.size ?? 0) >= 2;
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