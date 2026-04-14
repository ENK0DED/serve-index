import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveContainedPath } from './path-security.js';
import type {
  Locals,
  PresetModule,
  PresetRenderer,
  ResolvedTemplate,
  ResolvedTemplateAsset,
  ServeIndexOptions,
  ServeIndexPreset,
  TemplatePart,
  TemplatePartName,
} from './types.js';
import { escapeHtml, getErrorCode } from './utils.js';

const currentModuleDirectory = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
const templatePlaceholderPattern = /\{(directory|files|host|linked-path|nonce|signature|style)\}/g;
const textEncoder = new TextEncoder();

const base64Pattern = /^[A-Za-z0-9+/=]+$/;
const templateAssetQueryKey = '__serve_index_asset';
const disallowedTemplateAssetExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.map']);

const generateNonce = (): string => {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);

  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

const assertValidNonce = (nonce: string): void => {
  if (!base64Pattern.test(nonce)) {
    throw new Error('Invalid nonce: must be base64');
  }
};

const buildCspValue = (nonce: string): string => {
  assertValidNonce(nonce);
  return `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src 'self'`;
};

const expressStyleCspValue = `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:`;

const normalizeTemplateAssetPath = (assetPath: string): string | undefined => {
  const trimmedPath = assetPath.replaceAll('\\', '/').replace(/^\/+/, '');
  if (!trimmedPath) {
    return undefined;
  }

  const normalizedPath = path.posix.normalize(trimmedPath);
  if (normalizedPath === '.' || normalizedPath === '..' || normalizedPath.startsWith('../')) {
    return undefined;
  }

  return normalizedPath;
};

const isDisallowedTemplateAssetPath = (assetPath: string): boolean => {
  const basename = path.posix.basename(assetPath).toLowerCase();
  return basename.endsWith('.d.ts') || disallowedTemplateAssetExtensions.has(path.posix.extname(basename));
};

const createTemplateAssetUrl = (assetPath: string, assetBasePath = '/'): string => {
  const normalizedPath = normalizeTemplateAssetPath(assetPath);
  if (!normalizedPath) {
    throw new TypeError('Invalid template asset path');
  }

  const normalizedBasePath = assetBasePath.endsWith('/') ? assetBasePath : `${assetBasePath}/`;
  return `${normalizedBasePath}${normalizedPath}`.replace(/\/{2,}/g, '/');
};

const resolveTemplateAsset = async (templateDirectory: string, assetPath: string): Promise<ResolvedTemplateAsset | undefined> => {
  const normalizedPath = normalizeTemplateAssetPath(assetPath);
  if (!normalizedPath || isDisallowedTemplateAssetPath(normalizedPath)) {
    return undefined;
  }

  try {
    const resolvedPath = await resolveContainedPath(templateDirectory, path.join(templateDirectory, normalizedPath));
    const stats = await stat(resolvedPath);
    if (!stats.isFile()) {
      return undefined;
    }

    return { filePath: resolvedPath, stats };
  } catch (error) {
    const code = getErrorCode(error);
    if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR') {
      return undefined;
    }

    throw error;
  }
};

const isTemplatePartName = (value: string): value is TemplatePartName =>
  value === 'directory' || value === 'files' || value === 'host' || value === 'linked-path' || value === 'nonce' || value === 'signature' || value === 'style';

const presetLoaders: Record<ServeIndexPreset, () => Promise<PresetModule>> = {
  apache: async () => import('./templates/apache/index.js'),
  express: async () => import('./templates/express/index.js'),
  nginx: async () => import('./templates/nginx/index.js'),
};

const readOptionalTextFile = async (filePath: string) => {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      return '';
    }

    throw error;
  }
};

const compileTemplate = (templateContent: string): TemplatePart[] => {
  const templateParts: TemplatePart[] = [];
  let lastIndex = 0;

  for (const match of templateContent.matchAll(templatePlaceholderPattern)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > lastIndex) {
      templateParts.push({ type: 'text', value: templateContent.slice(lastIndex, matchIndex) });
    }

    const [, placeholder] = match;
    if (placeholder && isTemplatePartName(placeholder)) {
      templateParts.push({ type: 'placeholder', value: placeholder });
    }

    lastIndex = matchIndex + match[0].length;
  }

  if (lastIndex < templateContent.length) {
    templateParts.push({ type: 'text', value: templateContent.slice(lastIndex) });
  }

  return templateParts;
};

