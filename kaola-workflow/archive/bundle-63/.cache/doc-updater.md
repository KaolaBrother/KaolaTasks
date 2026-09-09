verdict: pass
status: DOCKED

Checked public docs against `workflow/bundle-63` HEAD `d52352bdc57f84b57d7e23095d288ae894414e2b` after e50f761 FAIL (CApath isolation + OpenSSL 3.0 expired fixture).

- Boot: openssl verify/s_client pass `-CAfile` together with `-no-CApath` / `-no-CAstore`.
- DESIGN §16.8 / ADR 0031 / api: default CApath/CAstore signer cannot substitute for the configured root.
- Expired leaf fixture uses `openssl ca -startdate/-enddate` (OpenSSL 3.0); not `x509 -not_before/-not_after`.
- CHANGELOG Unreleased: 5596887868 line above the 5596509483 line; earlier sentences not rewritten.
- Path L docs remain `760d068`; this checkpoint does not start UAT.

No new MCP tool. Live UAT not claimed. Implementer self-review of the repair only.
