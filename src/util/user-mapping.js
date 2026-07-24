// idp-core's Mongo user schema hides these four fields by default
// (`select:false`) — every actual call site in idp-core (grepped across
// src/mfa/controller.js and src/password-auth/controllers.js) only ever
// requests them back via a `+field` token, confirming this exact set.
const HIDDEN_BY_DEFAULT = ['passwordHash', 'mfaSecret', 'mfaTempSecret', 'mfaRecoveryCodes'];

/**
 * Reproduces the two Mongoose `.select()` string modes idp-core actually
 * uses (verified against every call site, not guessed):
 *  - if the string has ANY bare (unprefixed) field name, it's an
 *    INCLUSION-ONLY list: `id` + exactly the named fields, nothing else.
 *  - if EVERY token is `+`/`-` prefixed (e.g. `'+mfaSecret +mfaRecoveryCodes'`),
 *    it MODIFIES the default projection instead: default-visible fields
 *    stay, `+field` adds back a normally-hidden field, `-field` removes a
 *    normally-visible one.
 */
export function resolveUserSelect(selectStr) {
    if (!selectStr) return { mode: 'default', exclude: [...HIDDEN_BY_DEFAULT] };

    const tokens = selectStr.trim().split(/\s+/).filter(Boolean);
    const hasBareField = tokens.some((t) => !t.startsWith('+') && !t.startsWith('-'));

    if (hasBareField) {
        return { mode: 'inclusion', include: tokens.map((t) => t.replace(/^[+-]/, '')) };
    }

    const addBack = tokens.filter((t) => t.startsWith('+')).map((t) => t.slice(1));
    const removeExtra = tokens.filter((t) => t.startsWith('-')).map((t) => t.slice(1));
    return { mode: 'default', exclude: HIDDEN_BY_DEFAULT.filter((f) => !addBack.includes(f)).concat(removeExtra) };
}

/** Applies a resolved select to a fully-assembled user object. `id` is always kept. */
export function applyUserSelect(user, resolved) {
    if (!user) return null;
    if (resolved.mode === 'inclusion') {
        const picked = { id: user.id };
        for (const field of resolved.include) picked[field] = user[field];
        return picked;
    }
    const result = { ...user };
    for (const field of resolved.exclude) delete result[field];
    return result;
}

const PROFILE_COLUMN_FOR = {
    firstName: 'profile_first_name', lastName: 'profile_last_name', displayName: 'profile_display_name',
    avatarUrl: 'profile_avatar_url', locale: 'profile_locale', zoneinfo: 'profile_zoneinfo',
};
const PLAIN_COLUMN_FOR = {
    email: 'email', passwordHash: 'password_hash', status: 'status', lastLoginAt: 'last_login_at',
    passwordChangedAt: 'password_changed_at', failedLoginAttempts: 'failed_login_attempts', lockUntil: 'lock_until',
    mfaEnabled: 'mfa_enabled', mfaSecret: 'mfa_secret', mfaTempSecret: 'mfa_temp_secret', metadata: 'metadata',
};
const RECOVERY_CODE_INDEX_PATCH = /^mfaRecoveryCodes\.(\d+)\.usedAt$/;

/**
 * Splits a Mongo-shaped `updateById` patch into the pieces a Postgres
 * adapter needs to apply separately: plain `idp_users` column SETs, and the
 * two `mfaRecoveryCodes`-related side effects that target the separate
 * `idp_user_recovery_codes` join table instead. A single patch object can
 * (and in practice does — see confirmMfaHandler/disableMfaHandler) mix
 * plain columns with a full recovery-codes array replace in one call.
 */
export function splitUserPatch(patch) {
    const columnSets = []; // [{column, value}]
    let recoveryCodesReplace = null; // string[] (hashes) | null
    const recoveryCodeConsume = []; // [{position, usedAt}]

    for (const [key, value] of Object.entries(patch)) {
        if (key === 'mfaRecoveryCodes' && Array.isArray(value)) {
            recoveryCodesReplace = value;
            continue;
        }
        const idxMatch = key.match(RECOVERY_CODE_INDEX_PATCH);
        if (idxMatch) {
            recoveryCodeConsume.push({ position: Number(idxMatch[1]), usedAt: value });
            continue;
        }
        if (key.startsWith('profile.')) {
            const profileField = key.slice('profile.'.length);
            const column = PROFILE_COLUMN_FOR[profileField];
            if (column) columnSets.push({ column, value });
            continue;
        }
        const column = PLAIN_COLUMN_FOR[key];
        if (column) columnSets.push({ column, value: key === 'metadata' ? JSON.stringify(value) : value });
    }

    return { columnSets, recoveryCodesReplace, recoveryCodeConsume };
}

/** Reassembles the flat-column + two-join-table row shape back into the object shape idp-core's controllers expect. */
export function assembleUser(userRow, { externalProviders, recoveryCodes }) {
    if (!userRow) return null;
    return {
        id: userRow.id,
        email: userRow.email,
        passwordHash: userRow.password_hash,
        status: userRow.status,
        lastLoginAt: userRow.last_login_at,
        passwordChangedAt: userRow.password_changed_at,
        failedLoginAttempts: userRow.failed_login_attempts,
        lockUntil: userRow.lock_until,
        mfaEnabled: userRow.mfa_enabled,
        mfaSecret: userRow.mfa_secret,
        mfaTempSecret: userRow.mfa_temp_secret,
        mfaRecoveryCodes: (recoveryCodes || []).map((r) => ({ codeHash: r.code_hash, usedAt: r.used_at })),
        profile: {
            firstName: userRow.profile_first_name,
            lastName: userRow.profile_last_name,
            displayName: userRow.profile_display_name,
            avatarUrl: userRow.profile_avatar_url,
            locale: userRow.profile_locale,
            zoneinfo: userRow.profile_zoneinfo,
        },
        metadata: userRow.metadata || {},
        externalProviders: (externalProviders || []).map((p) => ({
            provider: p.provider, providerId: p.provider_id, email: p.email, connectedAt: p.connected_at,
        })),
        createdAt: userRow.created_at,
        updatedAt: userRow.updated_at,
    };
}
