const fs = require('fs/promises');
const path = require('path');

function parseExifDate(value) {
  if (!value) return null;
  const m = String(value).trim().match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : null;
}

function jpegDimensions(buffer) {
  if (buffer.length < 4 || buffer.readUInt16BE(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 4 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker === 0xda) break;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
      if (offset + 7 < buffer.length) {
        return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
      }
    }
    offset += length;
  }
  return null;
}

function pngDimensions(buffer) {
  if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function webpDimensions(buffer) {
  if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return null;
  const kind = buffer.toString('ascii', 12, 16);
  if (kind === 'VP8X' && buffer.length >= 30) {
    const w = 1 + buffer[24] + (buffer[25] << 8) + (buffer[26] << 16);
    const h = 1 + buffer[27] + (buffer[28] << 8) + (buffer[29] << 16);
    return { width: w, height: h };
  }
  return null;
}

function readAscii(buffer, offset, length) {
  if (offset < 0 || length < 0 || offset + length > buffer.length) return null;
  return buffer.subarray(offset, offset + length).toString('utf8').replace(/\0+$/, '').trim();
}

function parseExif(buffer) {
  if (buffer.length < 4 || buffer.readUInt16BE(0) !== 0xffd8) return {};
  let offset = 2;
  while (offset + 4 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xda || marker === 0xd9) break;
    if (offset + 2 > buffer.length) break;
    const len = buffer.readUInt16BE(offset);
    if (len < 2 || offset + len > buffer.length) break;
    if (marker === 0xe1 && buffer.toString('ascii', offset + 2, offset + 8) === 'Exif\0\0') {
      const tiffStart = offset + 8;
      return parseTiff(buffer, tiffStart);
    }
    offset += len;
  }
  return {};
}

