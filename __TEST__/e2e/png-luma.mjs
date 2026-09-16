// Minimal PNG reader, for asking whether a screenshot has any picture in it
// at all. Used by the WebKit poster test (#575), where the failure mode is a
// perfectly uniform box — the element painting nothing and the page showing
// through — which no DOM assertion can tell from a poster that IS painting.
import zlib from 'node:zlib';

// The decoded pixels: { w, h, channels, px } with px a Buffer of unfiltered
// samples, row-major. Shared by the luma count and the colour sample below.
export function decodePng(buf) {
  let pos = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('unexpected bit depth ' + bitDepth);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride); rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const bb = prev[x];
      const c = (x >= channels && y > 0) ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a; else if (filter === 2) v += bb;
      else if (filter === 3) v += (a + bb) >> 1;
      else if (filter === 4) {
        const pp = a + bb - c, pa = Math.abs(pp - a), pb = Math.abs(pp - bb), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? bb : c);
      }
      cur[x] = v & 0xff;
    }
  }
  return { w, h, channels, px: out };
}

export function pngLuma(buf) {
  const { w, h, channels, px: out } = decodePng(buf);
  const seen = new Set();
  let min = 255, max = 0;
  for (let i = 0; i < out.length; i += channels) {
    const lum = channels >= 3 ? Math.round(0.299 * out[i] + 0.587 * out[i+1] + 0.114 * out[i+2]) : out[i];
    seen.add(lum); if (lum < min) min = lum; if (lum > max) max = lum;
  }
  return { w, h, distinctLuma: seen.size, min, max, spread: max - min };
}

// The mean colour of an image, and how far it is from grey: max channel minus
// min channel. Used by the audio-poster test (#629), where a distinct-luma
// count is fooled by whatever else sits in the frame — captions, the play
// badge — but a corner of the glyph's pastel fill has chroma and the page
// background showing through has none.
export function pngMeanRGB(buf) {
  const { w, h, channels, px } = decodePng(buf);
  if (channels < 3) throw new Error('need an RGB(A) png, got ' + channels + ' channel(s)');
  let r = 0, g = 0, b = 0;
  const n = w * h;
  for (let i = 0; i < px.length; i += channels) { r += px[i]; g += px[i + 1]; b += px[i + 2]; }
  r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
  return { r, g, b, spread: Math.max(r, g, b) - Math.min(r, g, b) };
}
