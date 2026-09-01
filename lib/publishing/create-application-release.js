import defaultFileSystem from '../file-system.js';
import publishContent from './publish-content.js';
import resolvePublishingEnvironment from './resolve-publishing-environment.js';
import scanContentSources from './scan-content-sources.js';

/**
 * Creates an immutable Release from one environment's local content tree.
 * @param {Object} args - Release inputs and dependencies
 * @returns {Promise<Object>} Release result with resolved environment and origin
 */
export default async function createApplicationRelease(args) {
    const {
        projectDirectory,
        dryRun = false,
        provenance,
        fileSystem = defaultFileSystem,
        scan = scanContentSources,
        publish = publishContent,
        ...environmentOptions
    } = args ?? {};
    const connection = resolvePublishingEnvironment(environmentOptions);
    const contentSources = await scan(projectDirectory, { fileSystem });
    const result = await publish({
        client: connection.client,
        contentSources,
        provenance,
        dryRun,
    });

    return {
        ...result,
        environment: connection.environment,
        origin: connection.origin,
    };
}
