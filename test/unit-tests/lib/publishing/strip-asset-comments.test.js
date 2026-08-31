import { describe } from 'kixx-test';
import { assert, assertEqual } from 'kixx-assert';
import {
    stripCssComments,
    stripJavaScriptComments,
} from '../../../../lib/publishing/strip-asset-comments.js';


describe('publishing/strip-asset-comments', ({ it }) => {
    it('removes JavaScript line, block, and JSDoc comments outright', () => {
        const source = '// first\nconst value = /* middle */ 1;\n/** last */';

        assertEqual('\nconst value =  1;\n', stripJavaScriptComments(source));
    });

    it('preserves JavaScript hashbangs, strings, templates, and regular expressions', () => {
        const source = [
            '#!/usr/bin/env node',
            'const string = "// text";',
            'const template = `/* text */`;',
            'const expression = /\\/\\* text \\*\\//;',
            '// removed',
        ].join('\n');

        assertEqual(source.replace('// removed', ''), stripJavaScriptComments(source));
    });

    it('reports JavaScript parse failures with a source location', () => {
        const caught = catchError(() => stripJavaScriptComments('const = 1;'));

        assert(caught, 'expected a syntax error');
        assertEqual('SyntaxError', caught.name);
        assertEqual(1, caught.lineNumber);
        assertEqual(6, caught.column);
    });

    it('removes CSS comments outright', () => {
        const source = '/* first */a { color: red; /* second */ display: block; }';

        assertEqual('a { color: red;  display: block; }', stripCssComments(source));
    });

    it('preserves CSS comment-like text in strings and url values', () => {
        const source = [
            'a::before { content: "/* text */"; }',
            'a { background: url(images/*literal*/icon.svg); }',
            "b { background: URL('data:image/svg+xml;/*literal*/'); }",
            '/* removed */',
        ].join('\n');

        assertEqual(source.replace('/* removed */', ''), stripCssComments(source));
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
