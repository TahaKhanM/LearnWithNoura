// Vercel's product docs promise a bypass cookie but do not name it; current
// Vercel Labs agent-browser guidance identifies the cookie as `_vercel_jwt`.
const ALLOWED_BYPASS_COOKIE_NAMES = new Set(['_vercel_jwt']);
const FAILURE_MESSAGE = 'The Vercel protection bypass bootstrap failed.';
const MAX_SAME_ORIGIN_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function bootstrapVercelProtectionBypass(
  context,
  baseUrl,
  bypass,
  fetchImpl = globalThis.fetch,
) {
  if (typeof bypass !== 'string') return;

  try {
    const baseOrigin = baseUrl.origin;
    let currentUrl = baseUrl.href;
    let redirectCount = 0;
    const visitedUrls = new Set();

    while (true) {
      if (visitedUrls.has(currentUrl)) throw new Error();
      visitedUrls.add(currentUrl);

      const response = await fetchImpl(currentUrl, {
        headers: {
          'x-vercel-protection-bypass': bypass,
          'x-vercel-set-bypass-cookie': 'true',
        },
        redirect: 'manual',
      });

      const candidateCookie = extractBypassCookie(response.headers);

      if (REDIRECT_STATUSES.has(response.status)) {
        if (candidateCookie !== null) {
          await addBypassCookie(context, baseOrigin, candidateCookie);
          return;
        }
        if (redirectCount >= MAX_SAME_ORIGIN_REDIRECTS) throw new Error();
        const location = response.headers.get('location');
        if (typeof location !== 'string' || location.trim() === '') throw new Error();
        const nextUrl = new URL(location, currentUrl);
        if (nextUrl.origin !== baseOrigin) throw new Error();
        currentUrl = nextUrl.href;
        redirectCount += 1;
        continue;
      }

      if (response.status < 200 || response.status >= 300 || candidateCookie === null) {
        throw new Error();
      }

      await addBypassCookie(context, baseOrigin, candidateCookie);
      return;
    }
  } catch {
    throw new Error(FAILURE_MESSAGE);
  }
}

async function addBypassCookie(context, baseOrigin, bypassCookie) {
  await context.addCookies([{
    httpOnly: true,
    name: bypassCookie.name,
    sameSite: 'Lax',
    secure: true,
    value: bypassCookie.value,
    url: baseOrigin,
  }]);
}

function extractBypassCookie(headers) {
  const values = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie')].filter((value) => value !== null);
  if (!Array.isArray(values)) throw new Error();

  let bypassCookie = null;
  for (const value of values) {
    if (typeof value !== 'string') throw new Error();
    const pair = value.split(';', 1)[0];
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex <= 0) continue;
    const name = pair.slice(0, separatorIndex).trim();
    if (!ALLOWED_BYPASS_COOKIE_NAMES.has(name)) continue;
    const cookieValue = pair.slice(separatorIndex + 1);
    if (
      cookieValue.length === 0
      || !/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/.test(cookieValue)
      || bypassCookie !== null
    ) {
      throw new Error();
    }
    bypassCookie = { name, value: cookieValue };
  }
  return bypassCookie;
}
