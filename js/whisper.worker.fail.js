import { pipeline } from "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.3.0";

/*import { createModelLoader } from "./modelFactories.js";*/
/*import { MessageTypes, ModelNames } from "./utils.js";*/

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

console.log("TOP OF THE WORKER");


function createModelLoader(model_name) {

  console.log("############# in createModelLoader");
  
  let model = null;
  const load_model = async ({ progress_callback = undefined }) => {
    if (model === null) {
      model = await pipeline("automatic-speech-recognition", model_name, {
        progress_callback,
      });
    }
    return model;
  };
  return load_model;
}

/*const MessageTypes = {
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
};*/


const modelLoaders = {};
for (const model_name of Object.values(ModelNames)) {
  console.log(model_name);
  modelLoaders[model_name] = createModelLoader(model_name);
}

self.addEventListener("message", async (event) => {
  console.log("RECEIVED MESSAGE");
  debugger;
  const { type, audio, model_name } = event.data;
  if (type === MessageTypes.INFERENCE_REQUEST) {
    console.log(model_name);
    await transcribe(audio, model_name);
    
  }
});

async function transcribe(audio, model_name) {
  // check if model_name is not in modelLoaders
  sendLoadingMessage("loading", "");

  if (!modelLoaders[model_name]) {
    console.log("Model not found");
    sendLoadingMessage("error", "Model not found");
    return;
  }

  const pipeline = await modelLoaders[model_name]({
    callback_function: load_model_callback,
  });
  sendLoadingMessage("success");

  const stride_length_s = 5;
  const generationTracker = new GenerationTracker(pipeline, stride_length_s);
  await pipeline(audio, {
    top_k: 0, // TODO: make this configurable via request
    do_sample: false, // TODO: make this configurable via request
    chunk_length_s: 30, // TODO: make this configurable via request
    stride_length_s: stride_length_s, // TODO: make this configurable via request
    return_timestamps: true,
    callback_function:
      generationTracker.callbackFunction.bind(generationTracker),
    chunk_callback: generationTracker.chunkCallback.bind(generationTracker),
  });
  generationTracker.sendFinalResult();
}

async function load_model_callback(data) {
  const { status } = data;
  if (status === "progress") {
    const { file, progress, loaded, total } = data;
    sendDownloadingMessage(file, progress, loaded, total);
  }
  if (status === "done") {
    // Do nothing
  }
  if (status === "loaded") {
    // Do nothing
  }
}

function sendLoadingMessage(status, message) {
  self.postMessage({
    type: MessageTypes.LOADING,
    status,
    message,
  });
}

function sendDownloadingMessage(file, progress, loaded, total) {
  self.postMessage({
    type: MessageTypes.DOWNLOADING,
    file,
    progress,
    loaded,
    total,
  });
}

class GenerationTracker {
  constructor(pipeline, stride_length_s) {
    this.pipeline = pipeline;
    this.stride_length_s = stride_length_s;
    this.chunks = [];
    this.time_precision =
      pipeline.processor.feature_extractor.config.chunk_length /
      pipeline.model.config.max_source_positions;
    this.processed_chunks = [];
    this.callbackFunctionCounter = 0;
  }

  sendFinalResult() {
    self.postMessage({ type: MessageTypes.INFERENCE_DONE });
  }

  callbackFunction(beams) {
    this.callbackFunctionCounter += 1;
    if (this.callbackFunctionCounter % 10 !== 0) {
      return;
    }

    const bestBeam = beams[0];
    let text = this.pipeline.tokenizer.decode(bestBeam.output_token_ids, {
      skip_special_tokens: true,
    });

    const result = {
      text,
      start: this.getLastChuckTimestamp(),
      end: undefined,
    };
    createPartialResultMessage(result);
  }

  chunkCallback(data) {
    this.chunks.push(data);
    const [text, { chunks }] = this.pipeline.tokenizer._decode_asr(
      this.chunks,
      {
        time_precision: this.time_precision,
        return_timestamps: true,
        force_full_sequences: false,
      }
    );
    // const newpProcessedChunks = chunks.map(this.processChunk.bind(this));
    this.processed_chunks = chunks.map((chunk, index) =>
      this.processChunk(chunk, index)
    );
    // this.processed_chunks = this.processed_chunks.concat(newpProcessedChunks);
    createResultMessage(
      this.processed_chunks,
      false,
      this.getLastChuckTimestamp()
    );
  }

  getLastChuckTimestamp() {
    if (this.processed_chunks.length === 0) {
      return 0;
    }
    return this.processed_chunks[this.processed_chunks.length - 1].end;
  }

  processChunk(chunk, index) {
    const { text, timestamp } = chunk;
    const [start, end] = timestamp;

    return {
      index,
      text: `${text.trim()} `,
      start: Math.round(start),
      end: Math.round(end) || Math.round(start + 0.9 * this.stride_length_s),
    };
  }
}

function createResultMessage(results, isDone, completedUntilTimestamp) {
  self.postMessage({
    type: MessageTypes.RESULT,
    results,
    isDone,
    completedUntilTimestamp,
  });
}

function createPartialResultMessage(result) {
  self.postMessage({
    type: MessageTypes.RESULT_PARTIAL,
    result,
  });
}

function removeOverlap(s1, s2) {
  let overlap = Math.min(s1.length, s2.length);
  while (overlap > 0) {
    if (s2.startsWith(s1.substring(s1.length - overlap))) {
      return s2.substring(overlap);
    }
    overlap--;
  }
  return s2;
}
