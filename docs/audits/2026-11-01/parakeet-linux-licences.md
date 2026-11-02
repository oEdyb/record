# Linux Parakeet system certificate roots

`sherpa-onnx-sys 1.13.5` pulls in `ureq 2.12.1` as a build dependency.
The exact downloaded ureq source documents `native-certs` as the system trust-store feature.
Its `tls` feature nevertheless includes webpki-roots. The vendored 2.12.1 source changes
that single feature dependency to native-certs; TLS verification remains enabled.
Upstream source and licence notices are preserved in vendor/ureq.

The helper builds with `cargo build -j 1`. The system-roots example uses the same
ureq agent configuration as the native archive downloader, fetches the sherpa-onnx
release page on github.com with certificate verification, asserts HTTP 200, and reads
at most 1024 bytes. It passed. No GPU was used.

Both webpki-roots versions are absent from Cargo.lock. New packages and verified
Cargo metadata licences:

- core-foundation 0.9.4: MIT OR Apache-2.0
- core-foundation-sys 0.8.7: MIT OR Apache-2.0
- openssl-probe 0.1.6: MIT/Apache-2.0
- rustls-native-certs 0.7.3: Apache-2.0 OR ISC OR MIT
- rustls-pemfile 2.2.0: Apache-2.0 OR ISC OR MIT
- schannel 0.1.30: MIT
- security-framework 2.11.1: MIT OR Apache-2.0
- security-framework-sys 2.17.0: MIT OR Apache-2.0

All new licences are already accepted by deny.toml. The repository generator refreshed
Cargo licence inventory and embedded licence evidence for the complete graph.
Approval input hashes were updated; the absent existing signing key prevents re-signing.
Release inventory generation therefore remains blocked by the approval signature.
The first-parent baseline previously reproduced 8 failures and 7 passes.
