import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildTestDb } from './helpers/build-test-db.js';
import { PgVerificationTokenRepository } from '../src/repositories/pg-verification-token.repository.js';

let db, repo, userId;

before(async () => {
    db = await buildTestDb();
    repo = new PgVerificationTokenRepository(db.pool);
});
after(async () => db.stop());
beforeEach(async () => {
    await db.truncateAll();
    userId = crypto.randomUUID();
    await db.pool.query(`INSERT INTO idp_users (id, email) VALUES ($1, 'a@example.com')`, [userId]);
});

test('email_verification: consumeByHash DELETES the row (single-use-by-deletion)', async () => {
    await repo.create('email_verification', { user: userId, tokenHash: 'hash1', expiresAt: new Date(Date.now() + 60_000) });

    const consumed = await repo.consumeByHash('email_verification', 'hash1');
    assert.ok(consumed);
    assert.equal(consumed.user, userId);

    const { rows } = await db.pool.query('SELECT * FROM idp_verification_tokens');
    assert.equal(rows.length, 0, 'row must be gone after consuming, not just flagged');

    const secondAttempt = await repo.consumeByHash('email_verification', 'hash1');
    assert.equal(secondAttempt, null);
});

test('magic_link: consumeByHash also DELETES the row', async () => {
    await repo.create('magic_link', { user: userId, tokenHash: 'hash2', expiresAt: new Date(Date.now() + 60_000) });
    await repo.consumeByHash('magic_link', 'hash2');
    const { rows } = await db.pool.query('SELECT * FROM idp_verification_tokens');
    assert.equal(rows.length, 0);
});

test('password_reset: consumeByHash flags used_at instead of deleting', async () => {
    await repo.create('password_reset', { user: userId, tokenHash: 'hash3', expiresAt: new Date(Date.now() + 60_000) });

    const consumed = await repo.consumeByHash('password_reset', 'hash3');
    assert.ok(consumed);

    const { rows } = await db.pool.query('SELECT * FROM idp_verification_tokens');
    assert.equal(rows.length, 1, 'password_reset row stays, just flagged');
    assert.ok(rows[0].used_at);

    const secondAttempt = await repo.consumeByHash('password_reset', 'hash3');
    assert.equal(secondAttempt, null, 'cannot reuse an already-consumed password_reset token');
});

test('consumeByHash scopes to userId when provided', async () => {
    const otherUserId = crypto.randomUUID();
    await db.pool.query(`INSERT INTO idp_users (id, email) VALUES ($1, 'b@example.com')`, [otherUserId]);
    await repo.create('password_reset', { user: userId, tokenHash: 'hash4', expiresAt: new Date(Date.now() + 60_000) });

    const wrongUser = await repo.consumeByHash('password_reset', 'hash4', otherUserId);
    assert.equal(wrongUser, null);

    const rightUser = await repo.consumeByHash('password_reset', 'hash4', userId);
    assert.ok(rightUser);
});

test('consumeByCode deletes by verification code, scoped to user', async () => {
    await repo.create('email_verification', { user: userId, tokenHash: 'hash5', verificationCode: '123456', expiresAt: new Date(Date.now() + 60_000) });

    const consumed = await repo.consumeByCode('email_verification', '123456', userId);
    assert.ok(consumed);
    assert.equal(consumed.verificationCode, '123456');

    const { rows } = await db.pool.query('SELECT * FROM idp_verification_tokens');
    assert.equal(rows.length, 0);
});

test('deleteAllForUser removes every token of that kind for the user', async () => {
    await repo.create('email_verification', { user: userId, tokenHash: 'h1', expiresAt: new Date(Date.now() + 60_000) });
    await repo.create('email_verification', { user: userId, tokenHash: 'h2', expiresAt: new Date(Date.now() + 60_000) });
    await repo.create('password_reset', { user: userId, tokenHash: 'h3', expiresAt: new Date(Date.now() + 60_000) });

    await repo.deleteAllForUser('email_verification', userId);
    const { rows } = await db.pool.query('SELECT kind FROM idp_verification_tokens');
    assert.deepEqual(rows.map((r) => r.kind), ['password_reset']);
});

test('pruneExpired deletes only expired rows', async () => {
    await repo.create('password_reset', { user: userId, tokenHash: 'fresh', expiresAt: new Date(Date.now() + 60_000) });
    await repo.create('password_reset', { user: userId, tokenHash: 'stale', expiresAt: new Date(Date.now() - 60_000) });

    const { deletedCount } = await repo.pruneExpired();
    assert.equal(deletedCount, 1);
});
