import { describe } from 'kixx-test';
import { assert, assertEqual } from 'kixx-assert';
import {
    compareSecretNames,
    isSecretBinding,
    readSecretBindingNames,
} from '../../../../lib/cloudflare/worker-secret-names.js';


describe('worker-secret-names', ({ describe }) => {

    describe('isSecretBinding()', ({ it }) => {
        it('accepts secret_text and secret_key bindings only', () => {
            assertEqual(true, isSecretBinding({ type: 'secret_text', name: 'A' }));
            assertEqual(true, isSecretBinding({ type: 'secret_key', name: 'B' }));
            assertEqual(false, isSecretBinding({ type: 'plain_text', name: 'C', text: 'visible' }));
            assertEqual(false, isSecretBinding({ type: 'inherit', name: 'D' }));
            assertEqual(false, isSecretBinding(null));
        });
    });

    describe('readSecretBindingNames()', ({ it }) => {
        it('returns sorted unique secret binding names, ignoring other binding types', () => {
            const names = readSecretBindingNames({
                id: 'version-id',
                bindings: [
                    { type: 'secret_text', name: 'ZETA' },
                    { type: 'plain_text', name: 'PLAIN', text: 'visible' },
                    { type: 'secret_key', name: 'ALPHA' },
                    { type: 'secret_text', name: 'ZETA' },
                ],
            });

            assertEqual('ALPHA,ZETA', names.join(','));
        });

        it('throws naming the version when the bindings list is absent', () => {
            let caught = null;
            try {
                readSecretBindingNames({ id: 'version-id' });
            } catch (error) {
                caught = error;
            }

            assert(caught, 'expected an error to be thrown');
            assert(caught.message.includes('version-id'), 'expected the version ID');
            assert(caught.message.includes('without a bindings list'), 'expected the missing list explanation');
        });
    });

    describe('compareSecretNames()', ({ it }) => {
        it('reports declared names missing remotely and remote names not declared, each sorted', () => {
            const { missing, undeclared } = compareSecretNames({
                declaredNames: [ 'SHARED', 'ZETA_NEW', 'ALPHA_NEW' ],
                remoteNames: [ 'ZETA_OLD', 'SHARED', 'ALPHA_OLD' ],
            });

            assertEqual('ALPHA_NEW,ZETA_NEW', missing.join(','));
            assertEqual('ALPHA_OLD,ZETA_OLD', undeclared.join(','));
        });
    });
});
