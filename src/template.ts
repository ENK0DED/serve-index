import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Locals, PresetModule, PresetRenderer, ResolvedTemplate, ServeIndexOptions, ServeIndexPreset, TemplatePart, TemplatePartName } from './types.js';
import { escapeHtml, getErrorCode } from './utils.js';

const currentModuleDirectory = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
const templatePlaceholderPattern = /\{(directory|files|host|linked-path|nonce|style)\}/g;
const textEncoder = new TextEncoder();

const base64Pattern = /^[A-Za-z0-9+/=]+$/;

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

const isTemplatePartName = (value: string): value is TemplatePartName =>
  value === 'directory' || value === 'files' || value === 'host' || value === 'linked-path' || value === 'nonce' || value === 'style';

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
  const crumbs: string[] = [];

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];

    if (part) {
      parts[i] = encodeURIComponent(part);
      crumbs.push(`<a href="${escapeHtml(parts.slice(0, i + 1).join('/'))}">${escapeHtml(part)}</a>`);
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

const buildHtmlListingHeaders = (nonce: string) => ({
  'Cache-Control': 'no-cache',
  'Content-Security-Policy': buildCspValue(nonce),
  'Content-Type': 'text/html; charset=UTF-8',
  Vary: 'Accept',
  'X-Content-Type-Options': 'nosniff',
});

const createHtmlListingResponse = (templateParts: TemplatePart[], filesMarkup: ReturnType<PresetRenderer>, locals: Locals): Response =>
  new Response(createTextStream(renderHtmlDocument(templateParts, filesMarkup, locals)), {
    headers: buildHtmlListingHeaders(locals.nonce),
    status: 200,
  });

const resolvePreset = async (preset: ServeIndexPreset, options: ServeIndexOptions): Promise<ResolvedTemplate> => {
  const dir = path.join(currentModuleDirectory, 'templates', preset);
  const mod = await presetLoaders[preset]();
  const stylesheetContent = options.stylesheet ? await readFile(options.stylesheet, 'utf8') : await readOptionalTextFile(path.join(dir, 'style.css'));

  if (typeof options.template === 'function') {
    const templateRenderer = options.template;
    return {
      render: async (_files, _directory, locals) =>
        new Response(await templateRenderer(locals), { headers: buildHtmlListingHeaders(locals.nonce), status: 200 }),
      sortFiles: mod.sortFiles,
      stylesheetContent,
    };
  }

  const templateContent = options.template ? await readFile(options.template, 'utf8') : await readFile(path.join(dir, 'directory.html'), 'utf8');
  const templateParts = compileTemplate(templateContent);
  return {
    render: (files, directory, locals) => createHtmlListingResponse(templateParts, mod.renderFileList(files, directory, locals.renderContext), locals),
    sortFiles: mod.sortFiles,
    stylesheetContent,
  };
};

export { buildCspValue, compileTemplate, createHtmlListingResponse, generateNonce, htmlPath, isTemplatePartName, resolvePreset, templatePlaceholderPattern };