const htmlPath = (directory: string): string => {
  const parts = directory.split('/');
  const crumbs: (string | undefined)[] = Array.from({ length: parts.length });

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];

    if (part) {
      parts[i] = encodeURIComponent(part);
      crumbs[i] = `<a href="${escapeHtml(parts.slice(0, i + 1).join('/'))}">${escapeHtml(part)}</a>`;
    }
  }

  return crumbs.join(' / ');
};

const iterateMarkup = function* iterateMarkup(markup: ReturnType<PresetRenderer>) {
  if (typeof markup === 'string') {
    yield markup;
    return;
  }

  yield* markup;
};

const renderHtmlDocument = function* renderHtmlDocument(templateParts: TemplatePart[], filesMarkup: ReturnType<PresetRenderer>, locals: Locals) {
  const replacements = {
    directory: escapeHtml(locals.directory),
    files: filesMarkup,
    host: escapeHtml(locals.host),
    'linked-path': htmlPath(locals.directory),
    nonce: locals.nonce,
    signature: escapeHtml(locals.signature),
    style: locals.style,
  } as const;

  for (const part of templateParts) {
    if (part.type === 'text') {
      yield part.value;
    } else if (part.value === 'files') {
      yield* iterateMarkup(replacements.files);
    } else {
      yield replacements[part.value];
    }
  }
};

const createTextStream = (chunks: Iterable<string>): ReadableStream<Uint8Array> => {
  const iterator = chunks[Symbol.iterator]();
  let buf = new Uint8Array(4096);

  return new ReadableStream({
    pull(controller) {
      const { done, value } = iterator.next();
      if (done) {
        controller.close();
        return;
      }

      const needed = value.length * 3;
      if (buf.length < needed) {
        buf = new Uint8Array(needed);
      }

      const { written } = textEncoder.encodeInto(value, buf);
      controller.enqueue(buf.slice(0, written));
    },
  });
};

const buildHtmlListingHeaders = (nonce: string, contentSecurityPolicy = buildCspValue(nonce)) => ({
  'Cache-Control': 'no-cache',
  'Content-Security-Policy': contentSecurityPolicy,
  'Content-Type': 'text/html; charset=UTF-8',
  Vary: 'Accept',
  'X-Content-Type-Options': 'nosniff',
});

const createHtmlListingResponse = (templateParts: TemplatePart[], filesMarkup: ReturnType<PresetRenderer>, locals: Locals): Response =>
  new Response(createTextStream(renderHtmlDocument(templateParts, filesMarkup, locals)), {
    headers: buildHtmlListingHeaders(locals.nonce, locals.renderContext.contentSecurityPolicy),
    status: 200,
  });

const resolvePreset = async (preset: ServeIndexPreset, options: ServeIndexOptions): Promise<ResolvedTemplate> => {
  const dir = path.join(currentModuleDirectory, 'templates', preset);
  const mod = await presetLoaders[preset]();
  const stylesheetContent = options.stylesheet ? await readFile(options.stylesheet, 'utf8') : await readOptionalTextFile(path.join(dir, 'style.css'));
  const resolveAsset = async (assetPath: string) => resolveTemplateAsset(dir, assetPath);
  const contentSecurityPolicy = preset === 'express' ? expressStyleCspValue : undefined;

  if (typeof options.template === 'function') {
    const templateRenderer = options.template;
    return {
      contentSecurityPolicy,
      filterFiles: mod.filterFiles,
      render: async (_files, _directory, locals) =>
        new Response(await templateRenderer(locals), {
          headers: buildHtmlListingHeaders(locals.nonce, locals.renderContext.contentSecurityPolicy),
          status: 200,
        }),
      resolveAsset,
      sortFiles: mod.sortFiles,
      stylesheetContent,
    };
  }

  const templateContent = options.template ? await readFile(options.template, 'utf8') : await readFile(path.join(dir, 'directory.html'), 'utf8');
  const templateParts = compileTemplate(templateContent);
  return {
    contentSecurityPolicy,
    filterFiles: mod.filterFiles,
    render: (files, directory, locals) => createHtmlListingResponse(templateParts, mod.renderFileList(files, directory, locals.renderContext), locals),
    resolveAsset,
    sortFiles: mod.sortFiles,
    stylesheetContent,
  };
};

export {
  buildCspValue,
  compileTemplate,
  createHtmlListingResponse,
  createTemplateAssetUrl,
  generateNonce,
  htmlPath,
  isTemplatePartName,
  normalizeTemplateAssetPath,
  resolvePreset,
  templateAssetQueryKey,
  templatePlaceholderPattern,
};
