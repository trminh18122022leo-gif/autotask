import { bootstrapIntermediateCa } from '../../src/ca-bootstrap.js';
bootstrapIntermediateCa();
console.log(JSON.stringify({
  respawned: process.env._AUTOTASK_CA_RESPAWNED ?? null,
  extraCa: process.env.NODE_EXTRA_CA_CERTS ?? null,
  rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? null
}));
