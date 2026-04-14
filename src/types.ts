import type { Stats } from 'node:fs';

export interface File {
  name: string;
  stat: Stats | undefined;
}

export type TemplateAssetUrlBuilder = (assetPath: string) => string;
export type PresetFileFilter = (files: File[]) => File[];

export interface RenderContext {
  contentSecurityPolicy?: string | undefined;
  queryString: string;
  templateAssetUrl: TemplateAssetUrlBuilder;
  viewName: string;
}

export type TemplatePartName = 'directory' | 'files' | 'host' | 'linked-path' | 'nonce' | 'signature' | 'style';

export type TemplatePart = { type: 'text'; value: string } | { type: 'placeholder'; value: TemplatePartName };

export interface Locals {
  directory: string;
  fileList: File[];
  host: string;
  nonce: string;
  path: string;
  renderContext: RenderContext;
  signature: string;
  style: string;
  templateAssetUrl: TemplateAssetUrlBuilder;
}

export const validViewNames = ['tiles', 'details'] as const;

export type ViewName = (typeof validViewNames)[number];

export const defaultViewName: ViewName = 'tiles';

export const isValidViewName = (value: string): value is ViewName => (validViewNames as readonly string[]).includes(value);

export type ServeIndexPreset = 'express' | 'nginx' | 'apache';

export type PresetRenderer = (files: File[], directory: string, context: RenderContext) => Iterable<string> | string;

export interface PresetModule {
  filterFiles?: PresetFileFilter;
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
  contentSecurityPolicy?: string | undefined;
  filterFiles?: PresetFileFilter;
  render: (files: File[], directory: string, locals: Locals) => Response | Promise<Response>;
  resolveAsset: (assetPath: string) => Promise<ResolvedTemplateAsset | undefined>;
  sortFiles?: (files: File[], queryString: string) => File[];
  stylesheetContent: string;
}

export interface ResolvedTemplateAsset {
  filePath: string;
  stats: Stats;
}
