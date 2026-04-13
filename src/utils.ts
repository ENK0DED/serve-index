const isRecord = (value: unknown): value is Record<PropertyKey, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

const getErrorCode = (error: unknown): string | undefined => {
  if (!isRecord(error)) {
    return undefined;
  }

  return typeof error.code === 'string' ? error.code : undefined;
};

const htmlEscapePattern = /["'&<>`]/;

const htmlEntityMap: Record<number, string> = {
  34: '&quot;',
  38: '&amp;',
  39: '&#39;',
  60: '&lt;',
  62: '&gt;',
  96: '&#96;',
};

const escapeHtml = (value: string): string => {
  const match = htmlEscapePattern.exec(value);
  if (!match) {
    return value;
  }

  let html = '';
  let lastIndex = 0;

  for (let i = match.index; i < value.length; i += 1) {
    const entity = htmlEntityMap[value.charCodeAt(i)];
    if (entity) {
      if (lastIndex !== i) {
        html += value.substring(lastIndex, i);
      }

      lastIndex = i + 1;
      html += entity;
    }
  }

  return lastIndex < value.length ? html + value.substring(lastIndex) : html;
};

export { escapeHtml, getErrorCode, isRecord };
