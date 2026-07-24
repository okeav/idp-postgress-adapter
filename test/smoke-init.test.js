import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import { initIdentityProvider, buildRouter } from '@okeav/idp-core';
import { buildTestDb } from './helpers/build-test-db.js';
import { createPostgresStorage } from '../src/index.js';

/**
 * Full-stack proof: the Part A idp-core storage seam and this Part B
 * Postgres adapter, together, can back a real initIdentityProvider() call
 * and drive an actual signup -> verify -> login -> refresh -> logout HTTP
 * round trip through idp-core's own buildRouter() — the same shape as
 * idp-core's own test/helpers/build-test-app.js uses for its Mongo adapter.
 */

let db, server, baseUrl, verificationCapture, state;

function generateSigningKey() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    return { privateKey, publicKey };
}

before(async () => {
    db = await buildTestDb();
    const { privateKey, publicKey } = generateSigningKey();
    verificationCapture = {};

    state = await initIdentityProvider({
        issuer: 'https://smoke-test.local',
        storage: {
            factory: (resolvedConfig, deps) => createPostgresStorage({ pool: db.poolConfig }, deps),
        },
        cache: { adapter: 'memory' },
        signingKeys: { keys: { 'smoke-kid-1': { privateKey, publicKey, status: 'ACTIVE' } } },
        security: {
            emailHashPepper: 'smoke-test-pepper',
            tokenHashSecret: 'smoke-test-token-secret',
            bcryptRounds: 4,
        },
        rateLimiting: { enabled: false },
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
        hooks: {
            onVerificationEmailRequested: (p) => { verificationCapture[p.email] = p; },
            resolveAuthContext: async () => ({ claims: { role: 'member' } }),
        },
    });

    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use('/', buildRouter());
    app.use((err, _req, res, _next) => {
        res.status(err.httpStatus || 500).json({ error: err.code || 'INTERNAL_ERROR', message: err.message });
    });

    server = await new Promise((resolve) => {
        const s = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    await new Promise((resolve) => server.close(resolve));
    // createPostgresStorage() builds its OWN pool (separate from db.pool,
    // which build-test-db.js uses for migrations/truncation) — it must be
    // closed before tearing down the underlying PGlite socket server, or
    // its still-open connections surface as unhandled "Connection
    // terminated unexpectedly" rejections during shutdown.
    await state.storage.close();
    await db.stop();
});

test('signup -> verify -> login -> refresh (rotation) -> logout, backed entirely by the Postgres adapter', async () => {
    const email = `smoke-${Date.now()}@example.com`;
    const password = 'Str0ng!Passw0rd';

    const registerRes = await fetch(`${baseUrl}/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
    });
    assert.equal(registerRes.status, 201);
    assert.ok(verificationCapture[email], 'onVerificationEmailRequested fired with a real code from the Postgres-backed verification-token table');

    const verifyRes = await fetch(`${baseUrl}/register/verify-email`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code: verificationCapture[email].verificationCode }),
    });
    assert.equal(verifyRes.status, 200);

    const loginRes = await fetch(`${baseUrl}/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
    });
    const loginBody = await loginRes.json();
    assert.equal(loginRes.status, 200, JSON.stringify(loginBody));
    assert.ok(loginBody.accessToken);
    assert.ok(loginBody.refreshToken);

    const refreshRes = await fetch(`${baseUrl}/refresh`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: loginBody.refreshToken }),
    });
    const refreshBody = await refreshRes.json();
    assert.equal(refreshRes.status, 200, JSON.stringify(refreshBody));
    assert.ok(refreshBody.refreshToken);
    assert.notEqual(refreshBody.refreshToken, loginBody.refreshToken, 'refresh token rotated');

    const oldTokenRetryRes = await fetch(`${baseUrl}/refresh`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: loginBody.refreshToken }),
    });
    assert.equal(oldTokenRetryRes.status, 401, 'the old (pre-rotation) refresh token must now be rejected');

    const logoutRes = await fetch(`${baseUrl}/logout`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: refreshBody.refreshToken }),
    });
    assert.equal(logoutRes.status, 200);

    const postLogoutRefreshRes = await fetch(`${baseUrl}/refresh`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: refreshBody.refreshToken }),
    });
    assert.equal(postLogoutRefreshRes.status, 401, 'a logged-out refresh token must be rejected too');
});
