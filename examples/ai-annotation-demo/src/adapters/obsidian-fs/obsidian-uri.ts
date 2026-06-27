export function buildObsidianOpenUri(input: {
  vault?: string;
  file?: string;
  absolutePath?: string;
  headingOrBlock?: string;
}): string {
  const params = new URLSearchParams();
  if (input.absolutePath) params.set('path', input.absolutePath);
  else {
    if (input.vault) params.set('vault', input.vault);
    if (input.file) params.set('file', input.headingOrBlock ? `${input.file}#${input.headingOrBlock}` : input.file);
  }
  return `obsidian://open?${params.toString()}`;
}
