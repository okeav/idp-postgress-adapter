import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildTestDb } from './helpers/build-test-db.js';
import { PgUserRepository } from '../src/repositories/pg-user.repository.js';

let db, repo;

function hashEmail(email) {
    return crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex');
}
function normalizeEmail(email) {
    return String(email).trim().toLowerCase();
}

before(async () => {
    db = await buildTestDb();
    repo = new PgUserRepository(db.pool, { hashEmail, normalizeEmail });
});
after(async () => db.stop());
beforeEach(async () => db.truncateAll());

test('create assembles profile + externalProviders correctly, and normalizes/hashes the email', async () => {
    const user = await repo.create({
        email: '  Alice@Example.com  ',
        passwordHash: 'hashed-pw',
        status: 'ACTIVE',
        profile: { firstName: 'Alice', lastName: 'A', locale: 'fr' },
        metadata: { plan: 'pro' },
        externalProviders: [{ provider: 'google', providerId: 'g-123', email: 'alice@gmail.com', connectedAt: new Date() }],
    });

    assert.equal(user.email, 'alice@example.com');
    assert.equal(user.status, 'ACTIVE');
    assert.deepEqual(user.profile, { firstName: 'Alice', lastName: 'A', displayName: null, avatarUrl: null, locale: 'fr', zoneinfo: null });
    assert.deepEqual(user.metadata, { plan: 'pro' });
    assert.equal(user.externalProviders.length, 1);
    assert.equal(user.externalProviders[0].providerId, 'g-123');

    const { rows: [row] } = await db.pool.query('SELECT email_hash FROM idp_users WHERE id = $1', [user.id]);
    assert.equal(row.email_hash, hashEmail('alice@example.com'));
});

test('findById default select hides passwordHash/mfaSecret/mfaTempSecret/mfaRecoveryCodes', async () => {
    const created = await repo.create({ email: 'a@example.com', passwordHash: 'secret-hash' });
    const found = await repo.findById(created.id);
    assert.equal(found.passwordHash, undefined);
    assert.equal(found.mfaSecret, undefined);
    assert.equal(found.email, 'a@example.com'); // default-visible field still present
});

test('findById with "+passwordHash" (all-modifier mode) adds it back WITHOUT dropping other default fields', async () => {
    const created = await repo.create({ email: 'b@example.com', passwordHash: 'secret-hash', status: 'ACTIVE' });
    const found = await repo.findById(created.id, { select: '+passwordHash' });
    assert.equal(found.passwordHash, 'secret-hash');
    assert.equal(found.status, 'ACTIVE'); // still present — this is NOT an inclusion list
    assert.equal(found.mfaSecret, undefined); // still hidden — wasn't added back
});

test('findById with "email status" (inclusion mode) returns ONLY id + those two fields', async () => {
    const created = await repo.create({ email: 'c@example.com', passwordHash: 'x', status: 'ACTIVE' });
    const found = await repo.findById(created.id, { select: 'email status' });
    assert.deepEqual(Object.keys(found).sort(), ['email', 'id', 'status']);
});

test('findByEmail is case/whitespace-insensitive via normalization', async () => {
    await repo.create({ email: 'Dana@Example.com' });
    const found = await repo.findByEmail('  dana@example.com  ');
    assert.ok(found);
    assert.equal(found.email, 'dana@example.com');
});

test('findByExternalProvider finds the linked user', async () => {
    const created = await repo.create({
        email: 'e@example.com', status: 'ACTIVE',
        externalProviders: [{ provider: 'github', providerId: 'gh-1', email: 'e@example.com' }],
    });
    const found = await repo.findByExternalProvider('github', 'gh-1');
    assert.equal(found.id, created.id);
    assert.equal(await repo.findByExternalProvider('github', 'nonexistent'), null);
});

test('updateById with dotted profile.* keys maps into the flattened columns', async () => {
    const created = await repo.create({ email: 'f@example.com', profile: { firstName: 'Old' } });
    const updated = await repo.updateById(created.id, { 'profile.firstName': 'New', 'profile.locale': 'de' });
    assert.equal(updated.profile.firstName, 'New');
    assert.equal(updated.profile.locale, 'de');
});

