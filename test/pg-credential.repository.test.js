import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildTestDb } from './helpers/build-test-db.js';
import { PgCredentialRepository } from '../src/repositories/pg-credential.repository.js';

let db, repo, userId, otherUserId;

before(async () => {
    db = await buildTestDb();
    repo = new PgCredentialRepository(db.pool);
});
after(async () => db.stop());
beforeEach(async () => {
    await db.truncateAll();
    userId = crypto.randomUUID();
    otherUserId = crypto.randomUUID();
    await db.pool.query(`INSERT INTO idp_users (id, email) VALUES ($1, 'a@example.com'), ($2, 'b@example.com')`, [userId, otherUserId]);
});

test('create + findByCredentialId round-trip', async () => {
    const created = await repo.create({ userId, credentialId: 'cred-1', publicKey: 'b64pub', counter: 0, transports: ['internal'], deviceType: 'singleDevice', backedUp: false, name: 'My Key' });
    assert.equal(created.user, userId);
    assert.equal(created.credentialId, 'cred-1');
    assert.equal(created.counter, 0);
    assert.deepEqual(created.transports, ['internal']);

    const found = await repo.findByCredentialId('cred-1');
    assert.equal(found.credentialId, 'cred-1');
    assert.equal(found.name, 'My Key');
});

test('findByUserId scopes to the right user, countForUser matches', async () => {
    await repo.create({ userId, credentialId: 'cred-a', publicKey: 'p', counter: 0 });
    await repo.create({ userId, credentialId: 'cred-b', publicKey: 'p', counter: 0 });
    await repo.create({ userId: otherUserId, credentialId: 'cred-c', publicKey: 'p', counter: 0 });

    const mine = await repo.findByUserId(userId);
    assert.equal(mine.length, 2);
    assert.equal(await repo.countForUser(userId), 2);
    assert.equal(await repo.countForUser(otherUserId), 1);
});

test('updateCounter bumps counter and lastUsedAt', async () => {
    await repo.create({ userId, credentialId: 'cred-x', publicKey: 'p', counter: 0 });
    await repo.updateCounter('cred-x', 5);
    const found = await repo.findByCredentialId('cred-x');
    assert.equal(found.counter, 5);
    assert.ok(found.lastUsedAt);
});

test('deleteByCredentialId is scoped to the claimed owner', async () => {
    await repo.create({ userId, credentialId: 'cred-y', publicKey: 'p', counter: 0 });
    await repo.deleteByCredentialId('cred-y', otherUserId); // wrong owner — should not delete
    assert.ok(await repo.findByCredentialId('cred-y'));

    await repo.deleteByCredentialId('cred-y', userId); // right owner
    assert.equal(await repo.findByCredentialId('cred-y'), null);
});
