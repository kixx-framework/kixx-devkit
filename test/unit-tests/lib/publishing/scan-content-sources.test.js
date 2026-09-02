import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe } from 'kixx-test';
import {
    assert,
    assertEqual,
    assertMatches,
} from 'kixx-assert';

import scanContentSources from '../../../../lib/publishing/scan-content-sources.js';


describe('publishing/scan-content-sources', ({ after, it }) => {
    const directories = [];

    after(async () => {
        await Promise.all(directories.map((directory) => {
            return fsp.rm(directory, { recursive: true, force: true });
        }));
    });

    it('materializes every content convention into deterministic resources', async () => {
        const directory = await makeProject(directories, {
            'pages/page.json': JSON.stringify({
                template: 'nested/page.html',
                partials: [
                    { id: 'z-last', filename: 'z.html' },
                    { id: 'a-first', filename: 'a.html' },
                ],
                includes: {
                    zeta: { filename: 'z-include.html' },
                    alpha: { filename: 'a-include.html' },
                },
                page: { title: 'Home' },
            }),
            'pages/nested/page.html': '<main>Home</main>',
            'pages/a.html': 'A partial',
            'pages/z.html': 'Z partial',
            'pages/a-include.html': 'A include',
            'pages/z-include.html': 'Z include',
            'pages/orphan.html': 'unmatched page file',
            'pages/blog/page.json': JSON.stringify({ template: '' }),
            'templates/partials/z.html': 'Z global',
            'templates/partials/nested/a.html': 'A global',
            'templates/base/default.html': '<html>{{ content }}</html>',
            'templates/README.md': 'unmatched template file',
            'static-assets/app.js': 'const text = "// literal"; // removed\nconst regex = /\\/\\*/;',
            'static-assets/site.css': 'a { content: "/* literal */"; } /* removed */',
            'static-assets/image.bin': Uint8Array.from([ 0, 127, 255 ]),
            'public/public-app.js': '// public comments stay\nconst publicFile = true;',
            'public/favicon.ico': Uint8Array.from([ 1, 2, 3 ]),
            'emails/welcome/email.json': JSON.stringify({
                htmlTemplate: { id: 'html', filename: 'message.html' },
                textTemplate: { id: 'text', filename: 'message.txt' },
                partials: [
                    { id: 'z-last', filename: 'z-partial.html' },
                    { id: 'a-first', filename: 'a-partial.html' },
                ],
                contextData: { greeting: 'Hello' },
            }),
            'emails/welcome/message.html': '<p>Hello</p>',
            'emails/welcome/message.txt': 'Hello',
            'emails/welcome/a-partial.html': 'A email partial',
            'emails/welcome/z-partial.html': 'Z email partial',
            'emails/welcome/notes.md': 'unmatched email file',
        });

        const result = await scanContentSources(directory);

        assertEqual(0, result.problems.length);
        assertEqual(
            'emails/welcome/notes.md,pages/orphan.html,templates/README.md',
            result.unmatchedFiles.join(','),
        );

        const metadata = findResource(result, 'PageMetadata', '/');
        assertEqual('Home', metadata.payload.page.title);
        assertResourceAddress(metadata);

        const template = findResource(result, 'PageTemplate', '/page.html');
        assertEqual('<main>Home</main>', template.payload);
        assertResourceAddress(template);

        const partials = findResource(result, 'PagePartials', '/');
        assertEqual('a-first,z-last', partials.payload.map(({ id }) => id).join(','));
        assertEqual('A partial', partials.payload[0].source);

        const includes = findResource(result, 'PageIncludes', '/');
        assertEqual('alpha,zeta', Object.keys(includes.payload).join(','));
        assertEqual('A include', includes.payload.alpha);

        const emptyPartials = findResource(result, 'PagePartials', '/blog');
        const emptyIncludes = findResource(result, 'PageIncludes', '/blog');
        assertEqual(0, emptyPartials.payload.length);
        assertEqual(0, Object.keys(emptyIncludes.payload).length);

        const globalPartials = findResource(result, 'GlobalTemplatePartials', '/');
        assertEqual(
            'nested/a.html,z.html',
            globalPartials.payload.map(({ id }) => id).join(','),
        );

        const baseTemplates = findResource(result, 'BaseTemplates', '/');
        assertEqual('default.html', baseTemplates.payload[0].id);

        const javaScript = findResource(result, 'StaticAsset', 'app.js');
        assertEqual(
            'const text = "// literal";  \nconst regex = /\\/\\*/;',
            decode(javaScript.payload),
        );

        const css = findResource(result, 'StaticAsset', 'site.css');
        assertEqual('a { content: "/* literal */"; } ', decode(css.payload));

        const publicJavaScript = findResource(result, 'StaticAsset', 'public-app.js');
        assertEqual('// public comments stay\nconst publicFile = true;', decode(publicJavaScript.payload));

        const binary = findResource(result, 'StaticAsset', 'image.bin');
        assertEqual('0,127,255', new Uint8Array(binary.payload).join(','));

        const email = findResource(result, 'EmailAssets', '/welcome');
        assertEqual('Hello', email.payload.contextData.greeting);
        assertEqual(0, Object.keys(email.payload.includes).length);
        assertEqual('html', email.payload.htmlTemplate.id);
        assertEqual('text', email.payload.textTemplate.id);
        assertEqual('a-first,z-last', email.payload.partials.map(({ id }) => id).join(','));
    });

    it('returns all mapping problems as data and keeps unmatched files separate', async () => {
        const directory = await makeProject(directories, {
            'pages/page.json': '{ invalid',
            'pages/orphan.txt': 'unmatched',
            'pages/missing/page.json': JSON.stringify({ template: 'absent.html' }),
            'pages/reserved/page.json': JSON.stringify({ template: 'page.json' }),
            'emails/broken/email.json': '[ invalid',
            'emails/extra.txt': 'unmatched',
            'templates/README.md': 'unmatched',
            'static-assets/Bad Name.txt': 'invalid pathname',
            'static-assets/empty.txt': '',
            'static-assets/comments-only.css': '/* removed to empty */',
            'static-assets/bad.js': 'const = 1;',
            'static-assets/shared.txt': 'static version',
            'public/shared.txt': 'public version',
        });

        const result = await scanContentSources(directory);
        const codes = result.problems.map(({ code }) => code);

        assertEqual(2, count(codes, 'malformed-json'));
        assertEqual(1, count(codes, 'missing-referenced-file'));
        assertEqual(1, count(codes, 'reserved-template-filename'));
        assertEqual(1, count(codes, 'invalid-pathname'));
        assertEqual(2, count(codes, 'empty-static-asset'));
        assertEqual(1, count(codes, 'invalid-javascript'));
        assertEqual(1, count(codes, 'static-asset-collision'));

        const javaScriptProblem = result.problems.find(({ code }) => code === 'invalid-javascript');
        assertEqual('static-assets/bad.js', javaScriptProblem.filepath);
        assertEqual(1, javaScriptProblem.line);

        assertEqual(
            'emails/extra.txt,pages/orphan.txt,templates/README.md',
            result.unmatchedFiles.join(','),
        );
    });

    it('returns manifest shape problems without throwing', async () => {
        const directory = await makeProject(directories, {
            'pages/page.json': JSON.stringify({
                template: 42,
                partials: [
                    { id: '', filename: 'partial.html' },
                    { id: 'same', filename: 'partial.html' },
                    { id: 'same', filename: 'partial.html' },
                ],
                includes: [],
            }),
            'pages/partial.html': 'partial',
            'emails/welcome/email.json': JSON.stringify({
                htmlTemplate: { id: '', filename: 'message.html' },
                partials: 'invalid',
            }),
            'emails/welcome/message.html': 'message',
        });

        const result = await scanContentSources(directory);

        assertEqual(6, count(result.problems.map(({ code }) => code), 'invalid-manifest'));
        assert(result.resources.some(({ type }) => type === 'PageMetadata'));
    });

    it('publishes empty page and existing template bundles deterministically', async () => {
        const directory = await makeProject(directories, {
            'pages/page.json': '{}',
        });
        await fsp.mkdir(path.join(directory, 'templates', 'partials'), { recursive: true });
        await fsp.mkdir(path.join(directory, 'templates', 'base'), { recursive: true });

        const first = await scanContentSources(directory);
        const second = await scanContentSources(directory);

        assertEqual(5, first.resources.length);
        assertEqual(
            first.resources.map(resourceIdentity).join(','),
            second.resources.map(resourceIdentity).join(','),
        );
    });
});

async function makeProject(directories, files) {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'kixx-publishing-'));
    directories.push(directory);

    for (const [ relativePath, contents ] of Object.entries(files)) {
        const filepath = path.join(directory, relativePath);
        await fsp.mkdir(path.dirname(filepath), { recursive: true });
        await fsp.writeFile(filepath, contents);
    }

    return directory;
}

function findResource(result, type, pathname, index = 0) {
    const matches = result.resources.filter((resource) => {
        return resource.type === type && resource.pathname === pathname;
    });

    assert(matches[index], `expected ${ type } at ${ pathname } index ${ index }`);
    return matches[index];
}

function assertResourceAddress(resource) {
    assertMatches(/^[a-z2-7]{26}$/, resource.hash);
    assert(resource.size > 0);
    assert(resource.sourceFiles.length > 0);
}

function decode(buffer) {
    return new TextDecoder().decode(buffer);
}

function count(values, expected) {
    return values.filter((value) => value === expected).length;
}

function resourceIdentity(resource) {
    return `${ resource.type }:${ resource.pathname }:${ resource.hash }:${ resource.size }`;
}
