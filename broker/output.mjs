import { randomUUID } from 'node:crypto';
import { fail } from './common.mjs';

const processPrefix = randomUUID();
let sequence = 0;
// Native retained-widget command readers have a bounded line buffer. A snapshot
// commits only after its end frame, so pagination never exposes partial state.
export function* snapshotLines(result, maximumBytes = 100 * 1024) {
  const snapshotId = processPrefix + ':' + ++sequence;
  yield JSON.stringify({ type: 'snapshot-begin', snapshotId, count: result.sessions.length });
  let sessions = [], bytes = 0;
  const overhead = Buffer.byteLength(JSON.stringify({ type: 'snapshot-chunk', snapshotId, sessions: [] })) + 1;
  for (const session of result.sessions) {
    const size = Buffer.byteLength(JSON.stringify(session));
    if (size + overhead > maximumBytes) fail('SNAPSHOT_ITEM_TOO_LARGE', 'One session exceeds the snapshot frame budget.');
    if (sessions.length && overhead + bytes + size + sessions.length > maximumBytes) {
      yield JSON.stringify({ type: 'snapshot-chunk', snapshotId, sessions });
      sessions = []; bytes = 0;
    }
    sessions.push(session); bytes += size;
  }
  if (sessions.length) yield JSON.stringify({ type: 'snapshot-chunk', snapshotId, sessions });
  yield JSON.stringify({ type: 'snapshot-end', snapshotId });
}
