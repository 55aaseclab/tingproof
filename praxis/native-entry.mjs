import { startTingProofServer } from '../dist-server/main.js';
const port = Number(process.env.PORT || 15173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
startTingProofServer({ host: process.env.HOST || '127.0.0.1', port, distDir: '/app/dist-public' });
