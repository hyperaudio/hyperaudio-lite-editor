// Minimal PNG reader, for asking whether a screenshot has any picture in it
// at all. Used by the WebKit poster test (#575), where the failure mode is a
// perfectly uniform box — the element painting nothing and the page showing
// through — which no DOM assertion can tell from a poster that IS painting.
import zlib from 'node:zlib';
export function pngLuma(buf) {
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
  const seen = new Set();
  let min = 255, max = 0;
  for (let i = 0; i < out.length; i += channels) {
    const lum = channels >= 3 ? Math.round(0.299 * out[i] + 0.587 * out[i+1] + 0.114 * out[i+2]) : out[i];
    seen.add(lum); if (lum < min) min = lum; if (lum > max) max = lum;
  }
  return { w, h, distinctLuma: seen.size, min, max, spread: max - min };
}
