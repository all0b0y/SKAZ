/**
 * A file path that keeps its end visible: long paths are cut at the start ("…/Documents/SKAZ"),
 * the full path is in the tooltip and stays selectable.
 */
export function PathText({ path, testId }: { path: string; testId?: string }) {
  return (
    <span className="kb-mono kb-path" title={path} data-testid={testId}>
      <bdi dir="ltr">{path}</bdi>
    </span>
  );
}
