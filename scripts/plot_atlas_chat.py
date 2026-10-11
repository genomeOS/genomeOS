"""Capture the real map with deterministic chat acceptance receipts; design §§11, 16.

The response is an explicitly labelled acceptance fixture, not a live Gemini result.
Actual published HbS artifacts render unchanged. Run the website with
PUBLIC_ATLAS_CHAT_URL=http://127.0.0.1:8011 before invoking this script.
"""

from __future__ import annotations

import argparse
import subprocess
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:4335")
    parser.add_argument("--out", type=Path, default=Path("docs/figures/atlas-map-assistant.png"))
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    subprocess.run(
        ["node", "website/scripts/verify-chat.mjs", args.base_url, str(args.out.resolve())],
        cwd=root,
        check=True,
    )


if __name__ == "__main__":
    main()
