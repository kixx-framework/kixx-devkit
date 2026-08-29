/**
 * Builder for the Cloudflare Worker Version payload.
 * @module cloudflare-worker-version
 */

import {
    assert,
    assertNonEmptyString,
    isBoolean,
    isPlainObject,
    isString,
    isUndefined,
} from 'kixx-assert';


/**
 * Required fields for each supported binding type.
 *
 * `ids` fields must be non-empty strings because they name or reference another
 * resource. `texts` fields hold caller data and may legitimately be empty, so an
 * empty string is accepted there but rejected for an id.
 *
 * WARNING: Cloudflare defines many more binding types than these. Adding one
 * here is the single change needed to support it; see also the supported types
 * listed in the CloudflareWorkerVersion class documentation.
 */
const BINDING_TYPES = {
    d1: { ids: [ 'id' ], texts: [] },
    durable_object_namespace: { ids: [ 'class_name' ], texts: [] },
    kv_namespace: { ids: [ 'namespace_id' ], texts: [] },
    plain_text: { ids: [], texts: [ 'text' ] },
    r2_bucket: { ids: [ 'bucket_name' ], texts: [] },
    secret_text: { ids: [], texts: [ 'text' ] },
    version_metadata: { ids: [], texts: [] },
};

const SUPPORTED_BINDING_TYPES = Object.keys(BINDING_TYPES).join(', ');

const MODULE_CONTENT_TYPE_ESM = 'application/javascript+module';
const MODULE_CONTENT_TYPE_TEXT = 'text/plain';

// Documented maximums are expressed in bytes, not characters.
const ANNOTATION_BYTE_LIMITS = {
    'workers/message': 1000,
    'workers/tag': 100,
    'workers/triggered_by': null,
};

const ANNOTATION_KEYS = Object.keys(ANNOTATION_BYTE_LIMITS);

const PLACEMENT_KEYS = [ 'mode', 'region', 'hostname', 'host' ];
const LIMITS_KEYS = [ 'cpu_ms', 'subrequests' ];
const CACHE_OPTIONS_KEYS = [ 'enabled', 'cross_version_cache' ];

// Cloudflare's own examples use both the bare date and a full UTC timestamp, so
// both are accepted. This only rejects a mis-ordered date like "01-01-2025".
const COMPATIBILITY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z)?$/;

// btoa() takes a binary string. Convert in slices because spreading a
// multi-megabyte Worker bundle into String.fromCharCode() overflows the stack.
const BASE64_CHUNK_SIZE = 0x8000;

const TEXT_ENCODER = new TextEncoder();


/**
 * Accumulates the modules, bindings, and runtime metadata that make up one
 * Cloudflare Worker version, then serializes them into the payload accepted by
 * `CloudflareAPIClient#createWorkerVersion()`.
 *
 * Reading configuration files and bundling JavaScript modules are out of scope.
 * Callers supply finished module content; this class owns only the Cloudflare
 * payload shape, including base64 transport encoding.
 *
 * Supported binding types: `d1`, `durable_object_namespace`, `kv_namespace`,
 * `plain_text`, `r2_bucket`, `secret_text`, and `version_metadata`. Any other
 * type is rejected rather than forwarded, so an unsupported binding fails
 * locally with a useful message instead of as an opaque Cloudflare API error.
 *
 * Only the modules, bindings, and migration operations accumulate after
 * construction. Every scalar field is fixed by the constructor.
 *
 * @see https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/subresources/versions/methods/create
 */
export default class CloudflareWorkerVersion {

    #annotations;
    #compatibilityDate;
    #compatibilityFlags;
    #placement;
    #cacheOptions;
    #limits;

    #bindings = [];
    #bindingNames = new Set();

    #modules = [];
    #moduleNames = new Set();
    #mainModule = null;

    #newClasses = [];
    #newSqliteClasses = [];
    #deletedClasses = [];
    #renamedClasses = [];
    #transferredClasses = [];

    #oldTag;
    #newTag;
    #hasMigrationTags = false;

