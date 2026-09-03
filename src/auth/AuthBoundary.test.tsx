import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthBoundary } from './AuthBoundary';

afterEach(() => vi.restoreAllMocks());

describe('AuthBoundary', () => {
  it('shows an accessible login and releases the private application after authentication', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ required: true, authenticated: false }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ authenticated: true, email: 'demo@example.test' }), { status: 200 }));

    render(<AuthBoundary><div>Private application</div></AuthBoundary>);

    const email = await screen.findByLabelText('Email address');
    const password = screen.getByLabelText('Password');
    expect(email.getAttribute('autocomplete')).toBe('username');
    expect(password.getAttribute('autocomplete')).toBe('current-password');
    fireEvent.change(email, { target: { value: 'demo@example.test' } });
    fireEvent.change(password, { target: { value: 'correct password' } });
    fireEvent.submit(screen.getByTestId('login-form'));

    expect(await screen.findByText('Private application')).not.toBeNull();
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/auth/login', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
    }));
  });

  it('keeps the login visible with a generic invalid-credential error', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ required: true, authenticated: false }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'The email or password is incorrect.' }), { status: 401 }));

    render(<AuthBoundary><div>Private application</div></AuthBoundary>);
    fireEvent.change(await screen.findByLabelText('Email address'), { target: { value: 'wrong@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.submit(screen.getByTestId('login-form'));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('email or password is incorrect'));
    expect(screen.queryByText('Private application')).toBeNull();
  });
});
