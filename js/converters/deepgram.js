/**
 * converters/deepgram.js
 * (C) The Hyperaudio Project
 * @version 1.3.44 — last changed in release 1.3.44
 * @license AGPL-3.0-only
 *
 * Deepgram's response (#751): the words of the first channel's first
 * alternative, with the summary, the topics, the detected language and the
 * model build that answered, as the editor's canonical transcript. The
 * client (js/hyperaudio-lite-editor-deepgram.js) sends the request and puts
 * the result on the page. Nothing here touches the page.
 *
 * Words come with `start`/`end` in seconds, `word` and, under smart_format,
 * `punctuated_word`, and a `speaker` number from `diarize`. See
 * converters/transcript-words.js for what every converter returns.
 */
(function (root) {
  'use strict';

  const shared = (root && root.HyperaudioConverters) || (typeof require === 'function' ? require('./transcript-words.js') : null);

  // The visible text comes off each word, beside that word's own timing and
  // speaker. It used to come from a SECOND list — the formatted transcript
  // split on spaces — matched to the word array by position alone, with
  // nothing checking the two were the same length. smart_format is exactly
  // what breaks that: it rewrites spoken numbers and the like into forms with
  // a different token count, and from the first mismatch every word after it
  // is drawn from the wrong slot, so labels land against the wrong text. The
  // formatted word is already on the object smart_format put it there for.
  const textOf = (w) => (typeof w.punctuated_word === 'string' && w.punctuated_word !== ''
    ? w.punctuated_word : w.word);

  // Deepgram's `diarize` tags every word on its own, with no regard for what
  // was being said, so a boundary lands a few words short of where the turn
  // actually ended and the next speaker is credited with the tail of the
  // previous one's sentence: the label reads as mid-sentence. Measured on a
  // six-way debate, eight or nine of about thirty changes fell inside a
  // sentence, against essentially none from AssemblyAI on the same audio.
  //
  // Two attempts to correct it here were tried against that audio and both
  // failed, so the speakers are left exactly as Deepgram reports them:
  //
  //   Taking each word's speaker from the `utterances` segment it falls in
  //   merged distinct speakers — 374 words moved, the host swallowed into the
  //   answer before it. Their segmentation runs through a speaker change when
  //   the pause is short, so it is coarser than their own per-word flags.
  //
  //   Moving each change onto the nearest utterance edge, keeping every
  //   change and only correcting its position, moved 16 of them and changed
  //   nothing anyone could see. With about one utterance every nine seconds
  //   the edges are too sparse to land on, and where one is near it is
  //   generally mid-sentence too, being cut from the same diarization.
  //
  // The single-word repair below stays: it is narrow, it predates this, and
  // it addresses a signature that is demonstrably theirs. Anything broader
  // needs better data than the API gives us, and AssemblyAI, which returns
  // speaker-tagged utterances, is the engine to reach for on diarized
  // material. hyperaudioSpeakerDebug() reports what their flags actually say.
  //
  // Fix Deepgram diarization edge case where the last word of a speaker turn
  // gets attached to the next speaker. Signature: the word starts essentially
  // on top of the previous speaker's word, but the next word from this "new"
  // speaker is far away. In that case, reassign the word back. The response
  // itself is left as Deepgram sent it: the repair is made on the speakers
  // list returned here.
  const speakerReassignGap = 0.3;
  function repairedSpeakers(wordData) {
    const speakers = wordData.map((w) => w.speaker);
    for (let i = 1; i < wordData.length - 1; i++) {
      const prev = wordData[i - 1];
      const cur = wordData[i];
      const next = wordData[i + 1];
      if (speakers[i] !== speakers[i - 1] && next.speaker === cur.speaker) {
        const gapBefore = cur.start - prev.end;
        const gapAfter = next.start - cur.end;
        if (gapBefore < speakerReassignGap && gapAfter > speakerReassignGap) {
          speakers[i] = speakers[i - 1];
        }
      }
    }
    return speakers;
  }

  const summaryOf = (json) => {
    const summary = json.results && json.results.summary;
    if (!summary) return '';
    return summary.short || summary.text || '';
  };

  const topicsOf = (json) => {
    const topicsData = json.results && json.results.topics;
    if (!topicsData || !Array.isArray(topicsData.segments)) return [];
    const seen = new Set();
    topicsData.segments.forEach((segment) => {
      (segment.topics || []).forEach((t) => {
        if (t && t.topic && !seen.has(t.topic)) seen.add(t.topic);
      });
    });
    return Array.from(seen);
  };

  // what Deepgram detected, when the request left the language to it
  const languageOf = (json) => {
    try { return json.results.channels[0].detected_language; } catch (e) { return undefined; }
  };

  // Deepgram names the exact model build that answered
  const engineVersionOf = (json) => {
    try {
      const info = Object.values((json.metadata && json.metadata.model_info) || {})[0];
      return info && info.version ? String(info.version) : undefined;
    } catch (e) { return undefined; }
  };

  /**
   * A Deepgram response as the editor's transcript.
   * @param {object} json - the parsed response
   * @returns {{words: Array, paragraphs: Array, summary: string, topics: string[], language: (string|undefined), engineVersion: (string|undefined)}}
   */
  function deepgram(json) {
    const wordData = json.results.channels[0].alternatives[0].words;
    const speakers = repairedSpeakers(wordData);
    const words = wordData.map((w, i) => ({
      text: textOf(w),
      start: w.start,
      end: w.end,
      speaker: 'speaker-' + speakers[i],
    }));
    // a label at the first word and at every change of speaker, as always
    const transcript = shared.transcriptFromWords(words, { labelOnChange: true });
    return {
      words: transcript.words,
      paragraphs: transcript.paragraphs,
      summary: summaryOf(json),
      topics: topicsOf(json),
      language: languageOf(json),
      engineVersion: engineVersionOf(json),
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { deepgram };
  if (root) {
    root.HyperaudioConverters = root.HyperaudioConverters || {};
    root.HyperaudioConverters.deepgram = deepgram;
  }
}(typeof window !== 'undefined' ? window : null));
