import process from 'node:process';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe } from 'kixx-test';
import { assertEqual, assertMatches } from '../../lib/vendor/kixx-assert/mod.js';
import manifest from '../../deno.json' with { type: 'json' };


const ENTRY_POINT = fileURLToPath(new URL('../../kixx.js', import.meta.url));

// The permission set an installed `kixx` gets on Deno (see README Install), so
// these tests also fail if the entry point needs more than users grant it.
const DENO_RUN_ARGS = [ 'run', '-RWNE', '--allow-sys=homedir', '--no-prompt' ];


describe('kixx.js entry point', ({ it }) => {

    it('prints the deno.json version for --version', async () => {
        const { code, stdout } = await runEntryPoint([ '--version' ]);

        assertEqual(0, code);
        assertEqual(`${ manifest.version }\n`, stdout);
    });

    it('prints the version for -v, even after a sub-command name', async () => {
        const { code, stdout } = await runEntryPoint([ 'app', 'publish', '-v' ]);

        assertEqual(0, code);
        assertEqual(`${ manifest.version }\n`, stdout);
    });

    it('names the program kixx and lists --version in top level help', async () => {
        const { code, stdout } = await runEntryPoint([ '--help' ]);

        assertEqual(0, code);
        assertMatches(/^Usage: kixx <command>/, stdout);
        assertMatches(/--version/, stdout);
    });
});


// Runs the entry point with whichever runtime runs the test suite.
function runEntryPoint(args) {
    const runtimeArgs = process.versions.deno ? DENO_RUN_ARGS : [];

    return new Promise((resolve) => {
        execFile(process.execPath, [ ...runtimeArgs, ENTRY_POINT, ...args ], (error, stdout, stderr) => {
            resolve({ code: error ? error.code : 0, stdout, stderr });
        });
    });
}
