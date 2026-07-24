import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestDb } from './helpers/build-test-db.js';
import { PgOAuthClientRepository } from '../src/repositories/pg-oauth-client.repository.js';

let db, repo;

before(async () => {
    db = await buildTestDb();
    repo = new PgOAuthClientRepository(db.pool);
});
after(async () => db.stop());
beforeEach(async () => db.truncateAll());

function sampleInput(overrides = {}) {
    return {
        name: 'Test Client', slug: 'test-client', clientId: 'client-abc', clientSecretHash: 'secret-hash-xyz',
        clientType: 'confidential', redirectUris: ['https://app.example.com/callback'],
        allowedScopes: ['openid', 'profile'], allowedGrants: ['authorization_code', 'refresh_token'],
        status: 'PENDING_APPROVAL', metadata: { tier: 'free' },
        ...overrides,
    };
}

test('create returns the client WITHOUT the secret hash by default', async () => {
    const client = await repo.create(sampleInput());
    assert.equal(client.name, 'Test Client');
    assert.equal(client.clientId, 'client-abc');
    assert.deepEqual(client.redirectUris, ['https://app.example.com/callback']);
    assert.deepEqual(client.metadata, { tier: 'free' });
    assert.equal(client.clientSecretHash, undefined, 'secret hash must not leak from create()');
});

test('findByClientId hides the secret hash unless includeSecret is passed', async () => {
    await repo.create(sampleInput());
    const withoutSecret = await repo.findByClientId('client-abc');
    assert.equal(withoutSecret.clientSecretHash, undefined);

    const withSecret = await repo.findByClientId('client-abc', { includeSecret: true });
    assert.equal(withSecret.clientSecretHash, 'secret-hash-xyz');
});

test('findBySlug works and also hides the secret', async () => {
    await repo.create(sampleInput());
    const found = await repo.findBySlug('test-client');
    assert.equal(found.clientId, 'client-abc');
    assert.equal(found.clientSecretHash, undefined);
});

test('updateByClientId patches only provided fields and never SELECT *s the secret', async () => {
    await repo.create(sampleInput());
    const updated = await repo.updateByClientId('client-abc', { name: 'Renamed Client', status: 'ACTIVE' });
    assert.equal(updated.name, 'Renamed Client');
    assert.equal(updated.status, 'ACTIVE');
    assert.equal(updated.clientSecretHash, undefined);

    const stillThere = await repo.findByClientId('client-abc', { includeSecret: true });
    assert.equal(stillThere.clientSecretHash, 'secret-hash-xyz', 'unrelated fields untouched by the patch');
});

test('listMany + countAll paginate and never leak the secret', async () => {
    await repo.create(sampleInput({ slug: 'c1', clientId: 'c1' }));
    await repo.create(sampleInput({ slug: 'c2', clientId: 'c2' }));
    await repo.create(sampleInput({ slug: 'c3', clientId: 'c3' }));

    assert.equal(await repo.countAll(), 3);
    const page = await repo.listMany({ skip: 0, limit: 2 });
    assert.equal(page.length, 2);
    assert.ok(page.every((c) => c.clientSecretHash === undefined));
});
