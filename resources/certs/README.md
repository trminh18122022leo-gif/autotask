# Public Intermediate CA Certificate: GlobalSign RSA OV SSL CA 2018

## 1. Information & Provenance
- **Subject:** `CN=GlobalSign RSA OV SSL CA 2018, O=GlobalSign nv-sa, C=BE`
- **Issuer:** `CN=GlobalSign, O=GlobalSign, OU=GlobalSign Root CA - R3`
- **Serial Number:** `0x1ee5f221dfc623bd4333a8557`
- **Validity:** 2018-11-21 00:00:00 UTC to 2028-11-21 00:00:00 UTC
- **Official AIA Source:** `http://secure.globalsign.com/cacert/gsrsaovsslca2018.crt`
- **SHA-256 Fingerprint:** `b676ffa3179e8812093a1b5eafee876ae7a6aaf231078dad1bfb21cd2893764a`
- **SHA-1 Fingerprint:** `dfe83023062b997682708b4eab8e819aff5d9775`

## 2. Purpose & Portability
The target LMS production host (`lms.hust.edu.vn`) serves an X.509 leaf certificate signed by this intermediate CA, but the host web server configuration omits sending the intermediate certificate in the TLS ServerHello handshake.
While desktop browsers automatically retrieve missing intermediate certificates via Authority Information Access (AIA), non-browser TLS clients such as Node.js require the intermediate certificate to complete trust path validation.

This public certificate is bundled in `resources/certs/globalsign_intermediate.crt` to enable portable out-of-the-box operation on fresh installations without requiring manual copy steps or disabling TLS validation.

## 3. Security Invariants
- This file is a **public X.509 certificate**.
- Contains **strictly zero private keys, zero passwords, and zero secrets**.
- TLS validation is strictly enforced (`rejectUnauthorized: true`). AutoTask AI never disables HTTPS verification (`NODE_TLS_REJECT_UNAUTHORIZED=0` is strictly forbidden).
