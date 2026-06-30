/**
 * audio-source.js
 * (C) The Hyperaudio Project
 * @version 0.6.24 — last changed in release 0.6.24
 * @license MIT
 *
 * Shared audio-decode helper for the local transcription engines.
 *
 * Whisper (Local) and Parakeet (Local) both need their source media decoded to
 * the single buffer their workers consume: a 16 kHz mono Float32Array. This
 * used to be a byte-identical `readAudioFrom(file)` copied into each engine
 * client; it now lives here once (see #359).
 *
 * Deepgram is unaffected — it transcribes server-side and never decodes locally.
 *
 * Loaded as a plain <script> before the engine clients, exposing
 * `decodeToMono16k` as a global, matching the rest of the editor's helpers.
 */

/**
 * Decode media to a 16 kHz mono Float32Array (channel 0).
 *
 * @param {File|Blob|ArrayBuffer} source - an uploaded file/blob, or already-
 *   fetched bytes (e.g. extracted from a stream).
 * @returns {Promise<Float32Array>} mono PCM samples at 16 kHz.
 */
async function decodeToMono16k(source) {
  const sampling_rate = 16e3;
  const audioCTX = new AudioContext({ sampleRate: sampling_rate });
  try {
    const arrayBuffer = source instanceof ArrayBuffer
      ? source
      : await source.arrayBuffer();
    const decoded = await audioCTX.decodeAudioData(arrayBuffer);
    return decoded.getChannelData(0);
  } finally {
    audioCTX.close();
  }
}
