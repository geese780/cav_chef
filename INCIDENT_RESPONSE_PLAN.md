# Incident Response Plan — CAV_Chef

**Owner:** Clear All Visuals Inc.
**Applies to:** The CAV_Chef application and all systems, credentials, and data
involved in its access to the Amazon Business (Amazon Services) API.
**Version:** 1.0
**Last reviewed:** _[DATE]_
**Next review due:** _[DATE + 6 months]_
**Plan owner / Incident Response Lead:** _[NAME]_

---

## 1. Purpose

This plan defines how Clear All Visuals Inc. detects, responds to, and reports
security incidents that affect Amazon Information handled by the CAV_Chef
application. It exists to satisfy Amazon's Data Protection Policy (DPP)
requirement for a maintained incident response plan, and — more importantly — to
make sure that if something goes wrong with a system that can place real orders
and touches order data, we contain it quickly and notify the right parties on
time.

## 2. Scope

This plan covers every system that stores, processes, transmits, or can act on
Amazon Information in the course of running CAV_Chef, including:

- The CAV_Chef Node.js application (Slack Bolt worker) and its host environment
  (currently local / Google Cloud Run target).
- Credentials that grant access to Amazon: the Login with Amazon (LWA) client ID,
  client secret, and refresh token, and any derived access tokens.
- Supporting service credentials whose compromise could reach Amazon data or
  ordering ability: Slack bot/app tokens, the Google Calendar service account
  key, and any secrets held in Google Secret Manager or a local `.env`.
- Local application state that records ordering activity: the SQLite stores for
  pending drafts, check-ins, and the audit log (`data/`).
- The source repository and CI pipeline (GitHub) used to build and deploy the
  application.

## 3. Definitions

**Amazon Information** — any data received from, or derived through, the Amazon
Services API. For CAV_Chef this includes order identifiers, order line items and
quantities, prices and charges, buying-group and payment-method references,
ship-to address references, buyer email, and any personally identifiable
information (PII) associated with an order.

**Security Incident** — any actual or suspected unauthorized access, acquisition,
use, disclosure, loss, or corruption of Amazon Information, or a breach of any
system that holds or can act on Amazon Information. Examples: a leaked LWA
credential, an order placed without a valid approval, unauthorized access to the
audit log, or loss of a device holding secrets.

**PII** — personally identifiable information, such as a buyer's name, email
address, shipping address, or phone number.

## 4. Roles and Responsibilities

Because Clear All Visuals is a small team, individuals hold more than one role.
The named Incident Response Lead is accountable for the response even when work
is delegated.

| Role | Responsibility | Assigned to |
|---|---|---|
| **Incident Response Lead (IRL)** | Owns the incident end to end: declares an incident, coordinates response, decides on containment, authorizes external notifications including Amazon. | _[NAME]_ |
| **Backup IRL** | Assumes the IRL role when the primary is unavailable. | _[NAME]_ |
| **Technical Responder** | Executes containment and recovery: rotates credentials, disables access, inspects logs, restores service. | _[NAME]_ |
| **Communications / Notification Owner** | Prepares and sends required notifications (Amazon, affected parties) within deadlines; maintains the incident record. | _[NAME]_ |

All team members are responsible for reporting a suspected incident to the IRL
immediately upon discovery.

## 5. Incident Types That May Impact Amazon

- **Credential compromise** — exposure or theft of LWA credentials, Slack tokens,
  the Google service-account key, or Secret Manager contents.
- **Unauthorized or anomalous ordering** — an order placed outside the approved
  Slack approval flow, an unexpected spike in orders, or orders to an unexpected
  address.
- **Exposure of Amazon Information** — Amazon order data, buyer PII, or the audit
  log accessed, copied, or transmitted by an unauthorized party.
- **Application or infrastructure compromise** — unauthorized access to the host,
  the repository, the CI pipeline, or the deployed Cloud Run service.
- **Third-party / dependency compromise** — a malicious or vulnerable npm
  dependency, or a compromise of Slack, Google, or the hosting provider that
  reaches CAV_Chef data.
- **Lost or stolen asset** — a laptop or device with access to secrets or Amazon
  data.

## 6. Detection Sources

Incidents may be detected through:

- CAV_Chef's structured logs and its `/health` endpoint.
- The application's own Slack alerts on `placeOrder` / poll failures to the
  approval channel.
- The append-only audit log — decisions and orders that don't match an expected
  approval.
- GitHub security / Dependabot alerts on the repository.
- Notifications from Amazon, Slack, or Google about suspicious activity.
- A team member noticing anomalous behavior or receiving a report.

## 7. Response Procedure

