import type { Stats } from 'node:fs';

export interface File {
  name: string;
  stat: Stats | undefined;
}

export interface RenderContext {
  queryString: string;
  viewName: string;
}

export type TemplatePartName = 'directory' | 'files' | 'host' | 'linked-path' | 'nonce' | 'style';

export type TemplatePart = { type: 'text'; value: string } | { type: 'placeholder'; value: TemplatePartName };

export interface Locals {
  directory: string;
  fileList: File[];
  host: string;
  nonce: string;
  path: string;
  renderContext: RenderContext;
  style: string;
}

export const validViewNames = ['tiles', 'details'] as const;

export type ViewName = (typeof validViewNames)[number];

export const defaultViewName: ViewName = 'tiles';

export const isValidViewName = (value: string): value is ViewName => (validViewNames as readonly string[]).includes(value);

export type ServeIndexPreset = 'express' | 'nginx' | 'apache';

export type PresetRenderer = (files: File[], directory: string, context: RenderContext) => Iterable<string> | string;

export interface PresetModule {
  renderFileList: PresetRenderer;
  sortFiles?: (files: File[], queryString: string) => File[];
}

export type TemplateRenderer = (locals: Locals) => PromiseLike<string> | string;

export type ServeIndexFilter = (...args: [filename: string, index: number, files: string[], dir: string]) => boolean;

export interface ServeIndexOptions {
  filter?: ServeIndexFilter | undefined;
  hidden?: boolean | undefined;
  rewriteRequestPath?: (path: string) => string | undefined;
  preset?: ServeIndexPreset | undefined;
  stylesheet?: string | undefined;
  template?: string | TemplateRenderer | undefined;
  view?: string | undefined;
}

export interface ResolvedTemplate {
  render: (files: File[], directory: string, locals: Locals) => Response | Promise<Response>;
  sortFiles?: (files: File[], queryString: string) => File[];
  stylesheetContent: string;
}
