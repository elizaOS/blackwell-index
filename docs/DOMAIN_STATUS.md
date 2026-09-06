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

## Deployment verification

The `blackwell-index` Cloudflare Worker was deployed on 6 September 2026. All six configured hostnames resolved and passed HTTPS verification. The index, ALTX and primary/secondary node hosts returned 200. The two short index domains returned canonical 308 redirects. A records for the four registered domains were also read from Cloudflare or Google public DNS resolvers.

Both landing pages and the served UI assets matched the committed source bytes. See the [release evidence](RELEASE_2026-09-06.md) for the exact revision, Worker version and node results, and [Cloudflare deployment](CLOUDFLARE.md) for the active route configuration.

Registration, DNS routing and initial TLS are complete. Automatic renewal remains off; DNSSEC activation and future certificate renewal are not established by this acceptance check.
