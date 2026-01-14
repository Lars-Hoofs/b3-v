import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('Clearing database...');

    // Get all table names from the public schema
    const tablenames = await prisma.$queryRaw<
        Array<{ tablename: string }>
    >`SELECT tablename FROM pg_tables WHERE schemaname='public'`;

    // Filter out internal tables (like _prisma_migrations)
    const tables = tablenames
        .map(({ tablename }) => tablename)
        .filter((name) => name !== '_prisma_migrations')
        .map((name) => `"public"."${name}"`)
        .join(', ');

    if (tables.length > 0) {
        try {
            // Truncate all tables with CASCADE to handle foreign key constraints
            await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables} CASCADE;`);
            console.log('✅ Database cleared successfully.');
        } catch (error) {
            console.error('❌ Error clearing database:', error);
        }
    } else {
        console.log('No tables found to clear.');
    }
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
