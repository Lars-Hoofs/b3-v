import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function makeAdmin(email: string) {
    try {
        const user = await prisma.user.update({
            where: { email },
            data: { role: 'admin' },
        });

        console.log(`✅ User ${user.email} is now an admin!`);
        console.log(`   ID: ${user.id}`);
        console.log(`   Name: ${user.name}`);
        console.log(`   Role: ${user.role}`);
    } catch (error) {
        console.error('❌ Error:', error);
        console.error('Make sure the email exists in the database.');
    } finally {
        await prisma.$disconnect();
    }
}

// Get email from command line argument
const email = process.argv[2];

if (!email) {
    console.error('❌ Please provide an email address');
    console.log('Usage: npm run make-admin user@example.com');
    process.exit(1);
}

makeAdmin(email);
