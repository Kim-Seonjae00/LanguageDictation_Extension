export const Msg = {
  START: "DICTATION_START",
  STOP: "DICTATION_STOP",
  DICTATION_SEND: "DICTATION_SEND",
  DICTATION_RESULT: "DICTATION_RESULT",
} as const;

export interface SendDictation {
  expected: string;
  actual: string;
}

export interface DictationResult {
  correct: boolean;
  wrong: number[];
  sendDictation: SendDictation;
};

export type MsgType = typeof Msg[keyof typeof Msg];

export type MsgPayloadsMap = {
  [Msg.START]: undefined;
  [Msg.STOP]: undefined;
  [Msg.DICTATION_SEND]: SendDictation;
  [Msg.DICTATION_RESULT]: DictationResult;
};

export type NoPayloadMsgType = {
  [K in MsgType]: MsgPayloadsMap[K] extends undefined ? K : never
}[MsgType];

export type ExtMessage<T extends MsgType = MsgType> =
  MsgPayloadsMap[T] extends undefined
    ? { type: T }
    : { type: T; payload: MsgPayloadsMap[T] };
    
export type ExtNoPayloadMessage<T extends NoPayloadMsgType = NoPayloadMsgType> = 
  { type: T };

export type TimedTextTrack = {
  trackId: string;
  bcp47: string;      // e.g., "en", "ko"
  channels?: string;   // e.g., "2", "6"
  dipsplayName: string; // e.g., "English", "Korean"
  isForcedNarrative: boolean;
  isImageBased: boolean;
  isNoneTrack: boolean;
  rawTrackType: string; // e.g., "TTML", "VTT"
  subType?: string;      // e.g., "SDH"
  trackType: string;    // e.g., "SUBTITLE", "CAPTION"
  variant?: string; // e.g., "SDH"
}

export type AudioTrack = {
  trackId: string;
  bcp47: string;      // e.g., "en", "ko"
  channels?: string;   // e.g., "2", "6"
  displayName: string; // e.g., "English", "Korean"
  isNative: boolean;
  rawTrackType: string; // e.g., "AUDIO"
  subType?: string;      // e.g., "COMMENTARY"
  surroundFormatLabel?: string; // e.g., "5.1", "2.0"
  trackType: string;    // e.g., "AUDIO"
  variant?: string; // e.g., "COMMENTARY"
}