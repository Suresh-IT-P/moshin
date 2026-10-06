'use strict';

/**
 * Chromium's MediaRecorder streams WebM files without a Duration in the segment
 * Info, so players report the length as "Infinity" and seeking long recordings is
 * unreliable. fixWebmDuration() adds (or overwrites) the Duration element.
 *
 * Only the first few KB of the file are rewritten; the audio data is streamed
 * through untouched. Unknown layouts are left alone (the function returns false).
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { pipeline } = require('node:stream/promises');

const IDS = {
  EBML: 0x1a45dfa3,
  SEGMENT: 0x18538067,
  SEEK_HEAD: 0x114d9b74,
  INFO: 0x1549a966,
  TIMECODE_SCALE: 0x2ad7b1,
  DURATION: 0x4489,
  CLUSTER: 0x1f43b675,
};
const HEAD_BYTES = 64 * 1024;

/** Element IDs keep their length-marker bits. */
function readId(buf, pos) {
  const first = buf[pos];
  if (first === undefined) return null;
  const len = first & 0x80 ? 1 : first & 0x40 ? 2 : first & 0x20 ? 3 : first & 0x10 ? 4 : 0;
  if (!len || pos + len > buf.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + buf[pos + i];
  return { id, len };
}

/** Element sizes are EBML variable-length integers; all ones means "unknown". */
function readSize(buf, pos) {
  const first = buf[pos];
  if (first === undefined || first === 0) return null;
  let len = 1;
  while (!(first & (0x80 >> (len - 1)))) len++;
  if (pos + len > buf.length) return null;
  const mask = 0xff >> len;
  let value = first & mask;
  let unknown = value === mask;
  for (let i = 1; i < len; i++) {
    value = value * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) unknown = false;
  }
  return { value, len, unknown };
}

function encodeSize(n) {
  for (let len = 1; len <= 8; len++) {
    if (n < 2 ** (7 * len) - 1) {
      const out = Buffer.alloc(len);
      let v = n;
      for (let i = len - 1; i >= 0; i--) {
        out[i] = v % 256;
        v = Math.floor(v / 256);
      }
      out[0] |= 0x80 >> (len - 1);
      return out;
    }
  }
  throw new Error('EBML size too large');
}

function readUInt(buf, pos, len) {
  let value = 0;
  for (let i = 0; i < len; i++) value = value * 256 + buf[pos + i];
  return value;
}

async function replaceFile(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      // Windows may briefly lock the file (antivirus, indexer); retry a few times.
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
        await fsp.rm(from, { force: true });
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
}

async function fixWebmDuration(filePath, durationMs) {
  if (!(durationMs > 0)) return false;

  const handle = await fsp.open(filePath, 'r');
  let head;
  try {
    const { size } = await handle.stat();
    head = Buffer.alloc(Math.min(size, HEAD_BYTES));
    await handle.read(head, 0, head.length, 0);
  } finally {
    await handle.close();
  }

  // EBML header
  const ebml = readId(head, 0);
  if (!ebml || ebml.id !== IDS.EBML) return false;
  const ebmlSize = readSize(head, ebml.len);
  if (!ebmlSize || ebmlSize.unknown) return false;

  // Segment
  const segmentStart = ebml.len + ebmlSize.len + ebmlSize.value;
  const segment = readId(head, segmentStart);
  if (!segment || segment.id !== IDS.SEGMENT) return false;
  const segSizePos = segmentStart + segment.len;
  const segSize = readSize(head, segSizePos);
  if (!segSize) return false;
  const segDataStart = segSizePos + segSize.len;

  // Walk the segment's children until we reach Info (it precedes the first Cluster).
  let pos = segDataStart;
  while (pos < head.length) {
    const child = readId(head, pos);
    const childSize = child && readSize(head, pos + child.len);
    if (!child || !childSize || childSize.unknown) return false;
    // A SeekHead stores absolute offsets that would shift; Chromium never writes one.
    if (child.id === IDS.SEEK_HEAD || child.id === IDS.CLUSTER) return false;

    const dataStart = pos + child.len + childSize.len;
    const dataEnd = dataStart + childSize.value;
    if (child.id !== IDS.INFO) {
      pos = dataEnd;
      continue;
    }
    if (dataEnd > head.length) return false;

    let timecodeScale = 1e6;
    let durationPos = -1;
    let durationLen = 0;
    for (let p = dataStart; p < dataEnd; ) {
      const el = readId(head, p);
      const elSize = el && readSize(head, p + el.len);
      if (!el || !elSize || elSize.unknown) return false;
      const valuePos = p + el.len + elSize.len;
      if (el.id === IDS.TIMECODE_SCALE && elSize.value <= 8) {
        timecodeScale = readUInt(head, valuePos, elSize.value) || 1e6;
      }
      if (el.id === IDS.DURATION) {
        durationPos = valuePos;
        durationLen = elSize.value;
      }
      p = valuePos + elSize.value;
    }
    const duration = (durationMs * 1e6) / timecodeScale;

    if (durationPos !== -1) {
      // Already has a Duration element: overwrite the value in place.
      const value = Buffer.alloc(durationLen);
      if (durationLen === 8) value.writeDoubleBE(duration);
      else if (durationLen === 4) value.writeFloatBE(duration);
      else return false;
      const fh = await fsp.open(filePath, 'r+');
      try {
        await fh.write(value, 0, value.length, durationPos);
      } finally {
        await fh.close();
      }
      return true;
    }

    const durationEl = Buffer.alloc(11);
    durationEl.writeUInt16BE(IDS.DURATION, 0);
    durationEl[2] = 0x88; // payload size: 8 bytes
    durationEl.writeDoubleBE(duration, 3);

    const infoHeader = Buffer.concat([
      head.subarray(pos, pos + child.len),
      encodeSize(childSize.value + durationEl.length),
    ]);
    const growth = infoHeader.length + durationEl.length - (child.len + childSize.len);
    const segmentHeader = segSize.unknown
      ? head.subarray(segmentStart, segDataStart)
      : Buffer.concat([head.subarray(segmentStart, segSizePos), encodeSize(segSize.value + growth)]);

    const newHead = Buffer.concat([
      head.subarray(0, segmentStart),
      segmentHeader,
      head.subarray(segDataStart, pos),
      infoHeader,
      head.subarray(dataStart, dataEnd),
      durationEl,
    ]);

    const tmpPath = `${filePath}.tmp`;
    const out = fs.createWriteStream(tmpPath);
    out.write(newHead);
    await pipeline(fs.createReadStream(filePath, { start: dataEnd }), out);
    await replaceFile(tmpPath, filePath);
    return true;
  }
  return false;
}

module.exports = { fixWebmDuration };
