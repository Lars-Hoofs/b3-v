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
    // Try cookie-based session first (Better Auth default)
    let session = await auth.api.getSession({
      headers: req.headers as any,
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
      // Log alleen bij debug mode om spam te voorkomen
      if (process.env.DEBUG_AUTH === 'true') {
        console.warn('[Auth] No session found', {
          path: req.path,
          hasCookie: !!req.headers.cookie,
          hasAuthHeader: !!req.headers.authorization,
        });
      }
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
  auth.api
    .getSession({
      headers: req.headers as any,
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
