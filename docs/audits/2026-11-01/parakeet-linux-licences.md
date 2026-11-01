# Linux Parakeet dependency licence review

The merge first parent `2c528dfe^1` (`a9e39d01`) reproduces all eight failures: 8 failed, 7 passed across the three supply-chain test files. Tests ran sequentially with one Vitest worker.

Cargo metadata was read with `--locked --format-version 1`; no builds or GPU work ran. Every locked package matched metadata. Of 90 locked packages, 88 declare licences accepted by the existing deny.toml policy. The two webpki-roots packages declare CDLA-Permissive-2.0, which is not on that allow list. No approval baseline or licence allow list was changed. The complete graph cannot be approved under the requested existing-licences-only boundary.

The dependency approval private key `~/.ssh/klippt_dependency_approval` is absent on this PC. The signed baseline cannot be updated here without the existing signing authority. Release inventory regeneration remains blocked by these approvals.

| Crate | Version | Declared licence (Cargo metadata) | Review |
|---|---|---|---|
| adler2 | 2.0.1 | 0BSD OR MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| base64 | 0.22.1 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| bitflags | 2.13.2 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| bzip2 | 0.4.4 | MIT/Apache-2.0 | Accepted licence; graph approval pending |
| bzip2-sys | 0.1.13+1.0.8 | MIT/Apache-2.0 | Accepted licence; graph approval pending |
| cc | 1.10.0 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| cfg-if | 1.0.5 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| crc32fast | 1.5.3 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| displaydoc | 0.2.7 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| errno | 0.3.14 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| filetime | 0.2.29 | MIT/Apache-2.0 | Accepted licence; graph approval pending |
| find-msvc-tools | 0.1.15 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| flate2 | 1.1.10 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| form_urlencoded | 1.2.2 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| getrandom | 0.2.17 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| icu_collections | 2.4.0 | Unicode-3.0 | Accepted licence; graph approval pending |
| icu_locale_core | 2.4.0 | Unicode-3.0 | Accepted licence; graph approval pending |
| icu_normalizer | 2.4.0 | Unicode-3.0 | Accepted licence; graph approval pending |
| icu_normalizer_data | 2.4.0 | Unicode-3.0 | Accepted licence; graph approval pending |
| icu_properties | 2.4.0 | Unicode-3.0 | Accepted licence; graph approval pending |
| icu_properties_data | 2.4.0 | Unicode-3.0 | Accepted licence; graph approval pending |
| icu_provider | 2.4.0 | Unicode-3.0 | Accepted licence; graph approval pending |
| idna | 1.1.0 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| idna_adapter | 1.2.2 | Apache-2.0 OR MIT | Accepted licence; graph approval pending |
| itoa | 1.0.18 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| klippt-parakeet-stt | 0.0.0 | MIT | Accepted licence; graph approval pending |
| libc | 0.2.191 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| linux-raw-sys | 0.12.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | Accepted licence; graph approval pending |
| litemap | 0.8.3 | Unicode-3.0 | Accepted licence; graph approval pending |
| log | 0.4.34 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| memchr | 2.8.3 | Unlicense OR MIT | Accepted licence; graph approval pending |
| miniz_oxide | 0.9.1 | MIT OR Zlib OR Apache-2.0 | Accepted licence; graph approval pending |
| once_cell | 1.21.4 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| percent-encoding | 2.3.2 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| pkg-config | 0.3.34 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| potential_utf | 0.1.6 | Unicode-3.0 | Accepted licence; graph approval pending |
| proc-macro2 | 1.0.107 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| quote | 1.0.47 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| ring | 0.17.14 | Apache-2.0 AND ISC | Accepted licence; graph approval pending |
| rustix | 1.1.6 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | Accepted licence; graph approval pending |
| rustls | 0.23.46 | Apache-2.0 OR ISC OR MIT | Accepted licence; graph approval pending |
| rustls-pki-types | 1.15.1 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| rustls-webpki | 0.103.16 | ISC | Accepted licence; graph approval pending |
| serde | 1.0.229 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| serde_core | 1.0.229 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| serde_derive | 1.0.229 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| serde_json | 1.0.154 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| sherpa-onnx | 1.13.5 | Apache-2.0 | Accepted licence; graph approval pending |
| sherpa-onnx-sys | 1.13.5 | Apache-2.0 | Accepted licence; graph approval pending |
| shlex | 2.0.1 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| simd-adler32 | 0.3.10 | MIT | Accepted licence; graph approval pending |
| smallvec | 1.16.4 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| stable_deref_trait | 1.2.1 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| subtle | 2.6.1 | BSD-3-Clause | Accepted licence; graph approval pending |
| syn | 3.0.9 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| synstructure | 0.14.0 | MIT | Accepted licence; graph approval pending |
| tar | 0.4.46 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| tinystr | 0.8.5 | Unicode-3.0 | Accepted licence; graph approval pending |
| unicode-ident | 1.0.27 | (MIT OR Apache-2.0) AND Unicode-3.0 | Accepted licence; graph approval pending |
| untrusted | 0.9.0 | ISC | Accepted licence; graph approval pending |
| ureq | 2.12.1 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| url | 2.5.8 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| utf8_iter | 1.0.4 | Apache-2.0 OR MIT | Accepted licence; graph approval pending |
| wasi | 0.11.1+wasi-snapshot-preview1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | Accepted licence; graph approval pending |
| webpki-roots | 0.26.11 | CDLA-Permissive-2.0 | Not approved: outside existing policy |
| webpki-roots | 1.0.11 | CDLA-Permissive-2.0 | Not approved: outside existing policy |
| windows-link | 0.2.1 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| windows-sys | 0.52.0 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| windows-sys | 0.61.2 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| windows-targets | 0.52.6 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| windows_aarch64_gnullvm | 0.52.6 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| windows_aarch64_msvc | 0.52.6 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| windows_i686_gnu | 0.52.6 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| windows_i686_gnullvm | 0.52.6 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| windows_i686_msvc | 0.52.6 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| windows_x86_64_gnu | 0.52.6 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| windows_x86_64_gnullvm | 0.52.6 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| windows_x86_64_msvc | 0.52.6 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| writeable | 0.6.4 | Unicode-3.0 | Accepted licence; graph approval pending |
| xattr | 1.7.0 | MIT OR Apache-2.0 | Accepted licence; graph approval pending |
| yoke | 0.8.4 | Unicode-3.0 | Accepted licence; graph approval pending |
| yoke-derive | 0.8.4 | Unicode-3.0 | Accepted licence; graph approval pending |
| zerofrom | 0.1.8 | Unicode-3.0 | Accepted licence; graph approval pending |
| zerofrom-derive | 0.1.8 | Unicode-3.0 | Accepted licence; graph approval pending |
| zeroize | 1.9.1 | Apache-2.0 OR MIT | Accepted licence; graph approval pending |
| zerotrie | 0.2.5 | Unicode-3.0 | Accepted licence; graph approval pending |
| zerovec | 0.11.9 | Unicode-3.0 | Accepted licence; graph approval pending |
| zerovec-derive | 0.11.7 | Unicode-3.0 | Accepted licence; graph approval pending |
| zlib-rs | 0.6.8 | Zlib | Accepted licence; graph approval pending |
| zmij | 1.0.23 | MIT | Accepted licence; graph approval pending |
