// Runs this package's test suite against the PUBLISHED @okeav/idp-core (the
// range in peerDependencies) instead of the local file:../identity checkout,
// so a mismatch between an adapter release and a core release shows up here
// rather than in a consumer's app.
//
// Works on a throwaway copy (package.json + src + test) in the OS temp dir,
// installed fresh from the registry, so the repo's own node_modules is never
// touched. Set KEEP_TEST_DIR=1 to keep the copy around for inspection.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = '@okeav/idp-core';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args, cwd) {
    // shell:true so `npm` resolves to npm.cmd on Windows.
    const result = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
    if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${result.status ?? result.signal}`);
}

const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const range = pkg.peerDependencies?.[CORE];
if (!range) throw new Error(`package.json has no peerDependencies["${CORE}"]`);

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idp-core-postgres-published-'));
let failed = false;
try {
    pkg.devDependencies = { ...pkg.devDependencies, [CORE]: range };
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
    await fs.cp(path.join(root, 'src'), path.join(dir, 'src'), { recursive: true });
    await fs.cp(path.join(root, 'test'), path.join(dir, 'test'), { recursive: true });

    console.log(`Installing ${CORE}@${range} from the registry into ${dir}`);
    run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], dir);

    const corePath = path.join(dir, 'node_modules', CORE);
    if ((await fs.lstat(corePath)).isSymbolicLink()) throw new Error(`${CORE} resolved to a local link, not the registry`);
    const { version } = JSON.parse(await fs.readFile(path.join(corePath, 'package.json'), 'utf8'));
    console.log(`Testing against published ${CORE}@${version}`);

    run('npm', ['test'], dir);
} catch (err) {
    failed = true;
    console.error(err.message);
} finally {
    if (process.env.KEEP_TEST_DIR) console.log(`Kept ${dir}`);
    else await fs.rm(dir, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
