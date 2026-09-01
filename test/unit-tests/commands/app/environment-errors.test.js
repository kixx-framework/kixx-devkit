import { assertEqual, assertMatches } from 'kixx-assert';
import { describe } from 'kixx-test';

import AppAssignBuildCommand from '../../../../commands/app/assign-build.js';
import AppCreateReleaseCommand from '../../../../commands/app/create-release.js';
import AppPublishCommand from '../../../../commands/app/publish.js';
import AppRollbackCommand from '../../../../commands/app/rollback.js';

describe('app command environment errors', ({ it }) => {
    for (const [ name, Command ] of [
        [ 'assign-build', AppAssignBuildCommand ],
        [ 'create-release', AppCreateReleaseCommand ],
        [ 'publish', AppPublishCommand ],
        [ 'rollback', AppRollbackCommand ],
    ]) {
        it(`${ name } requires --environment before doing work`, async () => {
            const command = new Command({ config: {}, secrets: {} });
            const caught = await catchAsyncError(() => command.run({}));

            assertEqual('UsageError', caught.name);
            assertMatches('--environment', caught.message);
        });
    }
});

async function catchAsyncError(fn) {
    try {
        await fn();
    } catch (error) {
        return error;
    }
    throw new Error('Expected an error');
}
