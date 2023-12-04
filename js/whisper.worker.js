import { pipeline } from "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.9.0";

self.addEventListener("message", async (event) => {
  const { type, audio, model_name } = event.data;

  if (type === "INFERENCE_REQUEST") {
  
    const automaticSpeechRecognition = await pipeline(
      "automatic-speech-recognition",
      model_name,
      { revision: "output_attentions" }
    );
  
    let output = await automaticSpeechRecognition(audio, {
      return_timestamps: "word",
      chunk_length_s: 30,
      stride_length_s: 5,
    });
  
    console.log(output);
    self.postMessage({ output: output });
  }
});