test('updateById mixing plain columns + a full mfaRecoveryCodes replace in ONE call (confirmMfaHandler shape)', async () => {
    const created = await repo.create({ email: 'g@example.com' });
    const updated = await repo.updateById(created.id, {
        mfaEnabled: true,
        mfaSecret: 'TOTP_SECRET',
        mfaTempSecret: null,
        mfaRecoveryCodes: [{ codeHash: 'hash-0', usedAt: null }, { codeHash: 'hash-1', usedAt: null }],
    }, { select: '+mfaSecret +mfaRecoveryCodes' });

    assert.equal(updated.mfaEnabled, true);
    assert.equal(updated.mfaSecret, 'TOTP_SECRET');
    assert.equal(updated.mfaRecoveryCodes.length, 2);
    assert.equal(updated.mfaRecoveryCodes[0].codeHash, 'hash-0');
    assert.equal(updated.mfaRecoveryCodes[1].codeHash, 'hash-1');
});

test('updateById with mfaRecoveryCodes: [] clears all recovery codes (disableMfaHandler shape)', async () => {
    const created = await repo.create({ email: 'h@example.com' });
    await repo.updateById(created.id, { mfaRecoveryCodes: [{ codeHash: 'x', usedAt: null }] });
    const cleared = await repo.updateById(created.id, { mfaEnabled: false, mfaSecret: null, mfaRecoveryCodes: [] }, { select: '+mfaRecoveryCodes' });
    assert.equal(cleared.mfaEnabled, false);
    assert.deepEqual(cleared.mfaRecoveryCodes, []);
});

test('updateById with a dotted mfaRecoveryCodes.<idx>.usedAt consumes exactly that one code by position', async () => {
    const created = await repo.create({ email: 'i@example.com' });
    await repo.updateById(created.id, { mfaRecoveryCodes: [
        { codeHash: 'c0', usedAt: null }, { codeHash: 'c1', usedAt: null }, { codeHash: 'c2', usedAt: null },
    ] });

    const usedAt = new Date();
    const updated = await repo.updateById(created.id, { 'mfaRecoveryCodes.1.usedAt': usedAt }, { select: '+mfaRecoveryCodes' });

    assert.equal(updated.mfaRecoveryCodes[0].usedAt, null);
    assert.ok(updated.mfaRecoveryCodes[1].usedAt);
    assert.equal(updated.mfaRecoveryCodes[2].usedAt, null);
    // order must be preserved by position, not insertion/update order
    assert.equal(updated.mfaRecoveryCodes[0].codeHash, 'c0');
    assert.equal(updated.mfaRecoveryCodes[1].codeHash, 'c1');
    assert.equal(updated.mfaRecoveryCodes[2].codeHash, 'c2');
});

test('incrementFailedLoginAttempts is atomic and returns the post-increment user', async () => {
    const created = await repo.create({ email: 'j@example.com' });
    await repo.incrementFailedLoginAttempts(created.id);
    const second = await repo.incrementFailedLoginAttempts(created.id);
    assert.equal(second.failedLoginAttempts, 2);
});

test('incrementFailedLoginAttempts under concurrent overlapping calls: both land (no lost update)', async () => {
    const created = await repo.create({ email: 'k@example.com' });
    await Promise.all([
        repo.incrementFailedLoginAttempts(created.id),
        repo.incrementFailedLoginAttempts(created.id),
        repo.incrementFailedLoginAttempts(created.id),
    ]);
    const { rows: [row] } = await db.pool.query('SELECT failed_login_attempts FROM idp_users WHERE id = $1', [created.id]);
    assert.equal(row.failed_login_attempts, 3, 'all three concurrent increments must be reflected — a real UPDATE...RETURNING is atomic per row');
});

test('linkExternalProvider adds a link to an existing user', async () => {
    const created = await repo.create({ email: 'l@example.com' });
    const updated = await repo.linkExternalProvider(created.id, { provider: 'microsoft', providerId: 'ms-1', email: 'l@example.com', connectedAt: new Date() });
    assert.equal(updated.externalProviders.length, 1);
    assert.equal(updated.externalProviders[0].provider, 'microsoft');
});

test('deleteById removes the user', async () => {
    const created = await repo.create({ email: 'm@example.com' });
    await repo.deleteById(created.id);
    assert.equal(await repo.findById(created.id), null);
});

test('countAll and findMany exclude hidden fields by default', async () => {
    await repo.create({ email: 'n1@example.com', passwordHash: 'x' });
    await repo.create({ email: 'n2@example.com', passwordHash: 'y' });
    assert.equal(await repo.countAll(), 2);

    const page = await repo.findMany({ skip: 0, limit: 10 });
    assert.equal(page.length, 2);
    assert.ok(page.every((u) => u.passwordHash === undefined));
});
