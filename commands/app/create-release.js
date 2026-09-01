import process from 'node:process';

import createApplicationRelease from '../../lib/publishing/create-application-release.js';
import { renderReleaseResult } from './publish.js';
import { subcommands } from './index.js';

export default class AppCreateReleaseCommand {

    static description = subcommands['create-release'].description;
    static options = {
        environment: { type: 'string', short: 'e', description: 'Required application environment' },
        'dry-run': { type: 'boolean', description: 'Preview the server-backed object diff without writes' },
        verbose: { type: 'boolean', description: 'List every resource and disposition' },
        origin: { type: 'string', description: 'Override the configured Publishing API origin' },
        token: { type: 'string', description: 'Override the configured Publishing API token' },
        message: { type: 'string', description: 'Release provenance message' },
        'source-revision': { type: 'string', description: 'Source revision recorded as provenance' },
    };

    #args;
    #createRelease;

    constructor(args) {
        this.#args = args ?? {};
        this.#createRelease = this.#args.createApplicationRelease ?? createApplicationRelease;
    }

    async run(options) {
        const provenance = makeProvenance(options);
        const result = await this.#createRelease({
            projectDirectory: this.#args.projectDirectory,
            environment: options?.environment,
            config: this.#args.config,
            secrets: this.#args.secrets,
            origin: options?.origin,
            token: options?.token,
            dryRun: options?.['dry-run'] ?? false,
            provenance,
        });

        process.stdout.write(renderReleaseResult({ result, verbose: options?.verbose ?? false }));
        return 0;
    }
}

function makeProvenance(options) {
    const provenance = { client: 'kixx-devkit' };
    if (options?.message !== undefined) {
        provenance.message = options.message;
    }
    if (options?.['source-revision'] !== undefined) {
        provenance.sourceRevision = options['source-revision'];
    }
    return provenance;
}
