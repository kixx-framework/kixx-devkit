import path from 'node:path';
import process from 'node:process';
import CloudflareApiClient from '../../lib/cloudflare/cloudflare-api-client.js';
import { createWorkerVersion } from '../../lib/cloudflare/create-worker-version.js';
import { readWorkerVersionState } from '../../lib/cloudflare/worker-version-state.js';
import defaultFileSystem from '../../lib/file-system.js';
import UsageError from '../../lib/usage-error.js';
import { subcommands } from './index.js';

// requiredCloudflareConfig is deliberately not declared. Every config path
// this command needs is under environments.<environment>, which is not
// known until --environment is parsed, but the runner checks
// requiredCloudflareConfig before construction using only static paths.
// Config validation stays inside createWorkerVersion() instead.
export default class CloudflareCreateWorkerVersionCommand {

    static description = subcommands['create-worker-version'].description;

    static options = {
        environment: {
            type: 'string',
            short: 'e',
            description: 'Environment to build and upload a Worker version for',
        },
        force: {
            type: 'boolean',
            description: 'Upload a version even when nothing has changed',
        },
        deploy: {
            type: 'boolean',
            description: 'Route all traffic to the created version. Required only when introducing a ' +
                'Durable Object class on a Worker that is already deployed',
        },
    };

    static requiredSecrets = [
        'cloudflare.accountId',
        'cloudflare.apiToken',
    ];

    #projectDirectory;
    #cloudflareConfig;
    #secrets;

    constructor(args) {
        const { projectDirectory, cloudflareConfig, secrets } = args ?? {};
        this.#projectDirectory = projectDirectory;
        this.#cloudflareConfig = cloudflareConfig;
        this.#secrets = secrets;
    }

