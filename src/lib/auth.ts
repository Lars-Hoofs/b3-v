import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { twoFactor, admin, multiSession, organization } from "better-auth/plugins";
import { prisma } from "./prisma";
import { sendVerificationEmail, sendPasswordResetEmail } from './email';
import logger from './logger';

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3000",
  basePath: "/api/auth",
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    minPasswordLength: 12,
    maxPasswordLength: 128,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 dagen sessie geldigheid
    updateAge: 60 * 60, // Vernieuwd sessie elke uur (was 24 uur - te lang)
    cookieCache: {
      enabled: true, // ✅ Cookie caching ingeschakeld - voorkomt race conditions
      maxAge: 60 * 5, // Cache voor 5 minuten - vermindert database lookups
    },
  },
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["google", "github"],
    },
  },
  user: {
    deleteUser: {
      enabled: true,
    },
    changeEmail: {
      enabled: true,
      requireEmailVerification: false,
    },
    changePassword: {
      enabled: true,
      requirePasswordConfirmation: true,
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url, token }) => {
      try {
        // url = https://ai.bonsaimedia.nl/api/auth/verify-email?token=...
        // MAAR: we bouwen zelf onze eigen frontend-link:
        const baseUrl = process.env.BETTER_AUTH_URL || "http://localhost:3000";
        const trimmedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
        const verifyUrl = `${trimmedBase}/verify-email?token=${encodeURIComponent(token)}`;

        await sendVerificationEmail(user.email, verifyUrl, token);
        logger.info("Verification email sent", { email: user.email, verifyUrl });
      } catch (error) {
        logger.error("Failed to send verification email", { email: user.email, error });
      }
    },
  },
  passwordReset: {
    enabled: true,
    expiresIn: 60 * 60,
    sendResetEmail: async ({ user, url, token }: { user: any; url: string; token: string }) => {
      try {
        await sendPasswordResetEmail(user.email, url, token);
        logger.info('Password reset email sent', { email: user.email });
      } catch (error) {
        logger.error('Failed to send password reset email', { email: user.email, error });
      }
    },
  },
  trustedOrigins: [
    process.env.BETTER_AUTH_URL || "http://localhost:3000",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3001",
    "https://ai.bonsaimedia.nl",  // ✅ Frontend URL toegevoegd
  ],
  advanced: {
    generateId: () => {
      return crypto.randomUUID();
    },
    cookiePrefix: "enterprise",
    crossSubDomainCookies: {
      enabled: true,
      domain: (process.env.BETTER_AUTH_URL || "").includes("bonsaimedia.nl") ? ".bonsaimedia.nl" : undefined,
    },
    useSecureCookies: (process.env.BETTER_AUTH_URL || "").startsWith("https") || process.env.NODE_ENV === "production",
    disableCSRFCheck: process.env.NODE_ENV === "development",
  },
  cookies: {
    sessionToken: {
      // NOTE: We do NOT set the name here because the 'multiSession' plugin
      // automatically handles cookie naming (e.g. enterprise.session_token_multi-...)
      // Setting a fixed name here breaks multi-session support.
      options: {
        httpOnly: true,
        sameSite: "lax",
        secure: (process.env.BETTER_AUTH_URL || "").includes("bonsaimedia.nl") || process.env.NODE_ENV === "production",
        domain: (process.env.BETTER_AUTH_URL || "").includes("bonsaimedia.nl") ? ".bonsaimedia.nl" : undefined,
        path: "/",
      },
    },
  },
  rateLimit: {
    enabled: process.env.NODE_ENV === "production",
    window: 60,
    max: 100,
    storage: "memory",
  },
  plugins: [
    twoFactor({
      issuer: "Enterprise API",
    }),
    admin({
      defaultRole: "user",
      impersonationSessionDuration: 60 * 60,
    }),
    multiSession({
      maximumSessions: 25, // ✅ Verhoogd van 10 - voorkomt uitloggen bij multiple devices/browsers
    }),
    organization({
      allowUserToCreateOrganization: true,
      organizationLimit: 5,
    }),
  ],
});

export type Session = typeof auth.$Infer.Session;
