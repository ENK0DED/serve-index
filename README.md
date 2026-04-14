# `@enk0ded/serve-index`

Filesystem-backed directory listings and static file responses for Hono.

It is designed for Node.js and Bun servers that need a drop-in directory index with sane defaults: HTML, plain text, or JSON listings; built-in `express`, `nginx`, and `apache` style presets; file streaming with cache validators and byte ranges; and strict path, symlink, and hidden-file handling.

## Highlights

- ESM-only Hono middleware with bundled TypeScript types
- HTML, `text/plain`, and `application/json` directory listings
- Built-in presets for `express`, `nginx`, and `apache`
- `index.html` and `index.htm` precedence before rendering a listing
- File responses with `ETag`, `Last-Modified`, `Accept-Ranges`, and `HEAD` support
- Single byte-range requests for files and index files
- Canonical trailing-slash redirects for directories
- Directory traversal, symlink escape, and hidden-path protection by default
- Request path rewriting for mounted routes like `/assets/*`

## Requirements

- Node.js `>=20.0.0`
- Bun `>=1.2.0`
- A Hono server runtime with filesystem access

This package uses the local filesystem, so it is intended for server runtimes, not edge-only deployments.

## Install

```bash
bun add @enk0ded/serve-index hono
```

```bash
npm install @enk0ded/serve-index hono
```

```bash
pnpm add @enk0ded/serve-index hono
```

## Quick Start

```ts
import { Hono } from 'hono';
import { serveIndex } from '@enk0ded/serve-index';

const app = new Hono();

app.use(
  '/assets/*',
  serveIndex('./public', {
    preset: 'apache',
    rewriteRequestPath: (pathname) => pathname.replace(/^\/assets/, '') || '/',
  }),
);
```

With the example above:

- `GET /assets/` renders a directory listing for `./public`
- `GET /assets/file.txt` streams the file if it exists
- `GET /assets/nested` redirects to `/assets/nested/`
- `GET /assets/nested/` serves `index.html` or `index.htm` first, then falls back to a listing

## How Content Is Chosen

- `Accept: text/html` renders an HTML listing
- `Accept: text/plain` returns one entry per line
- `Accept: application/json` returns an array of filenames
- Unsupported or missing `Accept` headers fall back to HTML

Only `GET`, `HEAD`, and `OPTIONS` are handled by the middleware. Other methods fall through to later middleware or routes.

## API

### `serveIndex(root, options?)`

Creates a Hono middleware that serves files and directory listings from `root`.

- `root`: Filesystem path to the directory you want to expose
- `options`: Optional behavior and rendering overrides

### `ServeIndexOptions`

| Option               | Type                                              | Default     | Description                                                                                             |
| -------------------- | ------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------- |
| `preset`             | `'express' \| 'nginx' \| 'apache'`                | `'express'` | Built-in HTML renderer preset.                                                                          |
| `hidden`             | `boolean`                                         | `false`     | When `true`, dotfiles and hidden directories can be listed and fetched directly.                        |
| `filter`             | `(filename, index, files, dir) => boolean`        | `undefined` | Filters directory entries before they are rendered or returned.                                         |
| `rewriteRequestPath` | `(pathname) => string \| undefined`               | `undefined` | Rewrites the request pathname before it is resolved under `root`. Useful for mounted routes.            |
| `stylesheet`         | `string`                                          | `undefined` | Path to a CSS file to inject into HTML listings.                                                        |
| `template`           | `string \| (locals) => string \| Promise<string>` | `undefined` | Either a path to an HTML template file or a function that returns the full HTML response body.          |
| `view`               | `string`                                          | `'tiles'`   | View hint passed to templates that support multiple layouts. Unsupported values fall back to `'tiles'`. |

## Mounting Patterns

### Mounted under a prefix

```ts
app.use(
  '/downloads/*',
  serveIndex('./downloads', {
    rewriteRequestPath: (pathname) => pathname.replace(/^\/downloads/, '') || '/',
  }),
);
```

### Exposing a directory at the app root

```ts
app.use('*', serveIndex('./public'));
```

## HTML Presets

Three built-in HTML presets are available:

- `express`: matches the default Express `serve-index` listing with `tiles` and `details` views
- `nginx`: plain index-style output
- `apache`: Apache-style table with sortable query parameters

The `apache` preset supports sorting with query parameters like `?C=N&O=A` and `?C=S&O=D`.

## Custom Templates

You can customize HTML output in two ways.

### 1. Provide a template file

Set `template` to the path of an HTML file. The file can use these placeholders:

- `{directory}`
- `{files}`
- `{host}`
- `{linked-path}`
- `{nonce}`
- `{signature}`
- `{style}`

Example:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>{directory}</title>
    <style nonce="{nonce}">
      {style}
    </style>
  </head>
  <body>
    <h1>{linked-path}</h1>
    {files}
  </body>
</html>
```

### 2. Provide a template function

Set `template` to a function if you want full control over the HTML response body:

```ts
app.use(
  '/assets/*',
  serveIndex('./public', {
    rewriteRequestPath: (pathname) => pathname.replace(/^\/assets/, '') || '/',
    template: (locals) => `<!doctype html><html><body><p>Total entries: ${locals.fileList.length}</p></body></html>`,
  }),
);
```

Template functions receive:

- `locals.directory`
- `locals.fileList`
- `locals.host`
- `locals.nonce`
- `locals.path`
- `locals.renderContext`
- `locals.signature`
- `locals.style`
- `locals.templateAssetUrl(assetPath)`

`locals.templateAssetUrl()` returns a URL for preset-local static assets such as icons. During build, every non-TypeScript file under `src/templates/*` is copied into `dist/templates/*`, so preset assets continue to work after publishing.

Template functions return trusted HTML. If you include filenames, query values, or other user-controlled content, you are responsible for escaping it safely.

## File and Directory Behavior

### Directory requests

- Paths without a trailing slash are redirected to the canonical slash form
- `index.html` and `index.htm` are served before a listing is rendered
- Hidden entries are omitted by default
- `HEAD` directory requests short-circuit without enumerating the directory contents

### File requests

- Regular files are streamed
- File responses include `Content-Type`, `ETag`, `Last-Modified`, `Accept-Ranges`, and `X-Content-Type-Options: nosniff`
- Single byte-range requests are supported
- Multi-range requests are ignored and return the full file instead
- Non-regular filesystem entries such as FIFOs are rejected instead of streamed
- MIME types outside a safe allowlist are served with `Content-Disposition: attachment`

### Missing paths

- Missing files and directories fall through to downstream middleware or the app's default 404 handling

## Security Notes

- Requests that resolve outside the configured root are rejected
- Symlinks are resolved and blocked if they escape the root
- Hidden paths and symlink aliases to hidden targets are blocked unless `hidden: true` is enabled
- HTML listings send a nonce-based Content Security Policy
- Directory listings are returned with `Cache-Control: no-cache`

## Advanced Exports

The package also exports template helpers for advanced use cases:

- `compileTemplate()`
- `isTemplatePartName()`
- `templatePlaceholderPattern`

Most users only need `serveIndex()`.

## Development

```bash
bun install
bun run check
```

Useful scripts:

- `bun run test`
- `bun run lint`
- `bun run fmt`
- `bun run build`
- `bun run bench:html`

## Publishing

The first npm release must be published manually by a package owner so the package exists on npm.

After that, add `.github/workflows/publish.yml` as a trusted publisher in the npm package settings for `@enk0ded/serve-index`.

Once trusted publishing is configured, pushing a tag that matches `package.json` such as `v1.2.3` will run the publish workflow and produce provenance.
