import process from 'node:process';
import { isNonEmptyString } from 'kixx-assert';

import assignRelease from '../../lib/publishing/assign-release.js';
import resolvePublishingEnvironment from '../../lib/publishing/resolve-publishing-environment.js';
import UsageError from '../../lib/usage-error.js';
import { subcommands } from './index.js';

export default class AppAssignBuildCommand {

    static description = subcommands['assign-build'].description;
    static options = {
        environment: { type: 'string', short: 'e', description: 'Required application environment' },
        'build-id': { type: 'string', description: 'Required build pointer id' },
        'release-id': { type: 'string', description: 'Required Release id' },
        reason: { type: 'string', default: 'publish', description: 'Assignment audit reason' },
        origin: { type: 'string', description: 'Override the configured Publishing API origin' },
        token: { type: 'string', description: 'Override the configured Publishing API token' },
    };

    #args;
    #assign;

    constructor(args) {
        this.#args = args ?? {};
        this.#assign = this.#args.assignRelease ?? assignRelease;
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
        const buildId = requireOption(options?.['build-id'], 'build-id');
        const releaseId = requireOption(options?.['release-id'], 'release-id');
        const result = await this.#assign({
            client: connection.client,
            buildId,
            releaseId,
            reason: options?.reason ?? 'publish',
        });

        process.stdout.write([
            `Environment: ${ connection.environment }`,
            `Origin:      ${ connection.origin }`,
            `BUILD_ID:    ${ result.buildId }`,
            `Release:     ${ result.releaseId }`,
            `Reason:      ${ options?.reason ?? 'publish' }`,
            '',
        ].join('\n'));
        return 0;
    }
}

function requireOption(value, name) {
    if (!isNonEmptyString(value)) {
        throw new UsageError(`The --${ name } option is required`);
    }
    return value;
}
