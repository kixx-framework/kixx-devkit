import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe } from 'kixx-test';
import { assert, assertEqual } from 'kixx-assert';
import fileSystem from '../../../../lib/bundler/file-system.js';

describe('bundler file system', ({ after, before, it }) => {
    let directory;

    before(async () => {
        directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'kixx-bundler-'));
        await fsp.writeFile(path.join(directory, 'source.js'), 'export default 1;');
        await fsp.mkdir(path.join(directory, 'directory'));
    });

    after(async () => {
        await fsp.rm(directory, { recursive: true, force: true });
    });

    it('reads source as UTF-8 text', async () => {
        const source = await fileSystem.readFile(path.join(directory, 'source.js'));

        assertEqual('export default 1;', source);
    });

    it('distinguishes files from directories and absent paths', async () => {
        const isSourceFile = await fileSystem.isFile(path.join(directory, 'source.js'));
        const isDirectory = await fileSystem.isFile(path.join(directory, 'directory'));
        const isMissing = await fileSystem.isFile(path.join(directory, 'missing.js'));

        assertEqual(true, isSourceFile);
        assertEqual(false, isDirectory);
        assertEqual(false, isMissing);
    });

    it('propagates errors other than path absence', async () => {
        const caught = await catchAsyncError(() => fileSystem.isFile('\0'));

        assert(caught, 'expected an error');
        assertEqual('TypeError', caught.name);
    });
});

async function catchAsyncError(fn) {
    try {
        await fn();
    } catch (error) {
        return error;
    }

    return null;
}
