import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fail, hashPayload } from './common.mjs';

export const IMAGE_LIMITS = Object.freeze({ count: 8, bytes: 10 * 1024 * 1024, totalBytes: 32 * 1024 * 1024 });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function format(bytes) {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii',12,16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0) return ['image/png', 'png'];
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217) return ['image/jpeg', 'jpg'];
  if (bytes.length >= 20 && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) return ['image/webp', 'webp'];
  fail('INVALID_IMAGE', 'Supported image files are PNG, JPEG and WebP. The file header must match the format.');
}

// Snapshot bytes before creating a delivery intent. Never use the shared OS
// clipboard, and never reopen a caller's mutable file while delivering a turn.
export function readImages(input = []) {
  if (!Array.isArray(input) || input.length > IMAGE_LIMITS.count) fail('INVALID_IMAGES', 'Provide an array of at most eight absolute image paths.');
  let total = 0;
  return input.map(filename => {
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || filename.length > 8192 || /[\x00-\x1f\x7f]/.test(filename)) fail('INVALID_IMAGE_PATH', 'Each image must have an absolute local path without control characters.');
    let fd;
    try {
      fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size === 0 || stat.size > IMAGE_LIMITS.bytes) fail('INVALID_IMAGE', 'Images must be regular files of at most 10 MiB each.');
      const bytes = Buffer.alloc(stat.size + 1);
      let length = 0, count;
      while (length < bytes.length && (count = fs.readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
      const after = fs.fstatSync(fd);
      if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) fail('IMAGE_CHANGED', 'Image changed while being read; retry only after the source is stable.');
      total += length;
      if (total > IMAGE_LIMITS.totalBytes) fail('IMAGES_TOO_LARGE', 'A request can contain at most 32 MiB of image data.');
      const data = bytes.subarray(0, length);
      const [mimeType, extension] = format(data);
      return { sourcePath: filename, sha256: digest(data), mimeType, extension, size: length, data };
    } catch (error) {
      if (['INVALID_IMAGE','IMAGES_TOO_LARGE','IMAGE_CHANGED'].includes(error.code)) throw error;
      fail('IMAGE_UNREADABLE', `Cannot read image ${filename}: ${error.message}`);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  });
}

export function imagePayloadHash(text, images) {
  // Preserve the identity of all existing text-only request receipts.
  return images.length ? hashPayload(JSON.stringify({ text, images: images.map(({ sourcePath, sha256 }) => ({ sourcePath, sha256 })) })) : hashPayload(text);
}

export function stageImages(config, images) {
  if (!images.length) return [];
  const directory = path.join(config.home, 'attachments');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) fail('UNSAFE_ATTACHMENTS', 'Attachment storage must be a directory owned by the current user.');
  fs.chmodSync(directory, 0o700);
  return images.map(({ data, extension, ...metadata }) => {
    const storedPath = path.join(directory, metadata.sha256 + '.' + extension);
    const temporary = path.join(directory, randomUUID() + '.tmp');
    fs.writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' });
    try {
      try { fs.linkSync(temporary, storedPath); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = readImages([storedPath])[0];
        if (existing.sha256 !== metadata.sha256) fail('ATTACHMENT_CORRUPT', 'A stored attachment has changed. No prompt was delivered.');
      }
    } finally { fs.unlinkSync(temporary); }
    return { ...metadata, storedPath };
  });
}

export function imagePrompt(provider, text, images) {
  if (provider !== 'claude' || !images.length) return text;
  // Claude resolves quoted @file mentions into native image content before
  // inference. JSON quoting here is its mention syntax, never shell code.
  return images.map(image => '@' + JSON.stringify(image.storedPath)).join('\n') + '\n\n' + text;
}

export function withoutCodexImagePrefix(prompt, count) {
  let text = prompt;
  for (let index = 1; index <= count; index++) {
    const marker = `[Image #${index}]`;
    if (!text.startsWith(marker)) return null;
    text = text.slice(marker.length).trimStart();
  }
  return text;
}
