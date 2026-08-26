import type { IllustrationStatus } from './realtimeSession';

export function IllustrationStatusBanner({
  illustration,
}: {
  illustration: IllustrationStatus | null;
}) {
  if (!illustration || illustration.status === 'ready') return null;
  const label = illustration.status === 'preparing'
    ? 'Preparing illustration'
    : illustration.status === 'partial'
      ? 'Preparing illustration'
      : 'The illustration could not be prepared';
  return (
    <div className="lesson__illustration-status" data-testid="illustration-status" role="status" aria-live="polite">
      <strong>{label}</strong>
      {illustration.alt ? <span>{illustration.alt}</span> : null}
    </div>
  );
}

export function IllustrationPartialPreview({
  illustration,
}: {
  illustration: IllustrationStatus | null;
}) {
  if (illustration?.status !== 'partial' || !illustration.partialDataUrl) return null;
  return (
    <img
      className="lesson__illustration-partial"
      src={illustration.partialDataUrl}
      alt={illustration.alt ?? 'Preparing illustration'}
      data-testid="illustration-partial"
    />
  );
}
