# Security Policy

## Scope

This repository contains the source code of the backend that powers the Böxle
iOS app. It is published as a **read-only reference** so that users can verify
what happens with their data.

## Reporting a Vulnerability

If you believe you have found a security issue in this code or in the
production service, **please do not open a public GitHub issue**. Instead,
report it privately:

- Email: **security@boexle.app**
- Subject line: `Security: <short description>`

Please include:

- A clear description of the issue and its impact.
- Steps to reproduce (proof-of-concept code or curl commands if applicable).
- Any relevant log output, with sensitive data redacted.
- Your preferred contact channel for follow-up.

You will receive an acknowledgement within a few working days. We will keep
you informed while we investigate and coordinate a fix.

## Out of Scope

- Denial-of-service via trivial brute-force or resource exhaustion that would
  require adversarial network access to our infrastructure.
- Findings that require physical access to a user's unlocked device.
- Theoretical issues without a realistic attack path.

## Responsible Disclosure

We ask that you give us a reasonable amount of time to investigate and
release a fix before any public disclosure. We are happy to credit
responsible reporters in release notes if requested.

Thank you for helping keep Böxle users safe.
