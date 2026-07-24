// Explicit, hand-written row -> object mappers, one per table. Deliberately
// not a generic camelCase<->snake_case converter: several tables have
// field-name quirks inherited from idp-core's own Mongo models (`user` vs
// `userId` depending on table, `code` storing a hash despite the name) that
// a generic converter would either get wrong or need special-casing anyway
// — being explicit here is clearer and safer than a "mostly right" generic
// version.

export function mapServiceKeyRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        name: row.name,
        kid: row.kid,
        publicKey: row.public_key,
        status: row.status,
        region: row.region,
        registeredAt: row.registered_at,
        lastSeenAt: row.last_seen_at,
    };
}

export function mapCredentialRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        user: row.user_id,
        credentialId: row.credential_id,
        publicKey: row.public_key,
        counter: Number(row.counter),
        transports: row.transports || [],
        deviceType: row.device_type,
        backedUp: row.backed_up,
        name: row.name,
        lastUsedAt: row.last_used_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function mapConsentRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        userId: row.user_id,
        clientId: row.client_id,
        scopes: row.scopes || [],
        grantedAt: row.granted_at,
        revokedAt: row.revoked_at,
        isRevoked: row.is_revoked,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

const OAUTH_CLIENT_PUBLIC_COLUMNS = `
    id, name, slug, client_id, client_type, redirect_uris, allowed_scopes, allowed_grants,
    access_token_ttl, refresh_token_ttl, id_token_ttl, logo_url, website_url,
    privacy_policy_url, terms_of_service_url, support_email, status, metadata,
    created_at, updated_at
`;

export function mapOAuthClientRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        clientId: row.client_id,
        ...(row.client_secret_hash !== undefined ? { clientSecretHash: row.client_secret_hash } : {}),
        clientType: row.client_type,
        redirectUris: row.redirect_uris || [],
        allowedScopes: row.allowed_scopes || [],
        allowedGrants: row.allowed_grants || [],
        accessTokenTTL: row.access_token_ttl,
        refreshTokenTTL: row.refresh_token_ttl,
        idTokenTTL: row.id_token_ttl,
        logoUrl: row.logo_url,
        websiteUrl: row.website_url,
        privacyPolicyUrl: row.privacy_policy_url,
        termsOfServiceUrl: row.terms_of_service_url,
        supportEmail: row.support_email,
        status: row.status,
        metadata: row.metadata || {},
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function mapAuthorizationCodeRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        code: row.code,
        clientId: row.client_id,
        userId: row.user_id,
        redirectUri: row.redirect_uri,
        scopes: row.scopes || [],
        codeChallenge: row.code_challenge,
        codeChallengeMethod: row.code_challenge_method,
        expiresAt: row.expires_at,
        used: row.used,
        usedAt: row.used_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function mapVerificationTokenRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        kind: row.kind,
        user: row.user_id,
        tokenHash: row.token_hash,
        verificationCode: row.verification_code,
        expiresAt: row.expires_at,
        usedAt: row.used_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function mapSessionRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        user: row.user_id,
        tokenHash: row.token_hash,
        expiresAt: row.expires_at,
        kid: row.kid,
        jti: row.jti,
        revokedAt: row.revoked_at,
        deviceInfo: row.device_info,
        deviceFingerprint: row.device_fingerprint,
        ipAddress: row.ip_address,
        claims: row.claims || {},
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export { OAUTH_CLIENT_PUBLIC_COLUMNS };
