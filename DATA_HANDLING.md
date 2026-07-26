# Data Handling & Retention Note — CAV_Chef

**Owner:** Clear All Visuals Inc.
**Applies to:** The CAV_Chef application and all data it receives from, derives
through, or sends to the Amazon Business (Amazon Services) API.
**Version:** 1.0
**Last reviewed:** _[DATE]_
**Next review due:** _[DATE + 6 months]_
**Owner / accountable person:** _[NAME]_

> Companion to the CAV_Chef Incident Response Plan. Together they describe how
> Clear All Visuals classifies, protects, retains, and disposes of Amazon
> Information, in line with Amazon's Data Protection Policy (DPP).

---

## 1. Purpose

This note documents how CAV_Chef handles Amazon Information across its lifecycle —
collection, storage, access, retention, and disposal — so that data is kept only
as long as needed, protected appropriately, and removed when it is no longer
required.

## 2. Scope

Every system that stores, processes, or transmits Amazon Information for
CAV_Chef: the application and its host, the SQLite stores under `data/` (pending
drafts, check-ins, audit log), configuration and secrets (environment variables /
Google Secret Manager), the source repository and CI pipeline, and any backups of
the above.

## 3. Data We Handle and Its Classification

CAV_Chef is used by Clear All Visuals to reorder its own food and drink supplies.
Clear All Visuals is the end buyer, so the data involved is predominantly the
company's own business data rather than third-party customer information — which
lowers, but does not remove, our data-protection obligations.

| Data | Where it comes from | Classification |
|---|---|---|
| ASINs, item names, quantities, thresholds | Slack inventory Lists | Business data |
| Prices / expected & actual charges, order IDs | Amazon API responses | Amazon Information |
| Payment-method, buying-group, ship-to-address references | Config / Amazon API | Amazon Information (identifiers) |
| Buyer email, ship-to address | Config / Amazon API | Amazon Information — **PII** |
| Slack user IDs of approvers | Slack | Internal identifiers (not Amazon buyer PII) |
| Booking times / locations | Google Calendar | Business data |
| API credentials, tokens, service-account key | Config / Secret Manager | Secret |

The only fields that rise to PII are the buyer email and ship-to address — and
because CAV is buying for itself, these are the company's own contact and
delivery details, not a third party's.

## 4. Data Minimization

- CAV_Chef collects and stores only what it needs to flag reorders, obtain
  approval, place orders, and keep an audit trail.
- **PII is kept out of persisted stores wherever possible.** In particular, the
  audit log records non-PII references only — order IDs, ASINs, quantities,
  charges, and internal approver user IDs — and does **not** store buyer email or
  ship-to address.
- Ship-to and buyer details needed to place an order are supplied to the Amazon
  API at order time via configured references (address ID, buyer email) and are
  not written into long-term application state.

## 5. Storage and Encryption

- **In transit:** all Amazon Information moves over TLS 1.2+ (HTTPS) on every
  endpoint CAV_Chef uses. No plaintext HTTP is used.
- **At rest:** application state is stored in SQLite under `data/`. Because the
  audit log and pending/check-in stores are kept free of PII (Section 4), there
  is no buyer PII at rest in these files. Any store that would hold Amazon
  Information containing PII must be encrypted at rest (AES-128 or stronger) or
  the PII removed before persistence.
- **Secrets:** credentials are never hardcoded and never committed to source.
  They are read from environment variables, backed by Google Secret Manager in
  the deployed environment. PII and secrets are not placed in removable media or
  unsecured public cloud storage.

## 6. Access Control

- Access to Amazon Information, credentials, and the data stores is restricted to
  the individuals who need it (least privilege).
- Multi-factor authentication is enabled on all accounts that can reach Amazon
  Information or credentials: the Amazon Business account, Slack admin, Google
  Cloud, and GitHub.
- The CAV_Chef developer identity holds only the Amazon roles it needs to place
  orders, and API credentials are rotated at least once every 12 months and on
  any suspected compromise.

## 7. Retention and Deletion

| Data | Retention | Disposal |
|---|---|---|
| Pending drafts | Only while an approval is in flight | Removed from the store on approve/deny |
| Check-in records | Until acknowledged | Superseded per booking; not retained long-term |
| Audit log (non-PII) | Retained for governance and to meet Amazon's records requirement (books/records for the agreement term plus 12 months) | Reviewed periodically; contains no PII to age out |
| Amazon Information containing PII | Not persisted in application state; if ever stored, retained no longer than needed and removed within 30 days | Securely deleted |
| Secrets | Life of use; rotated ≥ every 12 months | Revoked and removed on rotation/decommission |

Because the audit log is deliberately PII-free, it can be retained long-term for
compliance without conflicting with PII-retention limits. Any PII that does enter
a store is removed within 30 days of it no longer being needed.

## 8. Backups

Any backup that contains Amazon Information is encrypted, access-restricted, and
subject to the same retention and disposal rules as the primary data. Backups
containing PII follow the same 30-day removal rule.

## 9. Logging and Monitoring

CAV_Chef emits structured logs and exposes a health endpoint; operational
failures alert to Slack. Logs are written so they do not capture secrets or buyer
PII.

## 10. Review and Maintenance

- This note is reviewed at least once every six months and after any material
  change to what data CAV_Chef handles or how it is stored.
- Each review updates the review dates and the change log below.
- Stored in the CAV_Chef repository for version control.

### Change Log

| Version | Date | Author | Summary |
|---|---|---|---|
| 1.0 | _[DATE]_ | _[NAME]_ | Initial data handling & retention note. |
