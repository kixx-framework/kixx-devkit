import { describe } from 'kixx-test';
import { assert, assertEqual, assertMatches } from 'kixx-assert';
import {
    FORMAT,
    canonicalize,
    getBlobSize,
    hashArrayBufferBlob,
    hashStringBlob,
} from '../../../../lib/publishing/addressing.js';


/*
 * Regenerate these vectors from the project root with the upstream module:
 *
 * node --input-type=module -e "import { canonicalize, hashStringBlob,
 * hashArrayBufferBlob } from
 * './tmp/sample-app/kixx/content-addressable-store/addressing.js'; ..."
 *
 * Pass the literal inputs below to the matching hash export. Canonicalize the
 * nested object and array before hashing them as string blobs.
 */
const STRING_VECTORS = [
    [ '', 'jp2relzuivkmko66f25yzuvx4m', 0 ],
    [ 'hello', 'ztxlpkmf5tb5vpfuzd3gntldp4', 5 ],
    [ 'héllo 🌍', '4wankw6j3k5rseycis4zd4h6lu', 11 ],
    [
        canonicalize({ z: { b: 2, a: 1 }, a: 'first' }),
        'plz364zlhjympwbbekctnmc56i',
        31,
    ],
    [
        canonicalize([ 'alpha', { z: false, a: null }, 3 ]),
        'n5uybtrgxila37ieu7gghq3ppq',
        32,
    ],
];


describe('publishing/addressing', ({ it }) => {
    it('pins the framework format', () => {
        assertEqual(2, FORMAT);
    });

    it('sorts object keys recursively and omits undefined properties', () => {
        const value = {
            z: { y: undefined, b: 2, a: 1 },
            omitted: undefined,
            a: 'first',
        };

        assertEqual('{"a":"first","z":{"a":1,"b":2}}', canonicalize(value));
    });

    it('preserves array order', () => {
        assertEqual('[3,{"a":1,"b":2},1]', canonicalize([ 3, { b: 2, a: 1 }, 1 ]));
    });

    it('serializes Date objects as empty objects', () => {
        assertEqual('{}', canonicalize(new Date('2026-08-31T00:00:00.000Z')));
    });

    it('rejects non-finite numbers and unsupported types', () => {
        for (const value of [ NaN, Infinity, -Infinity, undefined, 1n, Symbol('x'), () => null ]) {
            const caught = catchError(() => canonicalize(value));

            assert(caught, `expected ${ String(value) } to throw`);
            assertEqual('TypeError', caught.name);
        }
    });

    it('matches upstream string blob digests and UTF-8 sizes', () => {
        for (const [ value, expectedHash, expectedSize ] of STRING_VECTORS) {
            assertEqual(expectedHash, hashStringBlob(value));
            assertEqual(expectedSize, getBlobSize(value));
            assertMatches(/^[a-z2-7]{26}$/, hashStringBlob(value));
        }
    });

    it('matches the upstream binary blob digest and size', () => {
        const bytes = Uint8Array.from([ 0, 1, 2, 127, 128, 255 ]).buffer;

        assertEqual('fxjwehnnbukzorm5dlx5tsgd7a', hashArrayBufferBlob(bytes));
        assertEqual(6, getBlobSize(bytes));
    });

    it('separates string and binary blob domains', () => {
        const string = 'hello';
        const bytes = new TextEncoder().encode(string).buffer;

        assert(hashStringBlob(string) !== hashArrayBufferBlob(bytes));
    });

    it('rejects values that are not publishable blobs', () => {
        const stringError = catchError(() => hashStringBlob(new Uint8Array()));
        const binaryError = catchError(() => hashArrayBufferBlob(new Uint8Array()));
        const sizeError = catchError(() => getBlobSize(new Uint8Array()));

        assertEqual('TypeError', stringError.name);
        assertEqual('TypeError', binaryError.name);
        assertEqual('TypeError', sizeError.name);
    });
});

function catchError(fn) {
    try {
        fn();
    } catch (error) {
        return error;
    }
    return null;
}
