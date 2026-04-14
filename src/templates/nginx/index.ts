import type { File, RenderContext } from '../../types.js';
import { escapeHtml } from '../../utils.js';

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const maxDisplayNameLength = 50;
const displayNamePaddingWidth = 51;
const sizePaddingWidth = 20;

const truncateDisplayName = (name: string): string => {
  if (name.length <= maxDisplayNameLength) {
    return name;
  }

  return `${name.slice(0, maxDisplayNameLength - 3)}..>`;
};

const fileDate = (file: File): string => {
  if (!file.stat || file.name === '..') {
    return '';
  }

  // Nginx autoindex uses UTC unless autoindex_localtime is enabled.
  const date = file.stat.mtime;
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  return `${day}-${months[date.getUTCMonth()]}-${date.getUTCFullYear()} ${hour}:${minute}`;
};

export const renderFileList = function* renderFileList(files: File[], _directory: string, _context: RenderContext): Generator<string> {
  yield '<a href="../">../</a>';

  for (const file of files) {
    if (file.name !== '..') {
      const fullName = file.name + (file.stat?.isDirectory() ? '/' : '');
      const displayName = truncateDisplayName(fullName);
      const href = escapeHtml(encodeURIComponent(file.name) + (file.stat?.isDirectory() ? '/' : ''));
      const date = fileDate(file);
      const size = file.stat && !file.stat.isDirectory() ? file.stat.size.toString() : '-';

      yield '\r\n';
      yield `<a href="${href}">${escapeHtml(displayName)}</a>${' '.repeat(Math.max(1, displayNamePaddingWidth - displayName.length))}${date}${' '.repeat(Math.max(1, sizePaddingWidth - size.length))}${size}`;
    }
  }
};
