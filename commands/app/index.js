import AppAssignBuildCommand from './assign-build.js';
import AppCreateReleaseCommand from './create-release.js';
import AppPublishCommand from './publish.js';
import AppRollbackCommand from './rollback.js';


export const description = 'Publish application content';

export const subcommands = {
    'assign-build': AppAssignBuildCommand,
    'create-release': AppCreateReleaseCommand,
    publish: AppPublishCommand,
    rollback: AppRollbackCommand,
};
