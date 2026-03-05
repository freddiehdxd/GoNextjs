import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/** Routes that don't require authentication */
const PUBLIC_PATHS = ['/login', '/api/'];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Allow static assets and Next.js internals
  if (
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/favicon') ||
    pathname.endsWith('.ico') ||
    pathname.endsWith('.svg')
  ) {
    return NextResponse.next();
  }

  // Check for auth token in cookie (set by client) or authorization header
  const token =
    request.cookies.get('panel_token')?.value ??
    request.headers.get('authorization')?.replace('Bearer ', '');

  // No token — redirect to login
  if (!token) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  // Run middleware on all routes except static files
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
