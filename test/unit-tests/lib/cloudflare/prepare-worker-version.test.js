import { assertEqual } from 'kixx-assert';
import { describe } from 'kixx-test';
import prepareWorkerVersion, {
    prepareWorkerVersion as namedPrepareWorkerVersion,
} from '../../../../lib/cloudflare/prepare-worker-version.js';

describe('prepare-worker-version', ({ it }) => {
    it('exposes the shared preparation operation as default and named exports', () => {
        assertEqual(prepareWorkerVersion, namedPrepareWorkerVersion);
    });
});
