export function shouldAutoActivateCatalog(
  activeCatalogUri: string | undefined,
  candidateUri: string,
  ignoredCatalogUri: string | undefined,
): boolean {
  if (candidateUri === ignoredCatalogUri) {
    return false;
  }
  return activeCatalogUri === undefined || activeCatalogUri === candidateUri;
}

export function chooseCatalogToRestore(
  workspaceCatalogUri: string | undefined,
  lastCatalogUri: string | undefined,
  hasWorkspace: boolean,
  activeEditorUri: string | undefined,
  openCatalogUris: readonly string[],
): string | undefined {
  if (workspaceCatalogUri !== undefined) {
    return workspaceCatalogUri;
  }
  if (!hasWorkspace && lastCatalogUri !== undefined) {
    return lastCatalogUri;
  }
  return activeEditorUri ?? openCatalogUris[0];
}
