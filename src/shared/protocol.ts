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

