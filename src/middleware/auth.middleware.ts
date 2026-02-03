import { Request, Response, NextFunction } from "express";
import { auth } from "../lib/auth";

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    name?: string;
    emailVerified: boolean;
    role?: string;
  };
  session?: any;
}

export async function requireAuth(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    // Convert Express headers to Web Standard Headers for Better Auth
    const headers = new Headers();
    Object.entries(req.headers).forEach(([key, value]) => {
      if (value) {
        headers.set(key, Array.isArray(value) ? value[0] : value as string);
      }
    });

    // Try cookie-based session first (Better Auth default)
    let session = await auth.api.getSession({
      headers: headers,
    });

    // If no session from cookies, try Bearer token (for Postman/API clients)
    if (!session) {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.substring(7);

        // Create headers object with the session token as a cookie
        // Better Auth uses multi-session format
        const headers = {
          ...req.headers,
          cookie: `enterprise.session_token_multi-${token.toLowerCase()}=${token}`,
        };

        session = await auth.api.getSession({
          headers: headers as any,
        });
      }
    }

    if (!session) {
      // Force log for debugging 401 issues
      console.warn('[Auth] No session found (401)', {
        path: req.path,
        method: req.method,
        origin: req.headers.origin,
        referer: req.headers.referer,
        hasCookie: !!req.headers.cookie,
        cookieNames: req.headers.cookie ? req.headers.cookie.split(';').map(c => c.trim().split('=')[0]) : [],
        hasAuthHeader: !!req.headers.authorization,
        // Log headers for debugging proxy issues (exclude sensitive values)
        headers: Object.keys(req.headers).filter(k => k !== 'cookie' && k !== 'authorization'),
      });

      return res.status(401).json({
        error: "Unauthorized",
        message: "You must be logged in to access this resource. Please provide session token in Cookie or Authorization header.",
      });
    }

    req.user = session.user as any;
    req.session = session.session;
    next();
  } catch (error) {
    // Log met meer context voor debugging
    console.error("Auth middleware error:", {
      path: req.path,
      error: (error as Error).message,
      stack: process.env.NODE_ENV === 'development' ? (error as Error).stack : undefined,
    });
    return res.status(401).json({
      error: "Unauthorized",
      message: "Invalid or expired session",
    });
  }
}

export function optionalAuth(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  // Convert Express headers to Web Standard Headers
  const headers = new Headers();
  Object.entries(req.headers).forEach(([key, value]) => {
    if (value) {
      headers.set(key, Array.isArray(value) ? value[0] : value as string);
    }
  });

  auth.api
    .getSession({
      headers: headers,
    })
    .then((session) => {
      if (session) {
        req.user = session.user as any;
        req.session = session.session;
      }
      next();
    })
    .catch(() => {
      next();
    });
}
