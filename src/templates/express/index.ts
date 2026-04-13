import { fileEntryHref, formatFileDate } from '../../template-helpers.js';
import type { File, RenderContext } from '../../types.js';
import { escapeHtml } from '../../utils.js';

export const renderFileList = function* renderFileList(files: File[], directory: string, context: RenderContext): Generator<string> {
  const header =
    context.viewName === 'details'
      ? '<li class="header"><span class="name">Name</span><span class="size">Size</span><span class="date">Modified</span></li>'
      : '';

  yield `<ul id="files" class="view-${escapeHtml(context.viewName || 'tiles')}">${header}`;

  for (const file of files) {
    const href = fileEntryHref(file, directory);
    yield [
      `<li><a href="${href}" title="${escapeHtml(file.name)}">`,
      `<span class="name">${escapeHtml(file.name)}</span>`,
      `<span class="size">${escapeHtml(file.stat && !file.stat.isDirectory() ? file.stat.size.toString() : '')}</span>`,
      `<span class="date">${escapeHtml(formatFileDate(file, true))}</span>`,
      '</a></li>',
    ].join('');
  }

  yield '</ul>';
};
