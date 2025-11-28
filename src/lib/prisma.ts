import { PrismaClient } from "@prisma/client";
import logger from './logger';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};


import { env } from './env'; // Import validated env

// ... (imports remain the same)

const prismaBase = new PrismaClient({
  log: env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  datasources: {
    db: {
      url: env.DATABASE_URL, // Use validated DATABASE_URL
    },
  },
});

export const prisma = prismaBase;

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

// Log database connection
prisma.$connect()
  .then(() => logger.info('Database connected successfully'))
  .catch((error) => logger.error('Database connection error', { error }));
