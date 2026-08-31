import path from 'node:path';
import process from 'node:process';
import publishApplicationContent from '../../lib/publishing/publish-application-content.js';
import { subcommands } from './index.js';

export default class AppPublishCommand {

    static description = subcommands.publish.description;

    static options = {
        environment: {
            type: 'string',
            short: 'e',
            description: 'Required application environment to publish',
        },
        'build-id': {
            type: 'string',
            description: 'Build id to publish; defaults to the environment\'s recorded live build',
        },
        bootstrap: {
            type: 'boolean',
            description: 'Seed an empty closure for a build that has never had content',
        },
        'dry-run': {
            type: 'boolean',
            description: 'Scan and diff content without uploading, committing, or writing local state',
        },
        verbose: {
            type: 'boolean',
            description: 'List every resource with its hash and disposition',
        },
        origin: {
            type: 'string',
            description: 'Override app.environments.<environment>.origin from .kixx/config.json',
        },
        token: {
            type: 'string',
            description: 'Override app.environments.<environment>.publishingToken from .kixx/secrets.json',
        },
    };

    #projectDirectory;
    #config;
    #secrets;
    #publishApplicationContent;

    constructor(args) {
        const {
            projectDirectory,
            config,
            secrets,
            publishApplicationContent: publish = publishApplicationContent,
        } = args ?? {};

        this.#projectDirectory = projectDirectory;
        this.#config = config;
        this.#secrets = secrets;
        this.#publishApplicationContent = publish;
    }

    async run(options) {
        const {
            environment,
            bootstrap = false,
            'dry-run': dryRun = false,
            verbose = false,
        } = options ?? {};

        const result = await this.#publishApplicationContent({
            projectDirectory: this.#projectDirectory,
            environment,
            config: this.#config,
            secrets: this.#secrets,
            buildId: options?.['build-id'],
            origin: options?.origin,
            token: options?.token,
            bootstrap,
            dryRun,
        });

        process.stdout.write(renderPublishResult({
            result,
            environment: result.environment,
            origin: result.origin,
            verbose,
            stateFilepath: result.stateFilepath
                ? path.relative(this.#projectDirectory, result.stateFilepath)
                : null,
        }));

        return 0;
    }
}

/**
 * Formats the publish result without exposing the Publishing API token.
 * @param {Object} args - Output details.
 * @param {Object} args.result - Structured result from `publishContent()`.
 * @param {string} args.environment - Published environment.
 * @param {string} args.origin - Publishing API origin.
 * @param {boolean} args.verbose - Whether to list every resource.
 * @param {string|null} args.stateFilepath - Written state path, or null.
 * @returns {string} Terminal output ending in a newline.
 */
export function renderPublishResult(args) {
    const {
        result,
        environment,
        origin,
        verbose,
        stateFilepath,
    } = args ?? {};
    const totalCount = result.matchedCount + result.uploadedCount;
    const uploadLabel = result.dryRun ? 'would upload' : 'uploaded';
    const lines = [
        `Environment: ${ environment }`,
        `Origin:      ${ origin }`,
        `BUILD_ID:   ${ result.buildId }`,
        '',
        `Resources: ${ totalCount } total; ${ result.matchedCount } matched; ` +
            `${ result.uploadedCount } ${ uploadLabel }`,
    ];

    appendUploadedResources(lines, result);
    appendUnmatchedFiles(lines, result.unmatchedFiles);

    if (verbose) {
        appendAllResources(lines, result.resources);
    }

    lines.push('');

    if (result.dryRun) {
        lines.push('Dry run: no resources, closure, or local state were written.');
    } else {
        lines.push(`Closure: ${ result.closureHash } (${ result.nodeCount } nodes)`);
        if (stateFilepath) {
            lines.push(`Wrote ${ stateFilepath }`);
        }
    }

    lines.push('');
    return lines.join('\n');
}

function appendUploadedResources(lines, result) {
    const heading = result.dryRun ? 'Resources that would upload:' : 'Uploaded resources:';
    lines.push('', heading);

    if (result.uploadedResources.length === 0) {
        lines.push('  (none)');
        return;
    }

    for (const resource of result.uploadedResources) {
        lines.push(`  ${ resource.type } ${ displayPathname(resource.pathname) }`);
    }
}

function appendUnmatchedFiles(lines, unmatchedFiles) {
    lines.push('', 'Files not matched by a publishing convention:');

    if (unmatchedFiles.length === 0) {
        lines.push('  (none)');
        return;
    }

    for (const filepath of unmatchedFiles) {
        lines.push(`  ${ filepath }`);
    }
}

function appendAllResources(lines, resources) {
    lines.push('', 'All resources:');

    if (resources.length === 0) {
        lines.push('  (none)');
        return;
    }

    for (const resource of resources) {
        lines.push(
            `  ${ resource.disposition.padEnd(8) } ${ resource.type } ` +
            `${ displayPathname(resource.pathname) } ${ resource.hash } ${ resource.size } bytes`,
        );
    }
}

function displayPathname(pathname) {
    return pathname || '/';
}