function parseTiff(buffer, tiffStart) {
  if (tiffStart + 8 > buffer.length) return {};
  const order = buffer.toString('ascii', tiffStart, tiffStart + 2);
  const le = order === 'II';
  if (!le && order !== 'MM') return {};
  const u16 = off => off + 2 <= buffer.length ? (le ? buffer.readUInt16LE(off) : buffer.readUInt16BE(off)) : null;
  const u32 = off => off + 4 <= buffer.length ? (le ? buffer.readUInt32LE(off) : buffer.readUInt32BE(off)) : null;
  const typeSize = {1:1,2:1,3:2,4:4,5:8,7:1,9:4,10:8};

  function valueBytes(type, count, valuePos) {
    const bytes = (typeSize[type] || 1) * count;
    const start = bytes <= 4 ? valuePos : tiffStart + (u32(valuePos) || 0);
    if (start < 0 || start + bytes > buffer.length) return null;
    return { start, bytes };
  }

  function rationalAt(start, signed = false) {
    if (start + 8 > buffer.length) return null;
    const n = signed ? (le ? buffer.readInt32LE(start) : buffer.readInt32BE(start)) : u32(start);
    const d = signed ? (le ? buffer.readInt32LE(start + 4) : buffer.readInt32BE(start + 4)) : u32(start + 4);
    if (!d) return null;
    return n / d;
  }

  function readValue(type, count, valuePos) {
    const vb = valueBytes(type, count, valuePos);
    if (!vb) return null;
    const { start } = vb;
    if (type === 2) return readAscii(buffer, start, count);
    if (type === 3) return count === 1 ? u16(start) : Array.from({length:count}, (_,i)=>u16(start+i*2));
    if (type === 4) return count === 1 ? u32(start) : Array.from({length:count}, (_,i)=>u32(start+i*4));
    if (type === 5) return count === 1 ? rationalAt(start) : Array.from({length:count}, (_,i)=>rationalAt(start+i*8));
    if (type === 10) return count === 1 ? rationalAt(start, true) : Array.from({length:count}, (_,i)=>rationalAt(start+i*8, true));
    if (type === 1 || type === 7) return count === 1 ? buffer[start] : Array.from(buffer.subarray(start, start + count));
    return null;
  }

  function readIfd(relativeOffset) {
    const base = tiffStart + relativeOffset;
    if (base + 2 > buffer.length) return new Map();
    const count = u16(base);
    if (count == null || count > 4096) return new Map();
    const out = new Map();
    for (let i = 0; i < count; i++) {
      const pos = base + 2 + i * 12;
      if (pos + 12 > buffer.length) break;
      const tag = u16(pos);
      const type = u16(pos + 2);
      const n = u32(pos + 4);
      if (tag == null || type == null || n == null) continue;
      out.set(tag, { value: readValue(type, n, pos + 8), type, count:n });
    }
    return out;
  }

  const firstIfdOffset = u32(tiffStart + 4);
  if (firstIfdOffset == null) return {};
  const ifd0 = readIfd(firstIfdOffset);
  const exifOffset = ifd0.get(0x8769)?.value;
  const gpsOffset = ifd0.get(0x8825)?.value;
  const exifIfd = Number.isInteger(exifOffset) ? readIfd(exifOffset) : new Map();
  const gpsIfd = Number.isInteger(gpsOffset) ? readIfd(gpsOffset) : new Map();

  const exif = {};
  const put = (key, val) => { if (val !== null && val !== undefined && val !== '') exif[key] = val; };
  put('Make', ifd0.get(0x010f)?.value);
  put('Model', ifd0.get(0x0110)?.value);
  put('Orientation', ifd0.get(0x0112)?.value);
  put('ModifyDate', ifd0.get(0x0132)?.value);
  put('DateTimeOriginal', exifIfd.get(0x9003)?.value);
  put('CreateDate', exifIfd.get(0x9004)?.value);
  put('ISO', exifIfd.get(0x8827)?.value);
  put('ExposureTime', exifIfd.get(0x829a)?.value);
  put('FNumber', exifIfd.get(0x829d)?.value);
  put('FocalLength', exifIfd.get(0x920a)?.value);
  put('LensModel', exifIfd.get(0xa434)?.value);

  const latRef = gpsIfd.get(0x0001)?.value;
  const lat = gpsIfd.get(0x0002)?.value;
  const lonRef = gpsIfd.get(0x0003)?.value;
  const lon = gpsIfd.get(0x0004)?.value;
  const toDegrees = parts => Array.isArray(parts) && parts.length >= 3 && parts.every(v => typeof v === 'number')
    ? parts[0] + parts[1] / 60 + parts[2] / 3600
    : null;
  let latitude = toDegrees(lat);
  let longitude = toDegrees(lon);
  if (latitude != null && String(latRef).toUpperCase() === 'S') latitude *= -1;
  if (longitude != null && String(lonRef).toUpperCase() === 'W') longitude *= -1;
  if (latitude != null && longitude != null) exif.GPS = { latitude, longitude };

  return exif;
}

async function readHead(filePath, maxBytes = 1024 * 1024) {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const size = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function extractMetadata(filePath) {
  const stat = await fs.stat(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const head = await readHead(filePath);
  let dimensions = null;
  let exif = {};
  if (ext === '.jpg' || ext === '.jpeg') {
    dimensions = jpegDimensions(head);
    exif = parseExif(head);
  } else if (ext === '.png') {
    dimensions = pngDimensions(head);
  } else if (ext === '.webp') {
    dimensions = webpDimensions(head);
  }

  const exifDate = exif.DateTimeOriginal || exif.CreateDate || exif.ModifyDate || null;
  const shotAt = parseExifDate(exifDate);
  return {
    sizeBytes: stat.size,
    format: ext.slice(1).toUpperCase(),
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
    shotAt,
    exif,
    fileModifiedAt: stat.mtime.toISOString(),
    fileCreatedAt: stat.birthtime?.toISOString?.() || null,
  };
}

module.exports = {
  extractMetadata,
  parseExifDate,
  parseExif,
  jpegDimensions,
  pngDimensions,
  webpDimensions,
};
