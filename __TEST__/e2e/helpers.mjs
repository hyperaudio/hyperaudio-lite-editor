// Shared helpers for the e2e suite.

// Build a mono 16-bit WAV "tone ladder": `seconds` one-second segments, each a
// distinct pure tone (200Hz, 300Hz, …). Content encodes time, so analysing the
// exported audio reveals exactly which parts of the timeline it contains.
export function ladderWav(seconds = 10, sampleRate = 44100) {
  const frames = seconds * sampleRate;
  const buf = Buffer.alloc(44 + frames * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + frames * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(frames * 2, 40);
  for (let sec = 0; sec < seconds; sec++) {
    const f = 200 + sec * 100;
    for (let n = 0; n < sampleRate; n++) {
      const v = Math.round(0.6 * 32767 * Math.sin(2 * Math.PI * f * n / sampleRate));
      buf.writeInt16LE(v, 44 + (sec * sampleRate + n) * 2);
    }
  }
  return buf;
}

// Parse a WAV buffer: duration plus a zero-crossing frequency estimate per
// `win`-second window (rounded to the nearest 100Hz to shrug off boundary
// transients).
export function analyseWav(buf, win = 0.5) {
  let off = 12, sr = 0, ch = 1, bits = 16, dataOff = 0, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') { ch = buf.readUInt16LE(off + 10); sr = buf.readUInt32LE(off + 12); bits = buf.readUInt16LE(off + 22); }
    if (id === 'data') { dataOff = off + 8; dataLen = size; break; }
    off += 8 + size + (size % 2);
  }
  const frames = dataLen / (ch * (bits / 8));
  const duration = frames / sr;
  const step = Math.floor(sr * win);
  const freqs = [];
  for (let i = 0; i + step <= frames; i += step) {
    let zc = 0;
    let prev = buf.readInt16LE(dataOff + (i * ch) * 2);
    for (let j = 1; j < step; j++) {
      const v = buf.readInt16LE(dataOff + ((i + j) * ch) * 2);
      if ((prev < 0) !== (v < 0)) zc++;
      prev = v;
    }
    freqs.push(Math.round(zc / (2 * win) / 100) * 100);
  }
  return { duration, sampleRate: sr, freqs };
}

// Build transcript HTML from [startMs, durMs, struck?] triples.
export function transcriptHtml(words) {
  return '<article><section><p>' + words.map(([m, d, s]) =>
    `<span data-m="${m}" data-d="${d}"${s ? ' style="text-decoration: line-through;"' : ''}>w </span>`
  ).join('') + '</p></section></article>';
}

// In-page: set the transcript, apply gap settings, and return the kept
// sections (clamped to `duration`) from the shipped model.
export async function sectionsFor(page, words, { gapsOn = false, duration = 60 } = {}) {
  return page.evaluate(({ html, gapsOn, duration }) => {
    document.getElementById('hypertranscript').innerHTML = html;
    const en = document.getElementById('remove-gaps-enabled');
    en.checked = gapsOn;
    en.dispatchEvent(new Event('change'));
    return window.getPlayableSections()
      .map((s) => ({ start: +s.start.toFixed(3), end: +Math.min(s.end, duration).toFixed(3) }))
      .filter((s) => s.end > s.start + 0.0005);
  }, { html: transcriptHtml(words), gapsOn, duration });
}

// The paragraph from #383, verbatim (struck run "lot → you're", 17.92–22.08s).
export const ISSUE_383_WORDS = [
  [2240, 80], [3440, 80], [5120, 640], [7280, 80], [7760, 80], [8000, 320], [8480, 720], [9760, 80],
  [11680, 640], [12640, 80], [12960, 80], [13680, 80], [14960, 80], [17360, 400], [17840, 80],
  [17920, 80, 1], [18080, 80, 1], [18320, 240, 1], [18960, 400, 1], [20080, 80, 1], [21040, 80, 1],
  [21280, 400, 1], [21600, 80, 1], [21840, 240, 1],
  [22080, 240], [22320, 80], [22480, 480], [23040, 80], [23200, 80], [23520, 80], [24000, 400],
  [26880, 400], [28480, 400], [29280, 80], [29600, 400], [30240, 80], [30560, 80], [30800, 400],
  [31200, 80], [31360, 80], [31520, 80], [31680, 80], [31920, 80], [32160, 80], [32400, 80],
  [32640, 80], [32800, 80], [33120, 480], [34080, 80], [35120, 80], [35520, 320], [35920, 80],
  [36160, 80], [36320, 80], [36480, 80], [36720, 80], [36960, 80], [37440, 80], [40400, 640],
];

// The transcript from #371, verbatim (struck fillers "um" at 14.96s and "Uh"
// at 28.48s, gap skipping on).
export const ISSUE_371_WORDS = [
  [2240, 80], [3440, 80], [5120, 1920], [7280, 80], [7760, 80], [8000, 320], [8480, 720], [9760, 80],
  [11680, 640], [12640, 80], [12960, 80], [13680, 80], [14960, 80, 1], [17360, 400], [17840, 80],
  [17920, 80], [18080, 80], [18320, 240], [18960, 400], [20080, 80], [21040, 80], [21280, 400],
  [21600, 80], [21840, 240], [22080, 240], [22320, 80], [22480, 480], [23040, 80], [23200, 80],
  [23520, 80], [24000, 2640], [26880, 1360], [28480, 400, 1], [29280, 80], [29600, 400], [30240, 80],
  [30560, 80], [30800, 400], [31200, 80], [31360, 80], [31520, 80], [31680, 80], [31920, 80],
  [32160, 80], [32400, 80], [32640, 80], [32800, 80], [33120, 720],
];
