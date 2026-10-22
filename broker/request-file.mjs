import fs from 'node:fs';
import { fail } from './common.mjs';

const createKeys = new Set(['id','requestId','provider','project','title','owner','text','cliArgs','images','start']);
const turnKeys = new Set(['id','requestId','actor','text','images']);
export function readRequest(filename, action = 'create') {
  if (!['create','send','start','resume'].includes(action)) fail('REQUEST_FILE_INVALID', 'Request files support create, send, start and resume.');
  const keys = action === 'create' ? createKeys : turnKeys;
  const maximum = 128 * 1024;
  let fd;
  try {
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) fail('REQUEST_FILE_INVALID', 'Request must be a regular JSON file no larger than 128 KiB.');
    const bytes = Buffer.alloc(maximum + 1);
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (length > maximum) fail('REQUEST_FILE_INVALID', 'Request exceeds 128 KiB.');
    let request;
    try { request = JSON.parse(bytes.subarray(0, length).toString('utf8')); }
    catch { fail('REQUEST_FILE_INVALID', 'Request contains invalid JSON.'); }
    if (!request || Array.isArray(request) || typeof request !== 'object' || Object.keys(request).some(key => !keys.has(key))) fail('REQUEST_FILE_INVALID', 'Request contains unsupported fields.');
    return request;
  } catch (error) { if (error.code === 'REQUEST_FILE_INVALID') throw error; fail('REQUEST_FILE_INVALID', `Cannot read request: ${error.message}`); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
export const readCreateRequest = filename => readRequest(filename, 'create');
