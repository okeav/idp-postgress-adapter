-- @okeav/idp-core-postgres — initial schema.
-- Primary keys are application-generated UUIDs (crypto.randomUUID(), passed
-- in by the repository layer) rather than DB-generated ones, so this
-- migration never needs the pgcrypto/uuid-ossp extensions — some managed
-- Postgres hosts restrict CREATE EXTENSION, and this keeps the schema fully
-- self-contained.

CREATE TABLE idp_users (
    id UUID PRIMARY KEY,
    email TEXT NOT NULL,
    email_hash TEXT UNIQUE,
    password_hash TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION',
    last_login_at TIMESTAMPTZ,
    password_changed_at TIMESTAMPTZ,
    failed_login_attempts INTEGER NOT NULL DEFAULT 0,
    lock_until TIMESTAMPTZ,
    mfa_enabled BOOLEAN NOT NULL DEFAULT false,
    mfa_secret TEXT,
    mfa_temp_secret TEXT,
    profile_first_name TEXT,
    profile_last_name TEXT,
    profile_display_name TEXT,
    profile_avatar_url TEXT,
    profile_locale TEXT NOT NULL DEFAULT 'en',
    profile_zoneinfo TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idp_users_status_idx ON idp_users (status);
CREATE INDEX idp_users_lock_until_idx ON idp_users (lock_until) WHERE lock_until IS NOT NULL;

-- Was Mongo's embedded `externalProviders` array — a join table here since
-- findByExternalProvider(provider, providerId) needs an indexed lookup, not
-- a wholesale array fetch.
CREATE TABLE idp_user_external_providers (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES idp_users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    email TEXT,
    connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_id)
);
CREATE INDEX idp_user_external_providers_user_id_idx ON idp_user_external_providers (user_id);

-- Was Mongo's embedded `mfaRecoveryCodes` array — a join table with an
-- explicit `position` column since a recovery code is consumed by
-- positional array index (see mfa/controller.js in idp-core).
CREATE TABLE idp_user_recovery_codes (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES idp_users(id) ON DELETE CASCADE,
    position SMALLINT NOT NULL,
    code_hash TEXT NOT NULL,
    used_at TIMESTAMPTZ,
    UNIQUE (user_id, position)
);
CREATE INDEX idp_user_recovery_codes_user_id_idx ON idp_user_recovery_codes (user_id);

CREATE TABLE idp_sessions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES idp_users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    kid TEXT NOT NULL,
    jti TEXT NOT NULL,
    revoked_at TIMESTAMPTZ,
    device_info TEXT,
    device_fingerprint TEXT,
    ip_address TEXT,
    claims JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idp_sessions_token_hash_revoked_idx ON idp_sessions (token_hash, revoked_at);
CREATE INDEX idp_sessions_user_revoked_expires_idx ON idp_sessions (user_id, revoked_at, expires_at);
CREATE INDEX idp_sessions_jti_idx ON idp_sessions (jti) WHERE jti IS NOT NULL;
CREATE INDEX idp_sessions_user_device_fp_idx ON idp_sessions (user_id, device_fingerprint) WHERE device_fingerprint IS NOT NULL;

-- Write-only audit trail, one row per issued access token.
CREATE TABLE idp_access_token_audit (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES idp_users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    kid TEXT NOT NULL,
    jti TEXT NOT NULL,
    ip_address TEXT,
    device_info TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idp_access_token_audit_token_hash_idx ON idp_access_token_audit (token_hash);

CREATE TABLE idp_authorization_codes (
    id UUID PRIMARY KEY,
    code TEXT UNIQUE NOT NULL, -- stores the HASH despite the name, matching idp-core's own field naming
    client_id TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES idp_users(id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    scopes TEXT[] NOT NULL DEFAULT '{}',
    code_challenge TEXT,
    code_challenge_method TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    used BOOLEAN NOT NULL DEFAULT false,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idp_auth_codes_code_used_idx ON idp_authorization_codes (code, used);
CREATE INDEX idp_auth_codes_client_used_expires_idx ON idp_authorization_codes (client_id, used, expires_at);

CREATE TABLE idp_consents (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES idp_users(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    scopes TEXT[] NOT NULL DEFAULT '{}',
    granted_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    is_revoked BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, client_id)
);
CREATE INDEX idp_consents_user_revoked_idx ON idp_consents (user_id, is_revoked);

CREATE TABLE idp_oauth_clients (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    client_id TEXT UNIQUE NOT NULL,
    client_secret_hash TEXT NOT NULL, -- app-level "hide by default", see pg-oauth-client.repository.js
    client_type TEXT NOT NULL DEFAULT 'confidential',
    redirect_uris TEXT[] NOT NULL DEFAULT '{}',
    allowed_scopes TEXT[] NOT NULL DEFAULT '{}',
    allowed_grants TEXT[] NOT NULL DEFAULT '{}',
    access_token_ttl INTEGER,
    refresh_token_ttl INTEGER,
    id_token_ttl INTEGER,
    logo_url TEXT,
    website_url TEXT,
    privacy_policy_url TEXT,
    terms_of_service_url TEXT,
    support_email TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE idp_verification_tokens (
    id UUID PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('password_reset', 'email_verification', 'magic_link')),
    user_id UUID NOT NULL REFERENCES idp_users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    verification_code TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idp_verif_tokens_kind_hash_user_idx ON idp_verification_tokens (kind, token_hash, user_id);
CREATE INDEX idp_verif_tokens_kind_user_idx ON idp_verification_tokens (kind, user_id);

CREATE TABLE idp_service_keys (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    kid TEXT UNIQUE NOT NULL,
    public_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    region TEXT NOT NULL DEFAULT 'global',
    registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idp_service_keys_name_status_idx ON idp_service_keys (name, status);

CREATE TABLE idp_credentials (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES idp_users(id) ON DELETE CASCADE,
    credential_id TEXT UNIQUE NOT NULL,
    public_key TEXT NOT NULL,
    counter BIGINT NOT NULL DEFAULT 0,
    transports TEXT[] NOT NULL DEFAULT '{}',
    device_type TEXT NOT NULL DEFAULT 'singleDevice' CHECK (device_type IN ('singleDevice', 'multiDevice')),
    backed_up BOOLEAN NOT NULL DEFAULT false,
    name TEXT,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idp_credentials_user_id_idx ON idp_credentials (user_id);
