import CloudflareBootstrapCommand from './bootstrap.js';
import CloudflareRecoverSecretVersionCommand from './recover-secret-version.js';
import CloudflareCreateWorkerCommand from './create-worker.js';
import CloudflareUpdateWorkerCommand from './update-worker.js';
import CloudflareCreateWorkerVersionCommand from './create-worker-version.js';
import CloudflareDeployVersionCommand from './deploy-version.js';
import CloudflareSetSecretCommand from './set-secret.js';
import CloudflareDeleteSecretCommand from './delete-secret.js';
import CloudflareSetSecretsCommand from './set-secrets.js';
import CloudflareReleaseCommand from './release.js';


export const description = 'Tools for working directly with Cloudflare';

export const subcommands = {
    bootstrap: CloudflareBootstrapCommand,
    'recover-secret-version': CloudflareRecoverSecretVersionCommand,
    'create-worker': CloudflareCreateWorkerCommand,
    'update-worker': CloudflareUpdateWorkerCommand,
    'create-worker-version': CloudflareCreateWorkerVersionCommand,
    'deploy-version': CloudflareDeployVersionCommand,
    'set-secret': CloudflareSetSecretCommand,
    'delete-secret': CloudflareDeleteSecretCommand,
    'set-secrets': CloudflareSetSecretsCommand,
    release: CloudflareReleaseCommand,
};
