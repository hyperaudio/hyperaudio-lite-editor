/**
 * cloud-audio.js
 * (C) The Hyperaudio Project
 * @version 1.3.46 — last changed in release 1.3.46
 * @license AGPL-3.0-only
 *
 * The audio a cloud engine is sent (#788). The three cloud clients uploaded
 * the picked file as it was, so a video went up with its picture: a
 * 54-minute video of 527 MB, nearly all of it picture, failed at DeepInfra
 * after minutes of upload, where the 18-minute debate at 54 MB took a
 * minute. Before a cloud upload, a file with a video track is converted here
 * to 16 kHz mono Opus at 48 kbps in an Ogg file, about 20 MB an hour, with
 * the mediabunny the export path already vendors (js/media-export.js, the
 * import map in index.html) and the browser's own encoder. An audio file
 * is sent as it is, since re-encoding it would only lose quality, and so
 * is anything mediabunny cannot read or encode here, which the service may
 * still take.
 *
 * Opus, and not MP3, because of the word timings. Measured on a probe whose
 * sound starts at 0.5 s, decoded with ffmpeg as the services decode: the
 * MP3 mediabunny's encoder extension writes starts 69 ms late, its encoder
 * delay unsignalled, where Ogg Opus carries its pre-skip in the header and
 * starts 4 ms late, and WAV starts on the instant. So Opus first, and WAV
 * when the browser cannot encode Opus, still five times smaller than video.
 *
 * Each client calls audioForUpload(blob, filename) and sends what comes
 * back. Without this file a client sends what it was given, so the change
 * can be lifted out by removing the script and the three calls.
 */
(function () {
  'use strict';

  const SAMPLE_RATE = 16000;
  const CHANNELS = 1;
  // in order of preference: Opus, and WAV when the browser cannot encode it
  const TARGETS = [
    { codec: 'opus', bitrate: 48000, type: 'audio/ogg', ext: 'ogg', make: (mb) => new mb.OggOutputFormat() },
    { codec: 'pcm-s16', type: 'audio/wav', ext: 'wav', make: (mb) => new mb.WavOutputFormat() },
  ];

  let mediabunnyPromise = null;
  const loadMediabunny = () => {
    if (mediabunnyPromise === null) mediabunnyPromise = import('mediabunny');
    return mediabunnyPromise;
  };

  const encodableTarget = async (mb) => {
    for (const target of TARGETS) {
      const options = { numberOfChannels: CHANNELS, sampleRate: SAMPLE_RATE };
      if (target.bitrate) options.bitrate = target.bitrate;
      try {
        if (await mb.canEncodeAudio(target.codec, options)) return target;
      } catch (e) { /* this codec, not the next */ }
    }
    return null;
  };

  // Progress on the card the client painted ("Transcribing…"), restored when
  // the conversion is over. A client with its own idea passes onProgress.
  const progressReporter = (onProgress) => {
    if (typeof onProgress === 'function') return { report: onProgress, done: () => {} };
    const line = document.querySelector('#hypertranscript .vertically-centre center');
    const before = line ? line.textContent : null;
    return {
      report: (fraction) => {
        if (line) line.textContent = `Converting the audio… ${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
      },
      done: () => { if (line && before !== null) line.textContent = before; },
    };
  };

  const mega = (bytes) => (bytes / 1048576).toFixed(bytes >= 10485760 ? 0 : 1);

  /**
   * What to upload for a picked or fetched media file: the file itself, or,
   * when it carries a video track, its sound as 16 kHz mono audio.
   * @param {Blob} source - the file or blob the client would have sent
   * @param {string} filename - its name, for the name of the audio
   * @param {function(number)=} onProgress - 0..1 while converting
   * @returns {Promise<{blob: Blob, filename: string, converted: boolean, reason?: string}>}
   */
  async function audioForUpload(source, filename, onProgress) {
    const name = typeof filename === 'string' && filename !== '' ? filename : 'audio';
    const asIs = (reason) => ({ blob: source, filename: name, converted: false, reason });
    if (typeof Blob === 'undefined' || !(source instanceof Blob)) return asIs('not a file');
    let mb;
    try {
      mb = await loadMediabunny();
    } catch (e) {
      return asIs('mediabunny did not load');
    }
    let input;
    let hasVideo;
    let hasAudio;
    try {
      input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(source) });
      hasVideo = (await input.getPrimaryVideoTrack()) !== null;
      hasAudio = (await input.getPrimaryAudioTrack()) !== null;
    } catch (e) {
      return asIs('not a container mediabunny reads');
    }
    if (!hasVideo) return asIs('audio already');
    if (!hasAudio) return asIs('no audio track');
    const target = await encodableTarget(mb);
    if (target === null) return asIs('no audio encoder');

    const progress = progressReporter(onProgress);
    let conversion = null;
    try {
      const output = new mb.Output({ format: target.make(mb), target: new mb.BufferTarget() });
      const audio = { codec: target.codec, sampleRate: SAMPLE_RATE, numberOfChannels: CHANNELS };
      if (target.bitrate) audio.bitrate = target.bitrate;
      conversion = await mb.Conversion.init({ input, output, video: { discard: true }, audio });
      if (conversion.isValid === false) return asIs('conversion not possible');
      progress.report(0);
      conversion.onProgress = (fraction) => progress.report(fraction);
      await conversion.execute();
      const blob = new Blob([output.target.buffer], { type: target.type });
      const base = name.replace(/\.[^.]+$/, '');
      console.info(`Sent the audio only: ${mega(source.size)} MB of ${source.type || 'video'} as ${mega(blob.size)} MB of ${target.type} at 16 kHz mono (#788)`);
      return { blob, filename: `${base}.${target.ext}`, converted: true, from: source.size };
    } catch (e) {
      // release the encoder and decoder (as the export does, #407)
      if (conversion !== null) { try { await conversion.cancel(); } catch (_) { /* already torn down */ } }
      console.warn('The audio could not be converted, so the file goes up as it is:', e);
      return asIs('conversion failed');
    } finally {
      progress.done();
    }
  }

  window.HyperaudioCloudAudio = Object.freeze({ audioForUpload });
}());
