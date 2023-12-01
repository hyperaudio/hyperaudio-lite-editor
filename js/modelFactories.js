import { pipeline } from "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.9.0";

function createModelLoader(model_name) {
  console.log("in createModelLoader");
  console.log("attempting to load model:" + model_name);
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

export { createModelLoader };