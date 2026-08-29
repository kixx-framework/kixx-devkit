import { describe } from 'kixx-test';
import { assert, assertEqual } from 'kixx-assert';
import { planDurableObjectMigrations } from '../../../../lib/cloudflare/durable-object-migrations.js';
import CloudflareWorkerVersion from '../../../../lib/cloudflare/cloudflare-worker-version.js';


describe('durable-object-migrations', ({ it }) => {
    it('adds a new class as new_sqlite_classes with tags v1 when nothing is recorded', () => {
        const plan = planDurableObjectMigrations({
            environmentConfig: makeConfig('X'),
            recordedClasses: [],
            migrationTag: null,
        });

        assertEqual('X', plan.operations.new_sqlite_classes[0]);
        assertEqual(null, plan.oldTag);
        assertEqual('v1', plan.newTag);
    });

    it('returns null operations and an untouched tag when recorded equals configured', () => {
        const plan = planDurableObjectMigrations({
            environmentConfig: makeConfig('X'),
            recordedClasses: [ 'X' ],
            migrationTag: 'v3',
        });

        assertEqual(null, plan.operations);
        assertEqual('X', plan.nextClasses.join(','));
    });

    // CONTENT_STORE.durableObjectClassName is the only configured-class source
    // today, so "a second configured class" is exercised through a rename
    // declaration adding a class alongside the one already recorded, rather
    // than through a second config block (none exists yet).
    it('does not re-add a class that is already recorded and still configured', () => {
        const config = makeConfig('X');
        config.DURABLE_OBJECT_MIGRATIONS = [ { action: 'delete', className: 'Retired' } ];

        const plan = planDurableObjectMigrations({
            environmentConfig: config,
            recordedClasses: [ 'X', 'Retired' ],
            migrationTag: 'v1',
        });

        assertEqual(undefined, plan.operations.new_sqlite_classes);
        assertEqual('Retired', plan.operations.deleted_classes[0]);
        assertEqual('X', plan.nextClasses.join(','));
    });

    it('throws naming a recorded class absent from config with no declaration', () => {
        const caught = catchError(() => {
            return planDurableObjectMigrations({
                environmentConfig: makeConfig(),
                recordedClasses: [ 'Orphan' ],
                migrationTag: null,
            });
        });

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes('Orphan'), 'expected the message to name the class');
    });

    it('applies a rename declaration and records the renamed class', () => {
        const config = makeConfig();
        config.DURABLE_OBJECT_MIGRATIONS = [ { action: 'rename', from: 'OldName', to: 'NewName' } ];
        config.CONTENT_STORE.durableObjectClassName = 'NewName';

        const plan = planDurableObjectMigrations({
            environmentConfig: config,
            recordedClasses: [ 'OldName' ],
            migrationTag: null,
        });

        assertEqual('OldName', plan.operations.renamed_classes[0].from);
        assertEqual('NewName', plan.operations.renamed_classes[0].to);
        assert(plan.nextClasses.includes('NewName'), 'expected NewName to be recorded');
    });

    it('is a no-op once a rename declaration has been recorded', () => {
        const config = makeConfig('NewName');
        config.DURABLE_OBJECT_MIGRATIONS = [ { action: 'rename', from: 'OldName', to: 'NewName' } ];

        const plan = planDurableObjectMigrations({
            environmentConfig: config,
            recordedClasses: [ 'NewName' ],
            migrationTag: 'v1',
        });

        assertEqual(null, plan.operations);
    });

    it('applies a delete declaration and removes the class', () => {
        const config = makeConfig();
        config.DURABLE_OBJECT_MIGRATIONS = [ { action: 'delete', className: 'DeadName' } ];

        const plan = planDurableObjectMigrations({
            environmentConfig: config,
            recordedClasses: [ 'DeadName' ],
            migrationTag: null,
        });

        assertEqual('DeadName', plan.operations.deleted_classes[0]);
        assert(!plan.nextClasses.includes('DeadName'), 'expected DeadName to be removed');
    });

    it('is a no-op once a delete declaration has been recorded', () => {
        const config = makeConfig();
        config.DURABLE_OBJECT_MIGRATIONS = [ { action: 'delete', className: 'DeadName' } ];

        const plan = planDurableObjectMigrations({
            environmentConfig: config,
            recordedClasses: [],
            migrationTag: 'v1',
        });

        assertEqual(null, plan.operations);
    });

    it('applies a transfer declaration and adds the class', () => {
        const config = makeConfig();
        config.DURABLE_OBJECT_MIGRATIONS = [
            { action: 'transfer', from: 'Name', fromScript: 'old-worker', to: 'Name' },
        ];
        config.CONTENT_STORE.durableObjectClassName = 'Name';

        const plan = planDurableObjectMigrations({
            environmentConfig: config,
            recordedClasses: [],
            migrationTag: null,
        });

        assertEqual('Name', plan.operations.transferred_classes[0].to);
        assertEqual('old-worker', plan.operations.transferred_classes[0].from_script);
        assert(plan.nextClasses.includes('Name'), 'expected Name to be recorded');
    });

    it('is a no-op once a transfer declaration has been recorded', () => {
        const config = makeConfig('Name');
        config.DURABLE_OBJECT_MIGRATIONS = [
            { action: 'transfer', from: 'Name', fromScript: 'old-worker', to: 'Name' },
        ];

        const plan = planDurableObjectMigrations({
            environmentConfig: config,
            recordedClasses: [ 'Name' ],
            migrationTag: 'v1',
        });

        assertEqual(null, plan.operations);
    });

    // A rename's target must land on the currently configured class (else the
    // renamed class is left "unaccounted" and rejected), and there is only one
    // configured-class source today, so a genuine rename-plus-brand-new-class
    // case is not constructible from real config. A delete plus a new class
    // demonstrates the same "two operation kinds under one tag pair" property.
    it('produces both a delete and a new class under one tag pair in one run', () => {
        const config = makeConfig('BrandNewClass');
        config.DURABLE_OBJECT_MIGRATIONS = [ { action: 'delete', className: 'DeadName' } ];

        const plan = planDurableObjectMigrations({
            environmentConfig: config,
            recordedClasses: [ 'DeadName' ],
            migrationTag: 'v2',
        });

        assertEqual(1, plan.operations.deleted_classes.length);
        assertEqual(1, plan.operations.new_sqlite_classes.length);
        assertEqual('v2', plan.oldTag);
        assertEqual('v3', plan.newTag);
    });

    it('advances v3 to v4', () => {
        const plan = planDurableObjectMigrations({
            environmentConfig: makeConfig('X'),
            recordedClasses: [],
            migrationTag: 'v3',
        });

        assertEqual('v4', plan.newTag);
    });

    it('throws on an unparseable recorded tag', () => {
        const caught = catchError(() => {
            return planDurableObjectMigrations({
                environmentConfig: makeConfig('X'),
                recordedClasses: [],
                migrationTag: 'release-2',
            });
        });

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
    });

    it('throws naming the index for a malformed declaration', () => {
        const config = makeConfig();
        config.DURABLE_OBJECT_MIGRATIONS = [ { action: 'rename', from: 'OldName' } ];

        const caught = catchError(() => {
            return planDurableObjectMigrations({
                environmentConfig: config,
                recordedClasses: [ 'OldName' ],
                migrationTag: null,
            });
        });

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes('[0]'), 'expected the message to name the index');
    });

    it('never produces new_classes', () => {
        const plan = planDurableObjectMigrations({
            environmentConfig: makeConfig('X'),
            recordedClasses: [],
            migrationTag: null,
        });

        assert(!Object.prototype.hasOwnProperty.call(plan.operations, 'new_classes'), 'expected no new_classes key');
    });

    // With one configured-class source, every item left in the working set
    // after declarations must equal the single configured class (else it is
    // "unaccounted" and rejected), so nextClasses is always 0 or 1 elements
    // today — a real multi-element ordering case needs a second source, not
    // yet added. This still exercises the `.sort()` call on the result.
    it('returns nextClasses sorted', () => {
        const plan = planDurableObjectMigrations({
            environmentConfig: makeConfig('Zebra'),
            recordedClasses: [],
            migrationTag: null,
        });

        assertEqual('Zebra', plan.nextClasses.join(','));
        assertEqual(true, Array.isArray(plan.nextClasses));
    });

    it('feeds a full plan into CloudflareWorkerVersion and produces the matching migrations payload', () => {
        const config = makeConfig();
        config.DURABLE_OBJECT_MIGRATIONS = [ { action: 'rename', from: 'OldName', to: 'NewName' } ];
        config.CONTENT_STORE.durableObjectClassName = 'NewName';

        const plan = planDurableObjectMigrations({
            environmentConfig: config,
            recordedClasses: [ 'OldName' ],
            migrationTag: 'v2',
        });

        const version = new CloudflareWorkerVersion();
        version.addModule({ name: 'index.js', content: 'export default {};', main: true });

        if (plan.operations.new_sqlite_classes) {
            plan.operations.new_sqlite_classes.forEach((name) => version.addNewSqliteClass(name));
        }
        if (plan.operations.deleted_classes) {
            plan.operations.deleted_classes.forEach((name) => version.deleteClass(name));
        }
        if (plan.operations.renamed_classes) {
            plan.operations.renamed_classes.forEach(({ from, to }) => version.renameClass(from, to));
        }
        if (plan.operations.transferred_classes) {
            plan.operations.transferred_classes.forEach((transfer) => version.transferClass(transfer));
        }
        version.setMigrationTags(plan.oldTag, plan.newTag);

        const payload = version.toJSON();

        assertEqual('OldName', payload.migrations.renamed_classes[0].from);
        assertEqual('NewName', payload.migrations.renamed_classes[0].to);
        assertEqual('v2', payload.migrations.old_tag);
        assertEqual('v3', payload.migrations.new_tag);
    });
});

function makeConfig(durableObjectClassName) {
    const config = {
        CONTENT_STORE: {
            kvBindingName: 'CONTENT_STORE_KV',
            kvNamespaceId: 'kv-id',
            durableObjectBindingName: 'CONTENT_STORE_DO',
        },
    };

    if (durableObjectClassName) {
        config.CONTENT_STORE.durableObjectClassName = durableObjectClassName;
    }

    return config;
}

function catchError(fn) {
    try {
        fn();
    } catch (error) {
        return error;
    }
    return null;
}
