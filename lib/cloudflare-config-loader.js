import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isPlainObject } from 'kixx-assert';
import UsageError from './usage-error.js';


export const CLOUDFLARE_CONFIG_FILE_NAME = 'cloudflare-config.js';


/**
 * Loads the Cloudflare configuration module owned by a project.
 * @param {string} projectDirectory - Directory containing cloudflare-config.js.
 * @returns {Promise<Object>} The module's default-exported configuration object.
 * @throws {UsageError} When the file is absent, cannot be loaded, or lacks an object default export.
 */
export async function loadCloudflareConfig(projectDirectory) {
    const filepath = path.join(projectDirectory, CLOUDFLARE_CONFIG_FILE_NAME);

    try {
        await fsp.access(filepath);
    } catch (cause) {
        throw new UsageError(`Missing required Cloudflare configuration file: ${ filepath }`, { cause });
    }

    let mod;

    try {
        mod = await import(pathToFileURL(filepath).href);
    } catch (cause) {
        throw new UsageError(`Unable to load Cloudflare configuration from ${ filepath }: ${ cause.message }`, {
            cause,
        });
    }

    if (!isPlainObject(mod.default)) {
        throw new UsageError(`Expected ${ filepath } to default-export an object`);
    }

    return mod.default;
}
