import { isPlainObject } from 'kixx-assert';
import UsageError from '../usage-error.js';

const TAG_PATTERN = /^v(\d+)$/;

/**
 * Turns the recorded Durable Object class list, the configured class list,
 * and explicit migration declarations into either a complete migration plan
 * with its tag pair, or nothing. A class disappearing from config with no
 * declaration never becomes a deletion — that guard is what makes deletion
 * impossible to trigger by accident.
 *
 * A declaration is idempotent by subject: it applies only while its subject
 * is still in the recorded class list (or, for a transfer, while `to` is not
 * yet recorded), so it can stay in `DURABLE_OBJECT_MIGRATIONS` indefinitely
 * without needing to be removed after one deploy.
 * @module durable-object-migrations
 */

/**
 * @typedef {Object} MigrationPlan
 * @property {Object|null} operations - `{ new_sqlite_classes, deleted_classes, renamed_classes, transferred_classes }` entries present only when non-empty, or `null` when there is nothing to do.
 * @property {string|null} oldTag - The Worker's current migration tag, or `null` when it has never migrated. `null` when `operations` is `null`.
 * @property {string|null} newTag - The tag to record after this migration applies. `null` when `operations` is `null`.
 * @property {string[]} nextClasses - Sorted class list to record as state after this call.
 */

/**
 * @param {Object} args - Options.
 * @param {Object} args.environmentConfig - One environment's block from `cloudflare-config.js`.
 * @param {string[]} args.recordedClasses - Durable Object classes from the previous state file.
 * @param {string|null} args.migrationTag - Recorded migration tag, or `null` when never migrated.
 * @returns {MigrationPlan} The migration plan.
 * @throws {UsageError} When a declaration is malformed, a class remains
 *     unaccounted for with no declaration, or the recorded tag cannot be parsed.
 */
export function planDurableObjectMigrations(args) {
    const { environmentConfig, recordedClasses, migrationTag } = args ?? {};

    const configuredClasses = collectConfiguredClasses(environmentConfig);
    const declarations = environmentConfig.DURABLE_OBJECT_MIGRATIONS ?? [];

    validateDeclarations(declarations);

    let working = recordedClasses.slice();
    const newSqliteClasses = [];
    const deletedClasses = [];
    const renamedClasses = [];
    const transferredClasses = [];

    declarations.forEach((declaration) => {
        if (declaration.action === 'rename' && working.includes(declaration.from)) {
            working = working.filter((name) => name !== declaration.from);
            working.push(declaration.to);
            renamedClasses.push({ from: declaration.from, to: declaration.to });
        } else if (declaration.action === 'delete' && working.includes(declaration.className)) {
            working = working.filter((name) => name !== declaration.className);
            deletedClasses.push(declaration.className);
        } else if (declaration.action === 'transfer' && !working.includes(declaration.to)) {
            working.push(declaration.to);
            transferredClasses.push({
                from: declaration.from,
                from_script: declaration.fromScript,
                to: declaration.to,
            });
        }
    });

    for (const className of configuredClasses) {
        if (!working.includes(className)) {
            newSqliteClasses.push(className);
            working.push(className);
        }
    }

    const unaccounted = working.filter((className) => !configuredClasses.includes(className));

    if (unaccounted.length > 0) {
        throw new UsageError(
            `Durable Object class "${ unaccounted[0] }" is recorded but not configured. ` +
            'Declare a rename or a delete in DURABLE_OBJECT_MIGRATIONS.',
        );
    }

    const operations = buildOperations({
        newSqliteClasses,
        deletedClasses,
        renamedClasses,
        transferredClasses,
    });

    if (!operations) {
        return {
            operations: null,
            oldTag: null,
            newTag: null,
            nextClasses: configuredClasses.slice().sort(),
        };
    }

    const oldTag = migrationTag ?? null;
    const newTag = nextTag(oldTag);

    return {
        operations,
        oldTag,
        newTag,
        nextClasses: working.slice().sort(),
    };
}

function collectConfiguredClasses(environmentConfig) {
    const classes = [];

    if (environmentConfig.CONTENT_STORE?.durableObjectClassName) {
        classes.push(environmentConfig.CONTENT_STORE.durableObjectClassName);
    }

    return classes;
}

function validateDeclarations(declarations) {
    declarations.forEach((declaration, index) => {
        if (!isPlainObject(declaration)) {
            throw new UsageError(`DURABLE_OBJECT_MIGRATIONS[${ index }] must be an object`);
        }

        if (declaration.action === 'rename') {
            requireField(declaration.from, index, 'from');
            requireField(declaration.to, index, 'to');
        } else if (declaration.action === 'delete') {
            requireField(declaration.className, index, 'className');
        } else if (declaration.action === 'transfer') {
            requireField(declaration.from, index, 'from');
            requireField(declaration.fromScript, index, 'fromScript');
            requireField(declaration.to, index, 'to');
        } else {
            throw new UsageError(
                `DURABLE_OBJECT_MIGRATIONS[${ index }].action must be one of: rename, delete, transfer`,
            );
        }
    });
}

function requireField(value, index, field) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new UsageError(`DURABLE_OBJECT_MIGRATIONS[${ index }].${ field } must be a non-empty string`);
    }
}

function buildOperations(args) {
    const {
        newSqliteClasses,
        deletedClasses,
        renamedClasses,
        transferredClasses,
    } = args;

    const operations = {};

    if (newSqliteClasses.length > 0) {
        operations.new_sqlite_classes = newSqliteClasses;
    }

    if (deletedClasses.length > 0) {
        operations.deleted_classes = deletedClasses;
    }

    if (renamedClasses.length > 0) {
        operations.renamed_classes = renamedClasses;
    }

    if (transferredClasses.length > 0) {
        operations.transferred_classes = transferredClasses;
    }

    return Object.keys(operations).length > 0 ? operations : null;
}

function nextTag(oldTag) {
    if (oldTag === null) {
        return 'v1';
    }

    const match = TAG_PATTERN.exec(oldTag);

    if (!match) {
        throw new UsageError(`Recorded migration tag "${ oldTag }" does not match the expected "vN" format`);
    }

    return `v${ Number(match[1]) + 1 }`;
}
