import process from 'node:process';
import { isNonEmptyString } from 'kixx-assert';

import assignRelease from '../../lib/publishing/assign-release.js';
import resolvePublishingEnvironment from '../../lib/publishing/resolve-publishing-environment.js';
import UsageError from '../../lib/usage-error.js';
import { subcommands } from './index.js';

export default class AppRollbackCommand {

    static description = subcommands.rollback.description;
    static options = {
        environment: { type: 'string', short: 'e', description: 'Required application environment' },
        'build-id': { type: 'string', description: 'Required build pointer id' },
        'release-id': { type: 'string', description: 'Earlier Release to assign' },
        list: { type: 'boolean', description: 'List recent Releases and build activations' },
        origin: { type: 'string', description: 'Override the configured Publishing API origin' },
        token: { type: 'string', description: 'Override the configured Publishing API token' },
    };

    #args;

    constructor(args) {
        this.#args = args ?? {};
    }

    async run(options) {
        const connection = resolvePublishingEnvironment({
            environment: options?.environment,
            config: this.#args.config,
            secrets: this.#args.secrets,
            origin: options?.origin,
            token: options?.token,
            createClient: this.#args.createClient,
        });
        const buildId = requireValue(options?.['build-id'], '--build-id option is required');
        const releaseId = options?.['release-id'];
        const isList = options?.list ?? false;
        if (isList === isNonEmptyString(releaseId)) {
            throw new UsageError('Pass exactly one of --list or --release-id <id>');
        }

        if (isList) {
            const releases = await connection.client.listReleases({ limit: 25 });
            const activations = await connection.client.getBuildActivations(buildId, { limit: 25 });
            process.stdout.write(renderHistory({ buildId, releases, activations }));
            return 0;
        }

        const result = await (this.#args.assignRelease ?? assignRelease)({
            client: connection.client,
            buildId,
            releaseId,
            reason: 'rollback',
        });
        process.stdout.write(
            `Rolled back build ${ result.buildId } to Release ${ result.releaseId }.\n`,
        );
        return 0;
    }
}

function requireValue(value, message) {
    if (!isNonEmptyString(value)) {
        throw new UsageError(`The ${ message}`);
    }
    return value;
}

function renderHistory(args) {
    const { buildId, releases, activations } = args;
    const lines = [ `Build ${ buildId } activation history:` ];
    for (const entry of activations.activations) {
        lines.push(`  ${ entry.releaseId } ${ entry.reason ?? ''}`.trimEnd());
    }
    lines.push('', 'Recent Releases:');
    for (const release of releases.releases) {
        lines.push(`  ${ release.releaseId }`);
    }
    lines.push('');
    return lines.join('\n');
}