    /**
     * @param {Object} [options] - Version metadata fixed for the life of the instance
     * @param {Object} [options.annotations] - Version metadata. Supports the keys
     *     `workers/message` (max 1000 bytes), `workers/tag` (max 100 bytes), and
     *     `workers/triggered_by`
     * @param {string} [options.compatibility_date] - Targeted Workers runtime date,
     *     formatted `YYYY-MM-DD` or as a full UTC timestamp
     * @param {string[]} [options.compatibility_flags] - Workers runtime feature flags.
     *     Flag names are not validated against a known list
     * @param {Object} [options.placement] - Smart Placement configuration. Supports the
     *     keys `mode`, `region`, `hostname`, and `host`; at least one is required
     * @param {Object} [options.cache_options] - Global cache configuration
     * @param {boolean} options.cache_options.enabled - Whether caching is enabled
     * @param {boolean} [options.cache_options.cross_version_cache] - Whether cached
     *     responses are shared across version uploads
     * @param {Object} [options.limits] - Runtime resource limits
     * @param {number} [options.limits.cpu_ms] - CPU time limit in milliseconds
     * @param {number} [options.limits.subrequests] - Subrequest limit per request
     */
    constructor(options) {
        const {
            annotations,
            compatibility_date,
            compatibility_flags,
            placement,
            cache_options,
            limits,
        } = options ?? {};

        this.#annotations = isUndefined(annotations)
            ? null
            : validateAnnotations(annotations);

        if (!isUndefined(compatibility_date)) {
            assertNonEmptyString(
                compatibility_date,
                'CloudflareWorkerVersion() compatibility_date must be a non-empty string',
            );
            assert(
                COMPATIBILITY_DATE_PATTERN.test(compatibility_date),
                'CloudflareWorkerVersion() compatibility_date must be formatted YYYY-MM-DD',
            );
        }

        this.#compatibilityDate = compatibility_date ?? null;

        this.#compatibilityFlags = isUndefined(compatibility_flags)
            ? null
            : validateCompatibilityFlags(compatibility_flags);

        this.#placement = isUndefined(placement) ? null : validatePlacement(placement);
        this.#cacheOptions = isUndefined(cache_options) ? null : validateCacheOptions(cache_options);
        this.#limits = isUndefined(limits) ? null : validateLimits(limits);
    }

    /**
     * Adds one binding to the version.
     *
     * The binding type must be one of the supported types; anything else is
     * rejected. Only the fields documented for that type are carried into the
     * payload, so an unrecognized key is dropped rather than forwarded.
     *
     * @param {Object} binding - Binding definition
     * @param {string} binding.type - Supported Cloudflare binding type
     * @param {string} binding.name - Variable name exposed to the Worker
     * @returns {CloudflareWorkerVersion} This instance, for chaining
     */
    addBinding(binding) {
        assert(isPlainObject(binding), 'CloudflareWorkerVersion#addBinding() requires a binding');

        const { type, name } = binding;

        assertNonEmptyString(type, 'CloudflareWorkerVersion#addBinding() requires a binding.type');
        assertNonEmptyString(name, 'CloudflareWorkerVersion#addBinding() requires a binding.name');

        const spec = Object.hasOwn(BINDING_TYPES, type) ? BINDING_TYPES[type] : null;

        assert(
            spec,
            `CloudflareWorkerVersion#addBinding() unsupported binding type "${ type }"; ` +
            `supported types are: ${ SUPPORTED_BINDING_TYPES }`,
        );

        // Cloudflare exposes bindings as Worker globals keyed by name, so a
        // duplicate would silently shadow an earlier binding. Catch it here
        // rather than in toJSON() so the error points at the offending call.
        assert(
            !this.#bindingNames.has(name),
            `CloudflareWorkerVersion#addBinding() duplicate binding name "${ name }"`,
        );

        const entry = { type, name };

        for (const field of spec.ids) {
            assertNonEmptyString(
                binding[field],
                `CloudflareWorkerVersion#addBinding() ${ type } binding "${ name }" requires the ${ field } field`,
            );
            entry[field] = binding[field];
        }

        for (const field of spec.texts) {
            assert(
                isString(binding[field]),
                `CloudflareWorkerVersion#addBinding() ${ type } binding "${ name }" requires the ${ field } field as a string`,
            );
            entry[field] = binding[field];
        }

        this.#bindingNames.add(name);
        this.#bindings.push(entry);

        return this;
    }

