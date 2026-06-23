/** 简易扩展名 → MIME 表（替代 `mime-types` 三方库，避免新增 dep）。
 *
 *  ref `mime-types.lookup` 自身也是查 mime-db.json；这里只挑 workspace 工具
 *  最常碰到的类型即可，其余统一兜底 application/octet-stream（→ binary file
 *  variant）。 */

const TABLE: Record<string, string> = {
  // text
  txt: "text/plain",
  md: "text/markdown",
  mdx: "text/markdown",
  json: "application/json",
  jsonc: "application/json",
  yaml: "text/yaml",
  yml: "text/yaml",
  toml: "application/toml",
  xml: "application/xml",
  csv: "text/csv",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  scss: "text/scss",
  js: "application/javascript",
  cjs: "application/javascript",
  mjs: "application/javascript",
  ts: "application/typescript",
  tsx: "application/typescript",
  jsx: "application/javascript",
  py: "text/x-python",
  rb: "text/x-ruby",
  go: "text/x-go",
  rs: "text/x-rust",
  java: "text/x-java",
  c: "text/x-c",
  cc: "text/x-c++",
  cpp: "text/x-c++",
  h: "text/x-c",
  hpp: "text/x-c++",
  sh: "application/x-sh",
  bash: "application/x-sh",
  zsh: "application/x-sh",
  fish: "application/x-sh",
  sql: "application/sql",
  log: "text/plain",
  // image
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  // audio
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  // video
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  // common docs / archives
  pdf: "application/pdf",
  zip: "application/zip",
  tar: "application/x-tar",
  gz: "application/gzip",
  bz2: "application/x-bzip2",
};

export function mimeLookup(path: string): string | false {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  const ext = path.slice(dot + 1).toLowerCase();
  return TABLE[ext] ?? false;
}
