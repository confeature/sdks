# Security policy

## Reporting a vulnerability

Please report a vulnerability privately, through GitHub's private vulnerability reporting: open the
**Security** tab of this repository and choose **Report a vulnerability**. The report is visible
only to the maintainers.

Do not open a public issue, pull request or discussion about a vulnerability before it is fixed.

Please include:

- the SDK or tool affected, and its version;
- what an attacker can do, and the steps to reproduce it;
- any proof of concept, kept to the minimum needed.

We acknowledge every report and keep you informed until it is resolved. We
credit reporters in the advisory unless you ask us not to.

## Scope

This repository holds the client SDKs and the CLI. A vulnerability in the hosted Confeature
service itself is reported the same way: the maintainers route it.

## Supported versions

Security fixes go into the latest released version of each SDK and of the CLI.

## If something private was published

What happens when a secret or personal data reaches this repository or a published package is
described in [docs/leak-remediation.md](docs/leak-remediation.md).
