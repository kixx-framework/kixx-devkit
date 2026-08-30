import { isPlainObject } from 'kixx-assert';
import UsageError from '../usage-error.js';

/**
 * Projects one environment's configuration into the declarative Durable Object
 * `exports` map Cloudflare reconciles against the Worker's real namespaces.
 *
 * This is a pure projection of configuration. There is no recorded class list,
 * no diffing, and no migration tag: the same configuration always yields the
 * same map, and uploading it twice applies nothing twice.
 *
 * Because Cloudflare owns reconciliation, a class that vanishes from config is
 * not this module's problem — Cloudflare reports the orphaned namespace itself.
 * The legacy module raised a `UsageError` there; dropping that guard is
 * deliberate, not a regression.
 *
 * A tombstone declaration stays in `DURABLE_OBJECT_MIGRATIONS` indefinitely at
 * no cost. Under the legacy scheme a stale declaration was silent because it
 * applied only while its subject was still recorded; there is no recorded list
 * now, so Cloudflare reports it under `removable_entries` on every subsequent
 * deploy instead. Stale declarations stay harmless and non-blocking — the
 * report is how a developer learns which are safe to delete.
 *
 * `DURABLE_OBJECT_MIGRATIONS` keeps its name despite no longer producing
 * migrations, and accepts four declaration shapes:
 *
 * - `{ action: 'rename', from, to }` — `from` becomes a renamed tombstone
 *   carrying its stored data to `to`, which must also be a live class.
 * - `{ action: 'delete', className }` — a deleted tombstone. This destroys the
 *   namespace's stored data, with no undo.
 * - `{ action: 'transfer', from, fromScript, to }` — the receiving side of a
 *   transfer from another Worker. `to` stays live on this Worker.
 * - `{ action: 'transfer-away', className, toScript }` — the sending side,
 *   which the legacy migration shape could not express at all. Both sides of a
 *   transfer must be declared, each on its own Worker.
 * @module durable-object-exports
 */

const DURABLE_OBJECT = 'durable-object';

// New namespaces are always SQLite-backed. Cloudflare no longer provisions a
// key-value namespace, so `legacy-kv` is never emitted.
const STORAGE = 'sqlite';

const ACTIONS = [ 'rename', 'delete', 'transfer', 'transfer-away' ];

/**
 * @typedef {Object} DurableObjectExports
 * @property {Object} exports - The desired `exports` map, keyed by class name. Empty when the environment declares no Durable Object.
 * @property {string[]} liveClasses - Class names the map keeps serving, sorted. A binding may only target one of these.
 */

/**
 * @param {Object} args - Options.
 * @param {Object} args.environmentConfig - One environment's block from `cloudflare-config.js`.
 * @returns {DurableObjectExports} The desired exports map and its live class names.
 * @throws {UsageError} When a declaration is malformed or collides with a
 *     configured live class.
 */
export function buildDurableObjectExports(args) {
    const { environmentConfig } = args ?? {};

    const configuredClasses = collectConfiguredClasses(environmentConfig);
    const declarations = environmentConfig.DURABLE_OBJECT_MIGRATIONS ?? [];

    validateDeclarations(declarations);

    const exports = {};

    for (const className of configuredClasses) {
        exports[className] = { type: DURABLE_OBJECT, storage: STORAGE };
    }

    declarations.forEach((declaration, index) => {
        const [ className, entry ] = projectDeclaration(declaration);

        // Under the legacy scheme the recorded-class check made this collision
        // unreachable. It is reachable now, and resolving it silently would
        // either tombstone a live class or drop the declaration.
        if (Object.hasOwn(exports, className)) {
            throw new UsageError(
                `DURABLE_OBJECT_MIGRATIONS[${ index }] targets class "${ className }", ` +
                'which is already declared by this environment\'s configuration',
            );
        }

        exports[className] = entry;
    });

    return { exports, liveClasses: collectLiveClasses(exports) };
}

// Preserved as the single collection point so a second Durable Object source
// is a one-line addition rather than a search through the module.
function collectConfiguredClasses(environmentConfig) {
    const classes = [];

    if (environmentConfig.CONTENT_STORE?.durableObjectClassName) {
        classes.push(environmentConfig.CONTENT_STORE.durableObjectClassName);
    }

    return classes;
}

function projectDeclaration(declaration) {
    switch (declaration.action) {
        case 'rename':
            return [
                declaration.from,
                { type: DURABLE_OBJECT, state: 'renamed', renamed_to: declaration.to },
            ];

        case 'delete':
            return [
                declaration.className,
                { type: DURABLE_OBJECT, state: 'deleted' },
            ];

        // The receiving side of a transfer. This is a live entry, not a
        // tombstone: the class keeps serving once the transfer completes.
        case 'transfer':
            return [
                declaration.to,
                {
                    type: DURABLE_OBJECT,
                    state: 'expecting-transfer',
                    storage: STORAGE,
                    transfer_from: declaration.fromScript,
                },
            ];

        // The sending side, which the legacy migration shape could not express.
        default:
            return [
                declaration.className,
                {
                    type: DURABLE_OBJECT,
                    state: 'transferred',
                    transferred_to: declaration.toScript,
                },
            ];
    }
}

function collectLiveClasses(exports) {
    const live = [];

    for (const [ className, entry ] of Object.entries(exports)) {
        if (!entry.state || entry.state === 'created' || entry.state === 'expecting-transfer') {
            live.push(className);
        }
    }

    return live.sort();
}

function validateDeclarations(declarations) {
    declarations.forEach((declaration, index) => {
        if (!isPlainObject(declaration)) {
            throw new UsageError(`DURABLE_OBJECT_MIGRATIONS[${ index }] must be an object`);
        }

        switch (declaration.action) {
            case 'rename':
                requireField(declaration.from, index, 'from');
                requireField(declaration.to, index, 'to');
                break;

            case 'delete':
                requireField(declaration.className, index, 'className');
                break;

            case 'transfer':
                requireField(declaration.from, index, 'from');
                requireField(declaration.fromScript, index, 'fromScript');
                requireField(declaration.to, index, 'to');
                break;

            case 'transfer-away':
                requireField(declaration.className, index, 'className');
                requireField(declaration.toScript, index, 'toScript');
                break;

            default:
                throw new UsageError(
                    `DURABLE_OBJECT_MIGRATIONS[${ index }].action must be one of: ${ ACTIONS.join(', ') }`,
                );
        }
    });
}

function requireField(value, index, field) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new UsageError(`DURABLE_OBJECT_MIGRATIONS[${ index }].${ field } must be a non-empty string`);
    }
}
