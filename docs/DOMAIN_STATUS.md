# Domain registration status

Verified on 2026-09-06. All four requested domains are registered with Cloudflare and appeared as **Active** in the freshly reloaded registrar inventory. Each expires on 2027-09-06. Automatic renewal is off. WHOIS redaction was included in checkout.

| Domain | One-year amount paid |
| --- | ---: |
| `blackwellindex.com` | $10.46 |
| `blackwell.fyi` | $15.20 |
| `blackwell.today` | $22.20 |
| `altx.exchange` | $30.20 |

Total paid: **$78.06**. The current quoted annual renewal amounts match the amounts above; future registry prices can change. Cloudflare labels `blackwell.fyi` as premium, but both its registration and quoted annual renewal were $15.20. No paid add-ons were purchased.

The purchase success page was checked separately for each order. The four most recent billing entries matched the amounts and sequence of these purchases and were marked **Paid**. Invoice and order identifiers are retained privately. No registrant contact information, payment details, account credentials or private account identifiers are included here.

## Independent registry verification

| Domain | Registry registration timestamp (UTC) | Registry expiry timestamp (UTC) |
| --- | --- | --- |
| `blackwellindex.com` | 2026-09-06T08:06:18Z | 2027-09-06T08:06:18Z |
| `blackwell.fyi` | 2026-09-06T08:09:14.167Z | 2027-09-06T08:09:14.167Z |
| `blackwell.today` | 2026-09-06T08:07:44.264Z | 2027-09-06T08:07:44.264Z |
| `altx.exchange` | 2026-09-06T08:03:10.711Z | 2027-09-06T08:03:10.711Z |

Authoritative registry sources:

- [Verisign RDAP: blackwellindex.com](https://rdap.verisign.com/com/v1/domain/blackwellindex.com)
- [Identity Digital RDAP: blackwell.fyi](https://rdap.identitydigital.services/rdap/domain/blackwell.fyi)
- [Identity Digital RDAP: blackwell.today](https://rdap.identitydigital.services/rdap/domain/blackwell.today)
- [Identity Digital RDAP: altx.exchange](https://rdap.identitydigital.services/rdap/domain/altx.exchange)

All four registry records list `jessica.ns.cloudflare.com` and `matt.ns.cloudflare.com`, and prohibit client transfers. Registrar handle `1910` identifies Cloudflare.

## Deployment status at handoff

Registration is complete. Site deployment, host routing and TLS acceptance are separate work.

- Authoritative nameservers respond for all four zones.
- No A records were returned by the authoritative nameserver at handoff.
- HTTPS requests could not resolve the domains at handoff. A production HTTPS response has not been verified.
- Recursive resolver propagation was partial immediately after registration: `blackwellindex.com` and `altx.exchange` had NS answers; the two newest names still had negative cached answers.
- Do not infer DNSSEC activation or certificate issuance from the free features listed in checkout; verify both during deployment.

Remaining work:

1. Route `altx.exchange` to the minimal ALTX landing page.
2. Route `blackwellindex.com` to the index and node API.
3. Route `blackwell.fyi` and `blackwell.today` to the index, preferably with canonical redirects.
4. Confirm A/AAAA or flattened CNAME answers, HTTPS certificates, host-specific page content and redirects from an external resolver.
5. Record the production project and final verification evidence here after deployment.

For Cloudflare Pages, add the custom domain to the actual Pages project before adding its DNS record. An apex domain must be a zone in the same Cloudflare account as that project. [Cloudflare custom-domain documentation](https://developers.cloudflare.com/pages/configuration/custom-domains/)
