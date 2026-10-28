# Security Policy

## Supported versions

This project is pre-1.0 and under active development. Only the `main` branch is supported; security fixes are applied to `main` and are not backported.

## Reporting a vulnerability

Please do not open a public issue for a security vulnerability.

Use GitHub's private vulnerability reporting for this repository (the "Report a vulnerability" button under the Security tab). Include:

- A description of the issue and its impact
- The affected component (core, local provider, Cloudflare provider, specification)
- Steps to reproduce, or a proof of concept, if available
- Your assessment of severity, if you have one

We aim to acknowledge a report within 7 days and to agree on a disclosure timeline with the reporter.

## Scope notes

Deployments of the reference implementation hold secrets (such as the Slack signing secret, bot tokens, and the doorbell capability) outside this repository, in the deployer's own secret store. A capability value, token, or signing secret found in this repository's history should be reported through the process above.

The doorbell is designed to carry no message content (only an event ID and a timestamp), so disclosure of a doorbell signal does not disclose conversation content. Reports that show a way to make hub components carry or leak message bodies through the doorbell path are in scope and especially welcome.