### 7.1 Detect and Report
Anyone who discovers a suspected incident notifies the IRL immediately through
the fastest available channel. The IRL opens an incident record (date/time of
detection, who reported it, initial description).

### 7.2 Triage and Classify
The IRL confirms whether it is a Security Incident, identifies the incident type
(Section 5), and assesses whether **Amazon Information is or may be involved**.
If Amazon Information is or may be involved, the 24-hour Amazon notification clock
(Section 8) starts at the moment of detection.

### 7.3 Contain
Take immediate action to stop ongoing harm, for example:

- Set `AMAZON_MODE=mock` and/or stop the CAV_Chef worker to halt all ordering.
- Revoke or rotate the affected credentials (LWA, Slack, Google, Secret Manager).
- Remove or suspend access for any compromised account; enforce/reset MFA.
- Isolate the affected host or roll back the affected deployment.

### 7.4 Eradicate
Remove the root cause: patch the vulnerability, remove malicious code or
dependencies, close the misconfiguration, and confirm no persistence remains.

### 7.5 Recover
Restore normal operation only after containment and eradication are verified:
re-issue clean credentials, redeploy from a known-good build, confirm the audit
log and pending state are intact, and monitor closely before returning
`AMAZON_MODE` to `live`.

### 7.6 Notify
Complete all required notifications within their deadlines (Section 8).

### 7.7 Post-Incident Review
Within a reasonable period after closure, the IRL leads a review documenting the
timeline, root cause, actions taken, and corrective/preventive actions. Update
this plan and the application if the review identifies gaps.

## 8. Amazon Notification (24-Hour Requirement)

**If a Security Incident involves or may involve Amazon Information, Clear All
Visuals will notify Amazon at `security@amazon.com` within 24 hours of detecting
the incident.** This notification is not delayed pending full investigation.

The notification will include, to the extent known at the time:

- Date and time the incident was detected.
- A description of the incident and the Amazon Information potentially affected.
- The current status of the investigation and containment actions taken.
- A point of contact at Clear All Visuals for follow-up.

The Communications / Notification Owner sends this notification on the IRL's
authorization and records the time it was sent. Follow-up updates are provided to
Amazon as the investigation progresses. Other notifications (e.g., affected
individuals or authorities) are made as required by applicable law.

## 9. Supporting Security Controls

These standing controls reduce incident likelihood and impact, and correspond to
other Data Protection Policy requirements Amazon assesses alongside the incident
response plan:

- **Encryption in transit** — All Amazon Information is transmitted over
  TLS 1.2+ (HTTPS). Every external endpoint CAV_Chef uses is HTTPS: the Amazon
  Ordering API, the LWA token endpoint, the Slack API and Socket Mode connection,
  and the Google Calendar API. No plaintext HTTP is used for any of these.
- **Credential management** — Credentials are never hardcoded; they are read from
  environment variables, sourced from Google Secret Manager in production. Amazon
  and other API credentials are restricted to required personnel and rotated at
  least once every 12 months (and immediately upon any suspected compromise).
- **Access and authentication** — Multi-factor authentication is enabled on the
  Amazon Business account, Slack workspace admin, Google Cloud, and GitHub.
  Access follows least privilege; the CAV_Chef developer identity carries only
  the roles it needs.
- **Approval and audit controls** — Ordering requires an allowlisted approver;
  drift or unverifiable pricing requires a second, distinct approver; every
  prompt, decision, and order is written to an append-only audit log.
- **Data minimization and retention** — CAV_Chef stores only the Amazon
  Information needed to operate and audit ordering. PII is minimized in stored
  records; where Amazon Information containing PII is retained, it is protected at
  rest, and retention is reviewed against Amazon's data-retention requirements.
- **Logging and monitoring** — The application emits structured logs, exposes a
  health endpoint, and alerts to Slack on operational failures.

## 10. Review and Maintenance

- This plan is reviewed and updated **at least once every six months**, and after
  any incident or material change to CAV_Chef or its data handling.
- Each review updates the "Last reviewed" and "Next review due" dates and the
  change log below.
- The plan is stored in the CAV_Chef repository so changes are version-controlled.

### Change Log

| Version | Date | Author | Summary |
|---|---|---|---|
| 1.0 | _[DATE]_ | _[NAME]_ | Initial incident response plan. |

## 11. Key Contacts

| Contact | Detail |
|---|---|
| Incident Response Lead | _[NAME]_ — _[PHONE]_ / _[EMAIL]_ |
| Backup IRL | _[NAME]_ — _[PHONE]_ / _[EMAIL]_ |
| Amazon security notifications | security@amazon.com |
| Slack support | https://slack.com/help |
| Google Cloud support | via the Google Cloud console |
