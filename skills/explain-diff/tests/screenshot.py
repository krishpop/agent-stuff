#!/usr/bin/env python3
"""Screenshot an explain-diff page in light and dark mode, after exercising its scripts.

usage: screenshot.py <page.html> <out-prefix> [--width 1280]
Writes <out-prefix>-light.png and <out-prefix>-dark.png and prints JS console errors.
Needs Playwright with a Chromium build (pip playwright; playwright install chromium).
"""
import argparse
import os
import pathlib
import sys

from playwright.sync_api import sync_playwright


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("page")
    ap.add_argument("prefix")
    ap.add_argument("--width", type=int, default=1280)
    a = ap.parse_args()
    url = pathlib.Path(a.page).resolve().as_uri()
    errors = []
    env = dict(os.environ)
    with sync_playwright() as p:
        browser = p.chromium.launch(env=env)
        for scheme in ("light", "dark"):
            page = browser.new_page(viewport={"width": a.width, "height": 900}, color_scheme=scheme)
            page.on("pageerror", lambda e: errors.append(f"{scheme}: {e}"))
            page.on("console", lambda m: m.type == "error" and errors.append(f"{scheme}: {m.text}"))
            page.goto(url)
            # Exercise the scripts: answer the first question, open the first frame series step, reveal a try-it.
            first = page.locator(".q .pick").first
            if first.count():
                first.click()
            nxt = page.locator(".fnext").first
            if nxt.count():
                nxt.click()
            rev = page.locator("button.reveal").first
            if rev.count():
                rev.click()
            page.evaluate("window.scrollTo(0, 0)")  # the table of contents is sticky
            page.screenshot(path=f"{a.prefix}-{scheme}.png", full_page=True)
            page.close()
        browser.close()
    for e in errors:
        print("console:", e)
    print(f"wrote {a.prefix}-light.png {a.prefix}-dark.png; {len(errors)} console error(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
