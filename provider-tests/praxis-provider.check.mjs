import test from 'node:test';
import assert from 'node:assert/strict';
import { describe, getCards, getDataInventory } from '../praxis-provider.mjs';

const fixture = {
  "list_assignments": {
    "assignments": [
      {
        "id": "assignment",
        "title": "Review fictional field notes",
        "revision": 3
      }
    ]
  },
  "get_assignment": {
    "revision": 3,
    "assignment": {
      "id": "assignment",
      "title": "Review fictional field notes",
      "status": "active"
    },
    "segments": [
      {
        "segmentId": "segment-1",
        "originalText": "Compare the marked observation with its source.",
        "correctedText": "Compare the marked observation with its source.",
        "startMs": 1000,
        "endMs": 4000,
        "status": "unreviewed"
      }
    ]
  }
};
const manifest = describe();
function context(values = fixture) {
  return { spaces: ['synthetic'], actor: { userId: 'synthetic-user', username: 'synthetic-name' }, now: Date.parse('2026-11-19T12:00:00Z'),
    invoke: async request => { assert.equal(request.spaceId, 'synthetic'); assert.ok(manifest.readOperations.includes(request.operation)); assert.equal(request.expectedRevision, undefined); assert.equal(request.idempotencyKey, undefined); assert.ok(values[request.operation], `Unexpected read ${request.operation}`); return structuredClone(values[request.operation]); },
    readNative: async request => { assert.ok(manifest.nativeReads.includes(request.path)); assert.equal(request.resourceId, manifest.nativeResourceId); return structuredClone(values.native); } };
}
test('source-backed card retains native object identity, version, preview and evidence without writes', async () => {
  const before = JSON.stringify(fixture), first = await getCards(context()), second = await getCards(context());
  assert.equal(first.status, 'ready'); assert.equal(first.items.length, 1);
  const item = first.items[0];
  assert.equal(item.appId, manifest.appId); assert.ok(item.id.includes(manifest.appId)); assert.ok(item.resourceId); assert.ok(item.revision); assert.ok(item.title);
  assert.ok(item.preview); assert.ok(item.primaryAction.href.startsWith('/apps/')); assert.equal(item.source.href, item.primaryAction.href); assert.equal(item.source.revision, item.revision);
  assert.ok(item.evidence.length); assert.deepEqual(second.items, first.items); assert.equal(JSON.stringify(fixture), before);
  assert.ok(!JSON.stringify(first).includes('Other person private task'));
});
test('a true empty authorized source is distinct from missing read support', async () => {
  const empty = structuredClone(fixture);
  for (const value of Object.values(empty)) {
    for (const key of ['items','topics','records','assignments','decks','materials']) if (Array.isArray(value[key])) value[key] = [];
  }
  if (empty.native?.data) { empty.native.data.transactions = []; empty.native.data.accounts = []; empty.native.data.history = []; }
  assert.deepEqual((await getCards(context(empty))).items, []);
  assert.equal((await getCards(context(empty))).status, 'empty');
  assert.equal((await getCards({})).status, 'unavailable');
});
test('read failures remain unavailable and never reveal raw diagnostics or pretend to be empty', async () => {
  const broken = context(); const reject = async () => { throw new Error('sensitive-private-diagnostic'); };
  broken.invoke = reject; broken.readNative = reject;
  const output = await getCards(broken);
  assert.equal(output.status, 'unavailable'); assert.deepEqual(output.items, []);
  assert.ok(!JSON.stringify(output).includes('sensitive-private-diagnostic'));
});
test('a failed independent source retains successful cards and reports partial coverage', async () => {
  if (manifest.resourceMode === 'native-view') return;
  const mixed = context(), read = mixed.invoke; mixed.spaces.push('offline');
  mixed.invoke = async request => { if (request.spaceId === 'offline') throw new Error('offline'); return read(request); };
  const output = await getCards(mixed); assert.equal(output.status, 'partial'); assert.equal(output.items.length, 1); assert.ok(output.errors.length);
});
test('app-owned inventory resolves declared metadata and excludes callback secrets', async () => {
  const calls = [];
  const output = await getDataInventory({ resolveDataSource: async descriptor => { calls.push(descriptor); return { hostPath: '/synthetic/private/' + descriptor.id, containerPath: '/data/' + descriptor.id, secret: 'must-not-escape' }; } });
  assert.equal(output.status, 'ready'); assert.equal(output.items.length, manifest.dataSources.length);
  assert.deepEqual(calls, manifest.dataSources); assert.ok(!JSON.stringify(output).includes('must-not-escape'));
  assert.ok(!JSON.stringify(manifest.dataSources).match(/(?:KEY_FILE|PASSWORD|TOKEN|SECRET)/));
});
test('unresolved inventory remains visible as unavailable rather than fabricated paths', async () => {
  const output = await getDataInventory({ resolveDataSource: async () => null });
  assert.equal(output.status, 'unavailable'); assert.equal(output.items.length, manifest.dataSources.length);
  assert.ok(output.items.every(item => item.status === 'unavailable' && !item.hostPath));
});

test('updates coalesce by object and content changes advance a stable card identity', async () => {
  const before = await getCards(context());
  const duplicate = structuredClone(fixture);
  for (const value of Object.values(duplicate)) for (const key of ['items','topics','assignments','decks','materials']) {
    if (Array.isArray(value[key]) && value[key].length) value[key].push(structuredClone(value[key][0]));
  }
  assert.equal((await getCards(context(duplicate))).items.length, 1);
  const changed = structuredClone(fixture);
  function advance(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key,child] of Object.entries(value)) {
      if (key === 'revision') value[key] = typeof child === 'number' ? child + 1 : String(Number(child) + 1);
      else if (key === 'version') value[key] = Number(child) + 1;
      else advance(child);
    }
  }
  advance(changed);
  if (changed.native?.materials?.[0]) changed.native.materials[0].summary += ' Revised source.';
  const after = await getCards(context(changed));
  assert.equal(after.items[0].id, before.items[0].id);
  assert.notEqual(after.items[0].revision, before.items[0].revision);
});

test('an application-only path retains its namespace without fabricated host or container bindings', async () => {
  const value = await getDataInventory({ resolveDataSource: async descriptor => ({ status: 'ready', applicationPath: '/synthetic/application/' + descriptor.id }) });
  assert.equal(value.status, 'ready'); assert.equal(value.items.length, manifest.dataSources.length);
  for (const item of value.items) { assert.ok(item.applicationPath.startsWith('/synthetic/application/')); assert.equal(item.hostPath, undefined); assert.equal(item.containerPath, undefined); }
});
