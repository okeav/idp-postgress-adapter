import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestDb } from './helpers/build-test-db.js';
import { PgServiceKeyRepository } from '../src/repositories/pg-service-key.repository.js';

let db, repo;

before(async () => {
    db = await buildTestDb();
    repo = new PgServiceKeyRepository(db.pool);
});
after(async () => db.stop());
beforeEach(async () => db.truncateAll());

test('upsertByKid creates a new key, ACTIVE by default', async () => {
    const key = await repo.upsertByKid({ kid: 'svc-a:kid1', name: 'svc-a', publicKey: 'PEM1', region: 'us' });
    assert.equal(key.kid, 'svc-a:kid1');
    assert.equal(key.name, 'svc-a');
    assert.equal(key.status, 'ACTIVE');
    assert.equal(key.region, 'us');
    assert.ok(key.registeredAt);
});

test('upsertByKid re-registering the same kid updates fields but preserves registeredAt', async () => {
    const first = await repo.upsertByKid({ kid: 'svc-b:kid1', name: 'svc-b', publicKey: 'PEM1', region: 'us' });
    await new Promise((r) => setTimeout(r, 20));
    const second = await repo.upsertByKid({ kid: 'svc-b:kid1', name: 'svc-b-renamed', publicKey: 'PEM2', region: 'eu' });

    assert.equal(second.name, 'svc-b-renamed');
    assert.equal(second.publicKey, 'PEM2');
    assert.equal(second.region, 'eu');
    assert.equal(new Date(second.registeredAt).getTime(), new Date(first.registeredAt).getTime());
    assert.ok(new Date(second.lastSeenAt).getTime() >= new Date(first.lastSeenAt).getTime());
});

test('listPublishable returns only ACTIVE/ROTATING keys', async () => {
    await repo.upsertByKid({ kid: 'k1', name: 'n1', publicKey: 'p1' });
    await repo.upsertByKid({ kid: 'k2', name: 'n2', publicKey: 'p2' });
    await db.pool.query(`UPDATE idp_service_keys SET status = 'REVOKED' WHERE kid = 'k2'`);

    const publishable = await repo.listPublishable();
    assert.equal(publishable.length, 1);
    assert.equal(publishable[0].kid, 'k1');
});
