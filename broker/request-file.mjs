import fs from 'node:fs';
import { fail } from './common.mjs';

const keys = new Set(['id','requestId','provider','project','title','owner','text','cliArgs']);
export function readCreateRequest(filename) {
  const maximum = 128 * 1024;
  let fd;
  try {
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) fail('REQUEST_FILE_INVALID', 'Create request must be a regular JSON file no larger than 128 KiB.');
    const bytes = Buffer.alloc(maximum + 1);
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (length > maximum) fail('REQUEST_FILE_INVALID', 'Create request exceeds 128 KiB.');
    let request;
    try { request = JSON.parse(bytes.subarray(0, length).toString('utf8')); }
    catch { fail('REQUEST_FILE_INVALID', 'Create request contains invalid JSON.'); }
    if (!request || Array.isArray(request) || typeof request !== 'object' || Object.keys(request).some(key => !keys.has(key))) fail('REQUEST_FILE_INVALID', 'Create request contains unsupported fields.');
    return request;
  } catch (error) { if (error.code === 'REQUEST_FILE_INVALID') throw error; fail('REQUEST_FILE_INVALID', `Cannot read create request: ${error.message}`); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
