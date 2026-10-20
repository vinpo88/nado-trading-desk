import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseWorkerArgs } from '../worker.mjs';

test('connection resume CLI requires a specific attention event and member config', () => {
  const attentionId = randomUUID();
  assert.deepEqual(parseWorkerArgs(['resume-connection', '--config', 'edge.json', '--attention-id', attentionId]),
    { command: 'resume-connection', config: 'edge.json', 'attention-id': attentionId });
  for (const args of [
    ['resume-connection', '--config', 'edge.json'],
    ['resume-connection', '--attention-id', attentionId],
    ['resume-connection', '--config', 'edge.json', '--attention-id', 'latest'],
    ['resume-connection', '--config', 'edge.json', '--attention-id', attentionId, '--attention-id', attentionId],
    ['resume-connection', '--config', 'edge.json', '--attention-id', attentionId, '--run-id', randomUUID()],
    ['resume-connection', '--config', 'edge.json', '--attention-id', attentionId, '--digest', '0'.repeat(64)],
    ['start', '--config', 'edge.json', '--attention-id', attentionId],
    ['stop', '--config', 'edge.json', '--attention-id', attentionId],
    ['status', '--config', 'edge.json', '--attention-id', attentionId],
  ]) assert.throws(() => parseWorkerArgs(args), { code: 'CONFIG_INVALID' });
});
