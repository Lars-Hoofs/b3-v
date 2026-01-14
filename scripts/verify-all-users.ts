import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
    console.log("Updating all users to be verified...");
    const result = await prisma.user.updateMany({
        data: {
            emailVerified: true,
        },
    });
    console.log(`Updated ${result.count} users.`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
