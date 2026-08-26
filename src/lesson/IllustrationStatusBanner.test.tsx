import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IllustrationPartialPreview, IllustrationStatusBanner } from './IllustrationStatusBanner';

describe('IllustrationStatusBanner', () => {
  it('keeps the last board visible and announces preparation without a blank', () => {
    const { rerender } = render(<IllustrationStatusBanner illustration={null} />);
    expect(screen.queryByTestId('illustration-status')).toBeNull();

    rerender(<IllustrationStatusBanner illustration={{ status: 'preparing', alt: 'A pond habitat' }} />);
    expect(screen.getByTestId('illustration-status').textContent).toContain('Preparing illustration');
    expect(screen.getByTestId('illustration-status').textContent).toContain('A pond habitat');

    rerender(<IllustrationStatusBanner illustration={{ status: 'ready' }} />);
    expect(screen.queryByTestId('illustration-status')).toBeNull();
  });

  it('shows a contained partial preview only while streaming', () => {
    const { rerender } = render(
      <IllustrationPartialPreview illustration={{ status: 'preparing' }} />,
    );
    expect(screen.queryByTestId('illustration-partial')).toBeNull();

    rerender(
      <IllustrationPartialPreview
        illustration={{ status: 'partial', alt: 'A pond habitat', partialDataUrl: 'data:image/png;base64,AAAA' }}
      />,
    );
    const preview = screen.getByTestId('illustration-partial');
    expect(preview.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(preview.getAttribute('alt')).toBe('A pond habitat');
  });
});
