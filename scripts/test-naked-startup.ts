import { bootstrapIntermediateCa } from '../src/ca-bootstrap.js';
import tls from 'node:tls';

bootstrapIntermediateCa();

console.log('Naked startup active NODE_EXTRA_CA_CERTS:', process.env.NODE_EXTRA_CA_CERTS);

const sock = tls.connect(443, 'lms.hust.edu.vn', { servername: 'lms.hust.edu.vn' }, () => {
  console.log('Naked startup TLS verification: Authorized =', sock.authorized);
  sock.end();
  process.exit(sock.authorized ? 0 : 1);
});
sock.on('error', err => {
  console.error('Naked startup TLS verification error:', err.message);
  process.exit(1);
});
