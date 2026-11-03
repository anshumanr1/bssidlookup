import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { SearchError } from '@/types';
import {
  ipRequestCounts,
  blockedIPs,
  RATE_LIMIT_CONFIG,
  isIPBlocked,
  cleanupExpiredData,
  getClientIp,
  validateOrigin
} from './lib/rate-limit';

// First line of defense for all API routes. The routes themselves run the same
// checks via guardRequest as a second layer; the two run in separate runtime
// instances and do not share counter state.
// Team password gate (HTTP Basic Auth). Any username; the password comes from
// the SITE_PASSWORD environment variable. Fails closed if it is not set.
function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function passwordGate(request: NextRequest): NextResponse | null {
  const expected = process.env.SITE_PASSWORD;
  if (!expected) {
    return new NextResponse('Access is not configured yet (SITE_PASSWORD is not set).', { status: 503 });
  }
  const header = request.headers.get('authorization') || '';
  if (header.startsWith('Basic ')) {
    try {
      const decoded = atob(header.slice(6));
      const password = decoded.slice(decoded.indexOf(':') + 1);
      if (safeEqual(password, expected)) return null;
    } catch {
      // fall through to the challenge
    }
  }
  return new NextResponse('Password required.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="BSSID Locator", charset="UTF-8"' },
  });
}

export function proxy(request: NextRequest) {
  const denied = passwordGate(request);
  if (denied) return denied;

  // The checks below apply to API routes only
  if (!request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.next();
  }

  const ip = getClientIp(request);
  const now = Date.now();
  const userAgent = request.headers.get('user-agent') || '';

  // Log suspicious user agents but don't block on them (to avoid false positives)
  const suspiciousPatterns = [
    /bot|crawler|spider|scraper|curl|wget|python-requests|postman/i,
    /^$/ // Empty user agent
  ];
  if (suspiciousPatterns.some(pattern => pattern.test(userAgent))) {
    console.log(`[Suspicious UA] IP ${ip} - ${request.method} ${request.nextUrl.pathname} - User-Agent: ${userAgent}`);
  }

  // Browser-only policy: the request must originate from a page served by this
  // same host (production domain, preview deployment, or localhost dev)
  if (!validateOrigin(request)) {
    console.log(`[Invalid Origin] Blocked IP ${ip} - ${request.method} ${request.nextUrl.pathname} - Origin: ${request.headers.get('origin') || 'none'} - Referer: ${request.headers.get('referer') || 'none'}`);
    const error: SearchError = {
      type: 'INVALID_REQUEST',
      message: 'This API only accepts requests from the WaveDigger web app.'
    };
    return NextResponse.json({ error }, { status: 403 });
  }

  // Cleanup expired data periodically
  if (Math.random() < 0.01) { // 1% chance to cleanup
    cleanupExpiredData();
  }

  // Check if IP is blocked
  if (isIPBlocked(ip)) {
    console.log(`[Blocked IP] ${ip} attempted to access ${request.nextUrl.pathname}`);
    const blockExpiry = blockedIPs.get(ip) ?? now;
    const error: SearchError = {
      type: 'RATE_LIMITED',
      message: 'Too many failed requests. This is a temporary block; please try again later.'
    };
    return NextResponse.json(
      { error },
      { status: 429, headers: { 'Retry-After': String(Math.max(1, Math.ceil((blockExpiry - now) / 1000))) } }
    );
  }

  // Get or create request count data for this IP
  let ipData = ipRequestCounts.get(ip);
  if (!ipData || ipData.resetTime < now) {
    ipData = {
      count: 0,
      resetTime: now + RATE_LIMIT_CONFIG.RATE_LIMIT_WINDOW,
      errors404: 0
    };
    ipRequestCounts.set(ip, ipData);
  }

  // Increment request count
  ipData.count++;

  // Check rate limit
  if (ipData.count > RATE_LIMIT_CONFIG.MAX_REQUESTS_PER_WINDOW) {
    console.log(`[Rate Limit] IP ${ip} exceeded limit: ${ipData.count} requests`);
    const error: SearchError = {
      type: 'RATE_LIMITED',
      message: 'Too many requests. Please wait a moment and try again.'
    };
    return NextResponse.json(
      { error },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil((ipData.resetTime - now) / 1000)),
          'X-RateLimit-Limit': String(RATE_LIMIT_CONFIG.MAX_REQUESTS_PER_WINDOW),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(ipData.resetTime)
        }
      }
    );
  }

  const response = NextResponse.next();

  // Add rate limit headers to response
  response.headers.set('X-RateLimit-Limit', String(RATE_LIMIT_CONFIG.MAX_REQUESTS_PER_WINDOW));
  response.headers.set('X-RateLimit-Remaining', String(RATE_LIMIT_CONFIG.MAX_REQUESTS_PER_WINDOW - ipData.count));
  response.headers.set('X-RateLimit-Reset', String(ipData.resetTime));

  // Security headers for API routes. No Access-Control-Allow-Origin headers:
  // cross-origin browser callers are rejected by policy, and same-origin
  // requests do not need CORS
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

  return response;
}

export const config = {
  // Every path except Next.js build assets, so the whole site sits behind the password
  matcher: [
    '/((?!_next/static|_next/image).*)',
  ],
};
