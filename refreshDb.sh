rm prisma/db.*
rm -r prisma/migrations
npx prisma migrate dev --name init