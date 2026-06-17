#!/usr/bin/env python3
"""Optional Scrapling fetch adapter.

This script intentionally has no project-side dependency management. Callers may point
SCRAPLING_PYTHON at a venv with Scrapling installed; if Scrapling is unavailable it
exits non-zero so Node callers can fall back to curl/cheerio.
"""

from __future__ import annotations

import argparse
import sys


def decode_body(response) -> str:
    body = getattr(response, "body", b"")
    if isinstance(body, str):
        return body
    encoding = getattr(response, "encoding", None) or "utf-8"
    return body.decode(encoding, errors="replace")


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch a URL through Scrapling and print HTML to stdout")
    parser.add_argument("url")
    parser.add_argument("--fetcher", choices=["http", "dynamic", "stealthy"], default="http")
    parser.add_argument("--timeout", type=int, default=30, help="Timeout in seconds for http, seconds converted to ms for browser fetchers")
    parser.add_argument("--headless", action="store_true", default=True)
    parser.add_argument("--headed", action="store_false", dest="headless")
    parser.add_argument("--network-idle", action="store_true")
    args = parser.parse_args()

    try:
        from scrapling.fetchers import DynamicFetcher, Fetcher, StealthyFetcher
    except Exception as exc:  # pragma: no cover - depends on local optional env
        print(f"scrapling unavailable: {exc}", file=sys.stderr)
        return 2

    try:
        if args.fetcher == "http":
            response = Fetcher.get(args.url, timeout=args.timeout)
        elif args.fetcher == "dynamic":
            response = DynamicFetcher.fetch(
                args.url,
                headless=args.headless,
                timeout=args.timeout * 1000,
                network_idle=args.network_idle,
            )
        else:
            response = StealthyFetcher.fetch(
                args.url,
                headless=args.headless,
                timeout=args.timeout * 1000,
                network_idle=args.network_idle,
            )
    except Exception as exc:
        print(f"scrapling fetch failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 3

    sys.stdout.write(decode_body(response))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
