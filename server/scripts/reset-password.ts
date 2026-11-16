// Operator reset for a forgotten password (there is no email reset): npm run reset-password -w server -- user@example.com 'new-password'
import bcrypt from 'bcryptjs';
import { prisma } from '../src/db.ts';

const [email, password] = process.argv.slice(2);
if (!email || !password || password.length < 8) {
  console.error('Usage: npm run reset-password -w server -- <email> <new password, at least 8 characters>');
  process.exit(1);
}
const { count } = await prisma.user.updateMany({ where: { email: email.toLowerCase() }, data: { passwordHash: await bcrypt.hash(password, 10) } });
console.log(count ? `Password reset for ${email}` : `No account with email ${email}`);
await prisma.$disconnect();
process.exit(count ? 0 : 1);