    async run(options) {
        const { environment, force = false, deploy = false } = options ?? {};

        if (!environment) {
            throw new UsageError('The --environment option is required');
        }

        const apiClient = new CloudflareApiClient(this.#secrets.cloudflare);
        const fileSystem = defaultFileSystem;
        const projectDirectory = this.#projectDirectory;

        const previousState = await readWorkerVersionState({ projectDirectory, environment, fileSystem });

        const result = await createWorkerVersion({
            projectDirectory,
            environment,
            cloudflareConfig: this.#cloudflareConfig,
            apiClient,
            force,
            deploy,
            fileSystem,
        });

        if (result.outcome === 'resources-resolved') {
            process.stdout.write(renderResourcesResolved(result, environment));
        } else if (result.outcome === 'skipped') {
            process.stdout.write(renderSkipped(result, previousState));
        } else {
            const newState = await readWorkerVersionState({ projectDirectory, environment, fileSystem });
            const relativeStateFilepath = path.relative(projectDirectory, result.stateFilepath);
            process.stdout.write(renderCreated(result, previousState, newState, relativeStateFilepath));
        }

        return 0;
    }
}

// Cloudflare's exports_reconciliation report, in the order a developer reads
// it: what changed, then what needs attention. Empty sections are omitted so a
// run that changed nothing stays as quiet as it is today.
const RECONCILIATION_SECTIONS = [
    [ 'created', 'Created' ],
    [ 'updated', 'Updated' ],
    [ 'deleted', 'Deleted' ],
    [ 'renamed', 'Renamed' ],
    [ 'transferred', 'Transferred' ],
    [ 'transfer_pending', 'Transfer pending' ],
    [ 'warnings', 'Warnings' ],
    [ 'info', 'Info' ],
];


export function renderResourcesResolved(result, environment) {
    const count = result.resolvedResources.length;
    const lines = [
        `Resolved ${ count } resource${ count === 1 ? '' : 's' } missing an ID in cloudflare-config.js. ` +
        'Add these IDs, then re-run:',
        '',
    ];

    // Distinguishing the two cases matters: "already existed" tells a
    // developer the resource predates this run, so nothing new is being
    // billed and the id is the one their data is already in.
    for (const resource of result.resolvedResources) {
        const origin = resource.created ? 'created' : 'already existed';
        lines.push(`  environments.${ environment }.${ resource.configKeyPath }    (${ origin })`);
        lines.push(`    = "${ resource.id }"`);
    }

    lines.push('', 'No version was created.', '');

    return lines.join('\n');
}

export function renderSkipped(result, previousState) {
    const versionId = previousState?.versionId ?? 'unknown';
    const buildId = previousState?.buildId ?? 'unknown';

    return [
        `Environment: ${ result.environment }`,
        `Worker:      ${ result.workerName }`,
        '',
        `Nothing changed since version ${ versionId } (build ${ buildId }).`,
        'No version created. Pass --force to upload anyway.',
        '',
    ].join('\n');
}

export function renderCreated(result, previousState, newState, relativeStateFilepath) {
    const lines = [
        `Environment: ${ result.environment }`,
        `Worker:      ${ result.workerName }`,
    ];

    if (result.retargetedFrom) {
        lines.push(
            `  RETARGETED from Worker "${ result.retargetedFrom }". The hashes below compare against that ` +
            'Worker\'s recorded state, not this one, so "unchanged" does not mean this Worker already had them.',
        );
    }

    lines.push(
        '',
        `Bundled ${ result.moduleCount } module${ result.moduleCount === 1 ? '' : 's' }`,
        renderHashLine('modules', result.changes.modules, previousState?.modulesHash, newState.modulesHash),
        renderHashLine('bindings', result.changes.bindings, previousState?.bindingsHash, newState.bindingsHash),
        renderHashLine('config', result.changes.config, previousState?.configHash, newState.configHash),
        '',
        `BUILD_ID: ${ result.buildId }`,
        `Created version ${ result.versionId }`,
    );

    lines.push(...renderDeployment(result));
    lines.push(...renderReconciliation(result.reconciliation));

    lines.push(`Wrote ${ relativeStateFilepath }`, '');

    return lines.join('\n');
}

// A developer who did not pass --deploy must never learn about a full-traffic
// deployment from the dashboard, so this says both that it happened and why.
function renderDeployment(result) {
    if (!result.deployed) {
        return [ 'Not deployed (pass --deploy)' ];
    }

    if (!result.forcedDeploymentClasses) {
        return [ 'Deployed to 100% of traffic' ];
    }

    return [
        'DEPLOYED to 100% of traffic without --deploy.',
        '  Cloudflare provisions a Durable Object namespace only when the version declaring it is',
        '  deployed, and this Worker had never been deployed, so deploying displaced nothing.',
        `  Namespaces provisioned for: ${ result.forcedDeploymentClasses.join(', ') }`,
    ];
}

// Absent on an undeployed upload, which is normal: Cloudflare reconciles at
// deployment. Say nothing rather than warning about the absence.
function renderReconciliation(reconciliation) {
    if (!reconciliation) {
        return [];
    }

    const lines = [];

    for (const [ key, label ] of RECONCILIATION_SECTIONS) {
        const entries = toEntries(reconciliation[key]);

        if (entries.length === 0) {
            continue;
        }

        lines.push(`  ${ label }:`);

        for (const entry of entries) {
            lines.push(...renderReconciliationEntry(entry));
        }
    }

    lines.push(...renderRemovableEntries(reconciliation.removable_entries));

    if (lines.length > 0) {
        lines.unshift('', 'Durable Objects:');
        lines.push('');
    }

    return lines;
}

function renderReconciliationEntry(entry) {
    const lines = [ `    ${ describeEntry(entry) }` ];

    // Other Workers still bound to the affected class. Removing a tombstone
    // while this is non-empty orphans their bindings, so it is never elided.
    const referencing = toEntries(entry?.referencing_scripts);

    if (referencing.length > 0) {
        lines.push(`      still referenced by: ${ referencing.map(describeEntry).join(', ') }`);
    }

    return lines;
}

function renderRemovableEntries(removableEntries) {
    const entries = toEntries(removableEntries);

    if (entries.length === 0) {
        return [];
    }

    const lines = [ '  Stale declarations, now safe to delete from DURABLE_OBJECT_MIGRATIONS:' ];

    for (const entry of entries) {
        lines.push(...renderReconciliationEntry(entry));
    }

    return lines;
}

function toEntries(value) {
    return Array.isArray(value) ? value : [];
}

// Cloudflare's entry shapes vary by section and are not fully documented, so
// prefer the readable fields and fall back to the raw entry rather than
// dropping information the developer may need.
function describeEntry(entry) {
    if (typeof entry === 'string') {
        return entry;
    }

    if (entry && typeof entry === 'object') {
        const name = entry.class_name ?? entry.name ?? entry.export_name ?? null;
        const message = entry.message ?? entry.description ?? null;

        if (name && message) {
            return `${ name } — ${ message }`;
        }

        if (name || message) {
            return name ?? message;
        }
    }

    return JSON.stringify(entry);
}

function renderHashLine(label, changed, oldHash, newHash) {
    if (!changed) {
        return `  ${ label.padEnd(9) } unchanged`;
    }

    const from = oldHash ? abbreviate(oldHash) : '(none)';
    const to = abbreviate(newHash);

    return `  ${ label.padEnd(9) } changed    ${ from } -> ${ to }`;
}

function abbreviate(hash) {
    return `${ hash.slice(0, 6) }…`;
}
