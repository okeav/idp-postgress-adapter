import pg from 'pg';

const { Pool } = pg;

/**
 * @param {import('pg').PoolConfig | { connectionString: string }} poolConfig
 * @returns {import('pg').Pool}
 */
export function createPool(poolConfig) {
    if (!poolConfig || (!poolConfig.connectionString && !poolConfig.host)) {
        throw new Error('createPostgresStorage: config.pool (a pg.Pool config, e.g. { connectionString }) is required');
    }
    return new Pool(poolConfig);
}
