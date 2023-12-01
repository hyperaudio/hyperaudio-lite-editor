const MessageTypes = {
  DOWNLOADING: "DOWNLOADING",
  LOADING: "LOADING",
  RESULT: "RESULT",
  RESULT_PARTIAL: "RESULT_PARTIAL",
  INFERENCE_REQUEST: "INFERENCE_REQUEST",
  INFERENCE_DONE: "INFERENCE_DONE",
};

const LoadingStatus = {
  SUCCESS: "success",
  ERROR: "error",
  LOADING: "loading",
};

const ModelNames = {
  WHISPER_TINY_EN: "openai/whisper-tiny.en",
  WHISPER_TINY: "openai/whisper-tiny",
  WHISPER_BASE: "openai/whisper-base",
  WHISPER_BASE_EN: "openai/whisper-base.en",
  WHISPER_SMALL: "openai/whisper-small",
  WHISPER_SMALL_EN: "openai/whisper-small.en",
};

export { MessageTypes, ModelNames, LoadingStatus };