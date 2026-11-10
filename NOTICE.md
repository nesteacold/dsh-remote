# Notices and credits

This project is MIT-licensed (see [LICENSE](LICENSE)). It stands on work other
people published first, and that is worth stating plainly rather than burying.

## Forked code

**`plugins/mobile-gateway/`** is a fork of
[Clarklevis1995/dsh-plugin-mobile-gateway](https://github.com/Clarklevis1995/dsh-plugin-mobile-gateway),
taken at upstream v0.12.0 (commit `74ac444c7ff0ef396cd3680e8f49b178e1b32928`, 2026-11-07).

```text
MIT License

Copyright (c) 2026 Clarklevis1995
```

The original `LICENSE` file is kept verbatim inside that directory, and
[plugins/mobile-gateway/UPSTREAM.md](plugins/mobile-gateway/UPSTREAM.md) tracks
what we changed and why.

What we did to it: loopback-only by default, an owner switch, TLS with a pinned
self-signed certificate, per-device tokens with scoped pairing, approvals bound
to a hash of the tool arguments, log redaction, and a remote bridge that lets a
desktop client drive the Host's session API. We also switched the Cloudflare
tunnel, the `cloudflared` download and the one-command public setup **off** and
left the code behind a compile-time flag — a public listener with no owner in
the loop was not something we wanted to ship.

## Adapted ideas

**`plugins/devices/lib/host-router.mjs`** adapts structure and approach from
[liguobao/ds-harness-remote](https://github.com/liguobao/ds-harness-remote) —
specifically how that project installs and restores the private `typertGateway`
carrier, and its argument-order probe for DSH rc.1.

```text
MIT License

Copyright (c) 2026 liguobao
```

Without that prior work it would have taken far longer to find out that DSH's
own UI can render another Host's session at all.

## Platform

Built against [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
0.2.2-rc.1. DSH is not vendored here; every package declares `engines.dsh`.

## Our thanks

- **Clarklevis1995** — for the gateway, the mobile protocol shape, and a code
  base that was readable enough to harden instead of rewriting.
- **liguobao** — for `ds-harness-remote`, which showed that the gateway carrier
  can be wrapped and restored safely.
- The DSH team — for a plugin system that made this possible without patching
  the host, and for the source being readable enough to answer the awkward
  questions directly (the `session/agent-busy` rule and the subagent address
  union took us a long debugging session to pin down).

If you believe something here is credited wrongly or not at all, open an issue
and we will fix it.