    /**
     * Adds one module to the version, base64 encoding its content for transport.
     *
     * When `main` is true the module is recorded as the version's `main_module`.
     * Exactly one module may claim it, and designating it here makes it
     * impossible for `main_module` to name a module that was never added.
     *
     * @param {Object} mod - Module definition
     * @param {string} mod.name - Module name, used as its import specifier
     * @param {string|Uint8Array} mod.content - Finished module content, already bundled
     * @param {string} [mod.content_type] - Overrides the type inferred from the name.
     *     Names ending in `.js` or `.mjs` infer `application/javascript+module`;
     *     everything else infers `text/plain`
     * @param {boolean} [mod.main=false] - Whether this module is the version entry point
     * @returns {CloudflareWorkerVersion} This instance, for chaining
     */
    addModule(mod) {
        assert(isPlainObject(mod), 'CloudflareWorkerVersion#addModule() requires a module');

        const {
            name,
            content,
            content_type,
            main = false,
        } = mod;

        assertNonEmptyString(name, 'CloudflareWorkerVersion#addModule() requires a module.name');
        assert(
            isString(content) || content instanceof Uint8Array,
            `CloudflareWorkerVersion#addModule() module "${ name }" content must be a string or Uint8Array`,
        );
        assert(
            isBoolean(main),
            `CloudflareWorkerVersion#addModule() module "${ name }" main must be a boolean`,
        );
        assert(
            !this.#moduleNames.has(name),
            `CloudflareWorkerVersion#addModule() duplicate module name "${ name }"`,
        );

        if (!isUndefined(content_type)) {
            assertNonEmptyString(
                content_type,
                `CloudflareWorkerVersion#addModule() module "${ name }" content_type must be a non-empty string`,
            );
        }

        if (main) {
            assert(
                !this.#mainModule,
                `CloudflareWorkerVersion#addModule() main module already set to "${ this.#mainModule }"`,
            );
            this.#mainModule = name;
        }

        this.#moduleNames.add(name);
        this.#modules.push({
            name,
            content_type: content_type ?? inferContentType(name),
            content_base64: encodeBase64(isString(content) ? TEXT_ENCODER.encode(content) : content),
        });

        return this;
    }

    /**
     * Declares a new Durable Object class backed by the legacy key-value store.
     *
     * Prefer addNewSqliteClass(). Per Cloudflare, this applies only to namespaces
     * that already exist on the key-value backend.
     *
     * @param {string} className - Durable Object class name
     * @returns {CloudflareWorkerVersion} This instance, for chaining
     */
    addNewClass(className) {
        assertNonEmptyString(className, 'CloudflareWorkerVersion#addNewClass() requires a className');
        this.#newClasses.push(className);

        return this;
    }

    /**
     * Declares a new SQLite-backed Durable Object class. This is the correct
     * choice for a namespace that does not already exist.
     *
     * @param {string} className - Durable Object class name
     * @returns {CloudflareWorkerVersion} This instance, for chaining
     */
    addNewSqliteClass(className) {
        assertNonEmptyString(className, 'CloudflareWorkerVersion#addNewSqliteClass() requires a className');
        this.#newSqliteClasses.push(className);

        return this;
    }

    /**
     * Marks a Durable Object class for deletion.
     *
     * Deleting a class destroys its stored data. Cloudflare provides no undo and
     * no trash for this operation.
     *
     * @param {string} className - Durable Object class name to delete
     * @returns {CloudflareWorkerVersion} This instance, for chaining
     */
    deleteClass(className) {
        assertNonEmptyString(className, 'CloudflareWorkerVersion#deleteClass() requires a className');
        this.#deletedClasses.push(className);

        return this;
    }

    /**
     * Renames a Durable Object class, carrying its stored data to the new name.
     *
     * @param {string} from - Current class name
     * @param {string} to - New class name
     * @returns {CloudflareWorkerVersion} This instance, for chaining
     */
    renameClass(from, to) {
        assertNonEmptyString(from, 'CloudflareWorkerVersion#renameClass() requires a from class name');
        assertNonEmptyString(to, 'CloudflareWorkerVersion#renameClass() requires a to class name');
        this.#renamedClasses.push({ from, to });

        return this;
    }

    /**
     * Transfers a Durable Object class and its stored data from another Worker.
     *
     * @param {Object} transfer - Transfer definition
     * @param {string} transfer.from - Class name on the source Worker
     * @param {string} transfer.from_script - Source Worker name
     * @param {string} transfer.to - Class name on this Worker
     * @returns {CloudflareWorkerVersion} This instance, for chaining
     */
    transferClass(transfer) {
        assert(isPlainObject(transfer), 'CloudflareWorkerVersion#transferClass() requires a transfer');

        const { from, from_script, to } = transfer;

        assertNonEmptyString(from, 'CloudflareWorkerVersion#transferClass() requires a transfer.from');
        assertNonEmptyString(
            from_script,
            'CloudflareWorkerVersion#transferClass() requires a transfer.from_script',
        );
        assertNonEmptyString(to, 'CloudflareWorkerVersion#transferClass() requires a transfer.to');

        this.#transferredClasses.push({ from, from_script, to });

        return this;
    }

    /**
     * Sets the migration tags guarding this version's migration.
     *
     * Cloudflare does not deduplicate migrations by payload content, so a retried
     * upload would otherwise reapply a rename or a deletion. `old_tag` is verified
     * against the Worker's current tag and rejects the upload on a mismatch;
     * `new_tag` becomes the Worker's tag once the migration applies. Together they
     * make a repeated call fail instead of applying twice.
     *
     * A Worker that has never had a migration has no current tag. Pass `null` for
     * `oldTag` to express that. It must be passed explicitly, so the guard can
     * never be dropped by omission.
     *
     * @param {string|null} oldTag - The Worker's current migration tag, or null when
     *     this is the Worker's first migration
     * @param {string} newTag - The tag the Worker carries after this migration applies
     * @returns {CloudflareWorkerVersion} This instance, for chaining
     */
    setMigrationTags(oldTag, newTag) {
        assert(
            oldTag === null || isString(oldTag),
            'CloudflareWorkerVersion#setMigrationTags() requires an oldTag string or an explicit null',
        );

        if (oldTag !== null) {
            assertNonEmptyString(
                oldTag,
                'CloudflareWorkerVersion#setMigrationTags() oldTag must be a non-empty string or null',
            );
        }

        assertNonEmptyString(newTag, 'CloudflareWorkerVersion#setMigrationTags() requires a newTag');

        this.#oldTag = oldTag;
        this.#newTag = newTag;
        this.#hasMigrationTags = true;

        return this;
    }

    /**
     * Builds the Cloudflare Worker version payload.
     *
     * Validates the invariants that can only be checked once building stops, then
     * returns a newly built object with copied arrays. The instance stays mutable
     * and this may be called repeatedly; mutating a returned payload cannot affect
     * the instance or a payload returned by another call.
     *
     * Keys are omitted rather than emitted empty. In particular a version that
     * recorded no Durable Object operation carries no `migrations` key at all,
     * because an empty migration block is not equivalent to no migration.
     *
     * @returns {Object} Version payload for CloudflareAPIClient#createWorkerVersion()
     */
    toJSON() {
        // A main module implies at least one module was added, so this one
        // assertion covers both requirements.
        assert(
            this.#mainModule,
            'CloudflareWorkerVersion#toJSON() requires a module added with main: true',
        );

        const payload = {
            modules: this.#modules.map((mod) => ({ ...mod })),
            main_module: this.#mainModule,
        };

        if (this.#annotations) {
            payload.annotations = { ...this.#annotations };
        }

        if (this.#compatibilityDate) {
            payload.compatibility_date = this.#compatibilityDate;
        }

        if (this.#compatibilityFlags) {
            payload.compatibility_flags = this.#compatibilityFlags.slice();
        }

        if (this.#placement) {
            payload.placement = { ...this.#placement };
        }

        if (this.#cacheOptions) {
            payload.cache_options = { ...this.#cacheOptions };
        }

        if (this.#limits) {
            payload.limits = { ...this.#limits };
        }

        if (this.#bindings.length > 0) {
            payload.bindings = this.#bindings.map((binding) => ({ ...binding }));
        }

        const migrations = this.#buildMigrations();

        if (migrations) {
            payload.migrations = migrations;
        }

        return payload;
    }

    /**
     * Builds the single-step migration block, or null when no Durable Object
     * operation was recorded.
     */
    #buildMigrations() {
        const migrations = {};

        if (this.#newClasses.length > 0) {
            migrations.new_classes = this.#newClasses.slice();
        }

        if (this.#newSqliteClasses.length > 0) {
            migrations.new_sqlite_classes = this.#newSqliteClasses.slice();
        }

        if (this.#deletedClasses.length > 0) {
            migrations.deleted_classes = this.#deletedClasses.slice();
        }

        if (this.#renamedClasses.length > 0) {
            migrations.renamed_classes = this.#renamedClasses.map((entry) => ({ ...entry }));
        }

        if (this.#transferredClasses.length > 0) {
            migrations.transferred_classes = this.#transferredClasses.map((entry) => ({ ...entry }));
        }

        if (Object.keys(migrations).length === 0) {
            return null;
        }

        assert(
            this.#hasMigrationTags,
            'CloudflareWorkerVersion#toJSON() a version carrying migrations requires migration tags',
        );

        // A null oldTag means the Worker has no current tag to verify against,
        // so the field is omitted rather than sent as null.
        if (this.#oldTag !== null) {
            migrations.old_tag = this.#oldTag;
        }

        migrations.new_tag = this.#newTag;

        return migrations;
    }
}


function validateAnnotations(annotations) {
    assert(isPlainObject(annotations), 'CloudflareWorkerVersion() annotations must be an object');

    assertKnownKeys(annotations, ANNOTATION_KEYS, 'annotations');

    const validated = {};

    for (const key of ANNOTATION_KEYS) {
        if (isUndefined(annotations[key])) {
            continue;
        }

        assertNonEmptyString(
            annotations[key],
            `CloudflareWorkerVersion() annotations "${ key }" must be a non-empty string`,
        );

        const limit = ANNOTATION_BYTE_LIMITS[key];

        // Cloudflare truncates an over-long message server side, but this class
        // never alters caller data: an over-limit value is reported, not trimmed.
        if (limit !== null) {
            assert(
                byteLength(annotations[key]) <= limit,
                `CloudflareWorkerVersion() annotations "${ key }" must not exceed ${ limit } bytes`,
            );
        }

        validated[key] = annotations[key];
    }

    return validated;
}


function validateCompatibilityFlags(flags) {
    assert(
        Array.isArray(flags),
        'CloudflareWorkerVersion() compatibility_flags must be an array',
    );

    flags.forEach((flag, index) => {
        assertNonEmptyString(
            flag,
            `CloudflareWorkerVersion() compatibility_flags[${ index }] must be a non-empty string`,
        );
    });

    // Flag names are Cloudflare's vocabulary and change without notice, so the
    // names themselves are deliberately not checked against a known list.
    return flags.slice();
}


function validatePlacement(placement) {
    assert(isPlainObject(placement), 'CloudflareWorkerVersion() placement must be an object');

    assertKnownKeys(placement, PLACEMENT_KEYS, 'placement');

    const validated = {};

    for (const key of PLACEMENT_KEYS) {
        if (isUndefined(placement[key])) {
            continue;
        }

        assertNonEmptyString(
            placement[key],
            `CloudflareWorkerVersion() placement.${ key } must be a non-empty string`,
        );

        validated[key] = placement[key];
    }

    assert(
        Object.keys(validated).length > 0,
        `CloudflareWorkerVersion() placement requires one of: ${ PLACEMENT_KEYS.join(', ') }`,
    );

    return validated;
}


function validateCacheOptions(cacheOptions) {
    assert(isPlainObject(cacheOptions), 'CloudflareWorkerVersion() cache_options must be an object');

    assertKnownKeys(cacheOptions, CACHE_OPTIONS_KEYS, 'cache_options');

    assert(
        isBoolean(cacheOptions.enabled),
        'CloudflareWorkerVersion() cache_options.enabled must be a boolean',
    );

    const validated = { enabled: cacheOptions.enabled };

    // cross_version_cache is independent of enabled: it records the preference so
    // it survives caching being turned off and back on, so false is meaningful
    // and must not be collapsed away.
    if (!isUndefined(cacheOptions.cross_version_cache)) {
        assert(
            isBoolean(cacheOptions.cross_version_cache),
            'CloudflareWorkerVersion() cache_options.cross_version_cache must be a boolean',
        );
        validated.cross_version_cache = cacheOptions.cross_version_cache;
    }

    return validated;
}


function validateLimits(limits) {
    assert(isPlainObject(limits), 'CloudflareWorkerVersion() limits must be an object');

    assertKnownKeys(limits, LIMITS_KEYS, 'limits');

    const validated = {};

    for (const key of LIMITS_KEYS) {
        if (isUndefined(limits[key])) {
            continue;
        }

        assert(
            Number.isInteger(limits[key]) && limits[key] > 0,
            `CloudflareWorkerVersion() limits.${ key } must be a positive integer`,
        );

        validated[key] = limits[key];
    }

    assert(
        Object.keys(validated).length > 0,
        `CloudflareWorkerVersion() limits requires one of: ${ LIMITS_KEYS.join(', ') }`,
    );

    return validated;
}


// Rejecting an unknown key turns a typo like "namespace-id" into a local error
// instead of a silently dropped field that reaches Cloudflare malformed.
function assertKnownKeys(source, knownKeys, label) {
    for (const key of Object.keys(source)) {
        assert(
            knownKeys.includes(key),
            `CloudflareWorkerVersion() ${ label } does not support the key "${ key }"`,
        );
    }
}


function inferContentType(name) {
    if (name.endsWith('.js') || name.endsWith('.mjs')) {
        return MODULE_CONTENT_TYPE_ESM;
    }

    return MODULE_CONTENT_TYPE_TEXT;
}


function byteLength(str) {
    return TEXT_ENCODER.encode(str).length;
}


function encodeBase64(bytes) {
    let binary = '';

    for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_SIZE));
    }

    return btoa(binary);
}
