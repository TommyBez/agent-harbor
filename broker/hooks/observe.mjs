import fs from 'node:fs';
import path from 'node:path';

// Observation only: never grant a permission or alter a provider decision.
try {
  const { HARBOR_HOME: home, HARBOR_SESSION_ID: sessionId, HARBOR_RUN_ID: runId } = process.env;
  const provider = process.argv[2];
  if (!home || !/^[0-9a-f-]{36}$/.test(sessionId || '') || !/^[0-9a-f-]{36}$/.test(runId || '') || !['claude', 'codex'].includes(provider)) throw new Error('Missing launch identity');
  const raw = fs.readFileSync(0, 'utf8');
  if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new Error('Hook event exceeds 4 MiB');
  const event = JSON.parse(raw);
  fs.appendFileSync(path.join(home, 'runs', runId, 'events.jsonl'), JSON.stringify({ time: new Date().toISOString(), sessionId, runId, provider, event }) + '\n', { encoding: 'utf8', mode: 0o600 });
} catch (error) { process.stderr.write(`Agent Harbor observer: ${error.message}\n`); }
process.stdout.write('{}\n');
