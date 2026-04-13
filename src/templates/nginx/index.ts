import type { File, RenderContext } from '../../types.js';
import { escapeHtml } from '../../utils.js';

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const fileDate = (file: File): string => {
  if (!file.stat || file.name === '..') {
    return '';
  }

  const date = file.stat.mtime;
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${day}-${months[date.getMonth()]}-${date.getFullYear()} ${hour}:${minute}`;
};

export const renderFileList = function* renderFileList(files: File[], _directory: string, _context: RenderContext): Generator<string> {
  for (const [index, file] of files.entries()) {
    const name = escapeHtml(file.name) + (file.stat?.isDirectory() ? '/' : '');

    if (index > 0) {
      yield '\n';
    }

    if (file.name === '..') {
      yield `<a href="../">${name}</a>`;
    } else {
      const href = escapeHtml(encodeURIComponent(file.name) + (file.stat?.isDirectory() ? '/' : ''));
      const date = fileDate(file);
      const size = file.stat && !file.stat.isDirectory() ? file.stat.size.toString() : '-';
      yield `<a href="${href}">${name}</a>${' '.repeat(Math.max(1, 51 - name.length))}${date}${' '.repeat(Math.max(1, 20 - size.length))}${size}`;
    }
  }
};
