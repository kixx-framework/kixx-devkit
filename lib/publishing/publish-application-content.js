import { isNonEmptyString, isUndefined } from 'kixx-assert';
import defaultFileSystem from '../file-system.js';
import UsageError from '../usage-error.js';
import publishContent from './publish-content.js';
import PublishingAPIClient from './publishing-api-client.js';
import resolveRunningBuild from './resolve-running-build.js';
import scanContentSources from './scan-content-sources.js';

/**
 * Resolves one application environment, publishes its local content sources,
 * and creates an immutable Release.
 * @param {Object} args - Publish inputs and dependencies.
 * @param {string} args.projectDirectory - Application project root.
 * @param {string} args.environment - Environment to publish.
 * @param {Object} args.config - Merged Kixx configuration.
 * @param {Object} args.secrets - Merged Kixx secrets.
 * @param {string} [args.buildId] - Explicit build id, overriding server discovery.
 * @param {string} [args.origin] - Explicit origin, overriding configuration.
 * @param {string} [args.token] - Explicit bearer token, overriding secrets.
 * @param {boolean} [args.dryRun=false] - Diff without remote writes.
 * @param {import('../file-system.js').FileSystem} [args.fileSystem] - Filesystem adapter.
 * @param {Function} [args.scan] - Content scanner implementation.
 * @param {Function} [args.publish] - Content publishing implementation.
 * @param {Function} [args.createClient] - Publishing client factory.
 * @returns {Promise<Object>} Release result with resolved environment, origin, and build id.
 * @throws {UsageError} When environment settings or a build id cannot be resolved.
 */
export default async function publishApplicationContent(args) {
    const {
        projectDirectory,
        environment,
        config,
        secrets,
        buildId: buildIdOverride,
        origin: originOverride,
        token: tokenOverride,
        dryRun = false,
        fileSystem = defaultFileSystem,
        scan = scanContentSources,
        publish = publishContent,
        createClient = createPublishingClient,
    } = args ?? {};

    if (!isNonEmptyString(environment)) {
        throw new UsageError('The --environment option is required');
    }

    const origin = resolveSetting({
        override: originOverride,
        configured: config?.app?.environments?.[environment]?.origin,
        optionName: 'origin',
        filepath: '.kixx/config.json',
        keyPath: `app.environments.${ environment }.origin`,
    });
    const token = resolveSetting({
        override: tokenOverride,
        configured: secrets?.app?.environments?.[environment]?.publishingToken,
        optionName: 'token',
        filepath: '.kixx/secrets.json',
        keyPath: `app.environments.${ environment }.publishingToken`,
    });
    // Mapping the complete tree before constructing a request preserves the
    // guarantee that local source errors cannot produce partial remote writes.
    const contentSources = await scan(projectDirectory, { fileSystem });
    const client = createClient({ origin, token });
    const buildId = await resolveRunningBuild({ client, buildId: buildIdOverride });
    const result = await publish({
        client,
        contentSources,
        dryRun,
    });

    return {
        ...result,
        buildId,
        environment,
        origin,
    };
}

function resolveSetting(args) {
    const {
        override,
        configured,
        optionName,
        filepath,
        keyPath,
    } = args ?? {};

    if (!isUndefined(override)) {
        if (isNonEmptyString(override)) {
            return override;
        }

        throw new UsageError(`The --${ optionName } option must be a non-empty string`);
    }

    if (isNonEmptyString(configured)) {
        return configured;
    }

    throw new UsageError(`Missing required setting ${ keyPath } in ${ filepath }`);
}

function createPublishingClient(options) {
    return new PublishingAPIClient(options);
}
