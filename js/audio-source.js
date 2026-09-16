/**
 * audio-source.js
 * (C) The Hyperaudio Project
 * @version 1.3.17 — last changed in release 1.3.17
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
 * For a URL there is a second entry point, `decodeAudioOnlyFromUrl` (#627):
 * fetching a whole file to decode it is fine for a local pick, but a remote
 * media URL can be enormous — a 74-minute stream VOD at 5.85 GB killed the
 * tab, because the audio we actually want was buried in video we downloaded
 * in full and threw away. mediabunny reads the container over range requests
 * and converts the audio track alone to 16 kHz mono, so the download is the
 * audio and memory stays bounded.
 *
 * Loaded as a plain <script> before the engine clients, exposing
 * `decodeToMono16k` as a global, matching the rest of the editor's helpers.
 */

const AUDIO_SAMPLE_RATE = 16e3;

// Vendored, and already loaded this way by the media exporter (bare specifier
// via the import map). Dynamic import works from a classic script.
let audioMediabunnyPromise = null;
const loadAudioMediabunny = () => {
  if (audioMediabunnyPromise === null) audioMediabunnyPromise = import('mediabunny');
  return audioMediabunnyPromise;
};

/**
 * PCM samples from a mono WAV, without an AudioContext. The bytes come from
 * mediabunny already at the rate and channel count we asked for, so decoding
 * them is a header walk and a scale — no resampling, and no second decode
 * pass holding the file twice over. Exported for tests.
 *
 * @param {ArrayBuffer} buffer - a RIFF/WAVE file.
 * @returns {{samples: Float32Array, sampleRate: number, channels: number}}
 */
function pcmFromWav(buffer) {
  const view = new DataView(buffer);
  const tag = (offset) => String.fromCharCode(
    view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
  if (buffer.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new Error('Not a WAV file.');
  }
  let format = 1;
  let channels = 1;
  let sampleRate = AUDIO_SAMPLE_RATE;
  let bitsPerSample = 16;
  let dataStart = -1;
  let dataLength = 0;
  let cursor = 12;
  while (cursor + 8 <= buffer.byteLength) {
    const id = tag(cursor);
    const size = view.getUint32(cursor + 4, true);
    const body = cursor + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      dataStart = body;
      // a streamed WAV can declare an unknown length; take what is there
      dataLength = size === 0 || body + size > buffer.byteLength ? buffer.byteLength - body : size;
      break;
    }
    cursor = body + size + (size % 2); // chunks are word-aligned
  }
  if (dataStart < 0) throw new Error('WAV file has no data chunk.');

  const frames = Math.floor(dataLength / (channels * (bitsPerSample / 8)));
  const samples = new Float32Array(frames);
  if (format === 3 && bitsPerSample === 32) {
    for (let i = 0; i < frames; i += 1) {
      samples[i] = view.getFloat32(dataStart + i * channels * 4, true); // channel 0
    }
  } else if (format === 1 && bitsPerSample === 16) {
    for (let i = 0; i < frames; i += 1) {
      samples[i] = view.getInt16(dataStart + i * channels * 2, true) / 32768;
    }
  } else {
    throw new Error(`Unsupported WAV sample format (${format}, ${bitsPerSample}-bit).`);
  }
  return { samples, sampleRate, channels };
}

/**
 * Decode ONLY the audio track of a remote media URL to a 16 kHz mono
 * Float32Array (#627). mediabunny demuxes over range requests, so a file
 * whose bulk is video is never downloaded whole, and it resamples and
 * downmixes on the way out.
 *
 * Throws when the container cannot be read or carries no audio — the caller
 * decides whether a whole-file fetch is a safe fallback at that size.
 *
 * @param {string} url
 * @param {function(number)} [onProgress] - percent complete, 0-100.
 * @returns {Promise<Float32Array>}
 */
async function decodeAudioOnlyFromUrl(url, onProgress) {
  const mb = await loadAudioMediabunny();
  const input = new mb.Input({ source: new mb.UrlSource(url), formats: mb.ALL_FORMATS });
  const track = await input.getPrimaryAudioTrack();
  if (!track) throw new Error('The media has no audio track.');

  const output = new mb.Output({ format: new mb.WavOutputFormat(), target: new mb.BufferTarget() });
  const conversion = await mb.Conversion.init({
    input,
    output,
    video: { discard: true },                                        // the part we were paying for
    audio: { numberOfChannels: 1, sampleRate: AUDIO_SAMPLE_RATE },
  });
  if (typeof onProgress === 'function') {
    conversion.onProgress = (p) => onProgress(Math.max(0, Math.min(100, Math.round((p || 0) * 100))));
  }
  await conversion.execute();

  const wav = output.target.buffer;
  if (!wav) throw new Error('Audio extraction produced nothing.');
  const { samples, sampleRate } = pcmFromWav(wav);
  if (sampleRate !== AUDIO_SAMPLE_RATE) {
    throw new Error(`Audio extraction returned ${sampleRate} Hz, expected ${AUDIO_SAMPLE_RATE}.`);
  }
  return samples;
}

// Node (unit tests) takes the pure part; the browser gets globals as before.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { pcmFromWav };
}

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
