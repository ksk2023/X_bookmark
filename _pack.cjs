// CRX3 packer: 写入保留目录结构的 zip，再用 .pem 私钥签 CRX3 头。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const VERSION = MANIFEST.version;
const NAME = MANIFEST.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const STAGE = path.join(ROOT, 'output', `${NAME}-${VERSION}`);
const CRX = path.join(ROOT, 'output', `${NAME}-${VERSION}.crx`);
const PEM = path.join(ROOT, `${NAME}.pem`);

if (!fs.existsSync(PEM)) { console.error('missing', PEM); process.exit(1); }

const ENTRIES = [
  'manifest.json',
  'background.js',
  'content.js',
  'popup/popup.html',
  'popup/popup.js',
  'popup/popup.css',
  'options/options.html',
  'options/options.js',
  'options/options.css',
  'lib/util.js',
  'lib/storage.js',
  'lib/scraper.js',
  'lib/xapi.js',
  'lib/ai.js',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
];

fs.rmSync(STAGE, { recursive: true, force: true });
fs.rmSync(CRX, { force: true });
fs.mkdirSync(STAGE, { recursive: true });

const items = [];
for (const rel of ENTRIES) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) { console.warn('skip missing', rel); continue; }
  const dst = path.join(STAGE, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const data = fs.readFileSync(src);
  fs.writeFileSync(dst, data);
  // Use forward slashes for the zip entry name (zip standard)
  const entryName = rel.split(path.sep).join('/');
  items.push({ name: entryName, data });
  console.log('  added', entryName, data.length, 'bytes');
}

// ---- Build a minimal ZIP (store mode, no compression) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }

const localChunks = [];
const central = [];
let offset = 0;
for (const it of items) {
  const nameBuf = Buffer.from(it.name, 'utf8');
  const crc = crc32(it.data);
  const size = it.data.length;
  // Local file header
  const local = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),     // signature
    u16(20),                                     // version needed
    u16(0),                                      // flags
    u16(0),                                      // method = stored
    u16(0),                                      // mod time
    u16(0x21),                                   // mod date (arbitrary)
    u32(crc),
    u32(size),                                   // compressed size
    u32(size),                                   // uncompressed size
    u16(nameBuf.length),
    u16(0),                                      // extra
    nameBuf,
    it.data,
  ]);
  localChunks.push(local);
  // Central directory header
  const cd = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x01, 0x02]),
    u16(20),                                     // version made by
    u16(20),                                     // version needed
    u16(0),
    u16(0),
    u16(0),
    u16(0x21),
    u32(crc),
    u32(size),
    u32(size),
    u16(nameBuf.length),
    u16(0),                                      // extra
    u16(0),                                      // comment
    u16(0),                                      // disk
    u16(0),                                      // internal attrs
    u32(0),                                      // external attrs
    u32(offset),
    nameBuf,
  ]);
  central.push(cd);
  offset += local.length;
}
const localPart = Buffer.concat(localChunks);
const centralPart = Buffer.concat(central);
const eocd = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  u16(0),                                       // disk
  u16(0),                                       // disk with central dir
  u16(items.length),
  u16(items.length),
  u32(centralPart.length),
  u32(localPart.length),
  u16(0),                                       // comment length
]);
const zipBuf = Buffer.concat([localPart, centralPart, eocd]);
console.log('zip size:', zipBuf.length, 'entries:', items.length);

// ---- CRX3 header ----
const pem = fs.readFileSync(PEM);
const pub = crypto.createPublicKey({ key: pem, format: 'pem' });
const pubDer = pub.export({ type: 'spki', format: 'der' });
const zipSha = crypto.createHash('sha256').update(zipBuf).digest();

// Protobuf fields: 2=GUID, 3=pubkey, 5=sha256
function varint(n) {
  const out = [];
  let x = n;
  while (x >= 0x80) { out.push((x & 0x7f) | 0x80); x = Math.floor(x / 0x80); }
  out.push(x & 0x7f);
  return Buffer.from(out);
}
function fieldLenDelim(tag, payload) {
  return Buffer.concat([varint((tag << 3) | 2), varint(payload.length), payload]);
}
const protoHeader = Buffer.concat([
  fieldLenDelim(2, Buffer.alloc(16, 0)),
  fieldLenDelim(3, pubDer),
  fieldLenDelim(5, zipSha),
]);

// Sign: the "signed data" is the protobuf header (this is what Chrome verifies).
// CRX3 layout: "Cr24" | version(u32) | headerLength(u32) | signedHeader | zip
const sig = crypto.sign('SHA256', protoHeader, { key: pem, padding: crypto.constants.RSA_PKCS1_PADDING });
const signedHeader = Buffer.concat([sig, protoHeader]);
const finalBuf = Buffer.concat([
  Buffer.from('Cr24', 'utf8'),
  Buffer.alloc(4),                              // version
  Buffer.alloc(4),                              // headerLength
  signedHeader,
  zipBuf,
]);
finalBuf.writeUInt32LE(3, 4);
finalBuf.writeUInt32LE(signedHeader.length, 8);
fs.writeFileSync(CRX, finalBuf);
console.log('wrote', CRX, 'size', finalBuf.length, 'headerLen', signedHeader.length, 'zipOffset', 12 + signedHeader.length);

// Also write a standalone .zip so users can rename to .rar and unzip
const zipOnly = path.join(ROOT, 'output', `${NAME}-${VERSION}.zip`);
fs.writeFileSync(zipOnly, zipBuf);
console.log('wrote', zipOnly, 'size', zipBuf.length);