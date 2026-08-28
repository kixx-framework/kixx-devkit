import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe } from 'kixx-test';
import { assert, assertEqual, assertMatches } from 'kixx-assert';
import { loadCloudflareConfig } from '../../../lib/cloudflare-config-loader.js';


describe('CloudflareConfigLoader', ({ it }) => {
    it('loads the default-exported object from the project directory', async () => {
        const projectDirectory = await makeProjectDirectory();
        const filepath = path.join(projectDirectory, 'cloudflare-config.js');

        await fsp.writeFile(filepath, "export default { name: 'example-worker' };\n");

        const config = await loadCloudflareConfig(projectDirectory);

        assertEqual('example-worker', config.name);
    });

    it('reports the required filepath when the file is absent', async () => {
        const projectDirectory = await makeProjectDirectory();
        const filepath = path.join(projectDirectory, 'cloudflare-config.js');

        const caught = await catchAsyncError(() => loadCloudflareConfig(projectDirectory));

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assertMatches('Missing required Cloudflare configuration file', caught.message);
        assertMatches(filepath, caught.message);
    });

    it('requires an object default export', async () => {
        const projectDirectory = await makeProjectDirectory();
        const filepath = path.join(projectDirectory, 'cloudflare-config.js');

        await fsp.writeFile(filepath, "export default 'invalid';\n");

        const caught = await catchAsyncError(() => loadCloudflareConfig(projectDirectory));

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assertMatches('default-export an object', caught.message);
        assertMatches(filepath, caught.message);
    });
});

async function makeProjectDirectory() {
    return await fsp.mkdtemp(path.join(os.tmpdir(), 'kixx-devkit-cloudflare-config-'));
}

async function catchAsyncError(fn) {
    try {
        await fn();
    } catch (error) {
        return error;
    }
    return null;
}
