import path from 'node:path';

import type { File, RenderContext } from '../../types.js';
import { escapeHtml } from '../../utils.js';

const normalizeSlashes = (value: string) => value.replaceAll(path.sep, '/');

export const renderFileList = function* renderFileList(files: File[], directory: string, context: RenderContext): Generator<string> {
  yield `<ul id="files" class="view-${escapeHtml(context.viewName)}">`;
  if (context.viewName === 'details') {
    yield '<li class="header"><span class="name">Name</span><span class="size">Size</span><span class="date">Modified</span></li>';
  }

  let first = true;

  for (const file of files) {
    if (!first) {
      yield '\n';
    }
    first = false;

    const hrefParts = directory.split('/').map((part) => encodeURIComponent(part));
    hrefParts.push(encodeURIComponent(file.name));
    const href = escapeHtml(normalizeSlashes(path.normalize(hrefParts.join('/'))));
    const date = file.stat && file.name !== '..' ? `${file.stat.mtime.toLocaleDateString()} ${file.stat.mtime.toLocaleTimeString()}` : '';
    const size = file.stat && !file.stat.isDirectory() ? file.stat.size.toString() : '';

    yield `<li><a href="${href}" class="" title="${escapeHtml(file.name)}"><span class="name">${escapeHtml(file.name)}</span><span class="size">${escapeHtml(size)}</span><span class="date">${escapeHtml(date)}</span></a></li>`;
  }

  yield '</ul>';
};
