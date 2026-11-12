import { googleProvider } from '../google.ts';

export const gmailAuth = googleProvider('gmail', 'Gmail', 'https://www.googleapis.com/auth/gmail.send');
