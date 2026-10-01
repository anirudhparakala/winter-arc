/* Generates icons/icon-192.png and icons/icon-512.png with no dependencies.
   Draws the app mark: a black rounded tile with an icy-blue (#8ecbff) progress ring.
   Run: node tools/make-icons.js                                            */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---- minimal PNG writer (RGBA, 8-bit) ---- */
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // prefix every scanline with filter type 0
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---- the mark ---- */
const BG = [0, 0, 0], TEAL = [142, 203, 255], TRACK = [26, 34, 44];   // black tile, icy #8ecbff ring
const SWEEP = 0.78;              // ring drawn to 78% — matches the hero ring

function draw(size) {
  const buf = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const radius = size * 0.22;           // tile corner radius
  const rOut = size * 0.355, rIn = size * 0.255;
  const edge = size * 0.012;            // anti-alias width

  const put = (i, rgb, a) => { buf[i] = rgb[0]; buf[i+1] = rgb[1]; buf[i+2] = rgb[2]; buf[i+3] = a; };
  const mix = (i, rgb, a) => {          // alpha-blend rgb over what's already there
    const d = buf[i+3] / 255, s = a;
    buf[i]   = Math.round(rgb[0] * s + buf[i]   * (1 - s));
    buf[i+1] = Math.round(rgb[1] * s + buf[i+1] * (1 - s));
    buf[i+2] = Math.round(rgb[2] * s + buf[i+2] * (1 - s));
    buf[i+3] = Math.round(255 * (s + d * (1 - s)));
  };
  const smooth = d => Math.min(1, Math.max(0, 0.5 - d / edge));  // d>0 = outside

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const px = x + 0.5, py = y + 0.5;

      // rounded-square coverage
      const qx = Math.abs(px - c) - (c - radius);
      const qy = Math.abs(py - c) - (c - radius);
      const dBox = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
                 + Math.min(Math.max(qx, qy), 0) - radius;
      const aBox = smooth(dBox);
      if (aBox <= 0) { put(i, BG, 0); continue; }
      put(i, BG, Math.round(aBox * 255));

      // ring band
      const dx = px - c, dy = py - c;
      const r = Math.hypot(dx, dy);
      const band = Math.min(smooth(r - rOut), smooth(rIn - r + edge));
      if (band <= 0) continue;

      // angle: 0 at 12 o'clock, growing clockwise
      let ang = Math.atan2(dx, -dy) / (Math.PI * 2);
      if (ang < 0) ang += 1;
      const lit = ang <= SWEEP;
      mix(i, lit ? TEAL : TRACK, band * aBox);
    }
  }
  return png(size, size, buf);
}

const out = path.join(__dirname, '..', 'icons');
fs.mkdirSync(out, { recursive: true });
for (const size of [192, 512]) {
  const file = path.join(out, `icon-${size}.png`);
  fs.writeFileSync(file, draw(size));
  console.log('wrote', path.relative(path.join(__dirname, '..'), file));
}
