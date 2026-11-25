"""
ACK-14 — Missing draft ID must fail closed.

From the project root:

    node scripts/offline-build.cjs
    py -3 ATQA_ACK14_MISSING_DRAFT_SCOPE.py

Requires Python Playwright and Chromium.
Optionally set AUTOTASK_CHROMIUM_EXECUTABLE_PATH.
"""

import os
from pathlib import Path
from playwright.sync_api import sync_playwright

source = Path(
    "dist/src/lms/advanced-adapters.js"
).read_text(encoding="utf-8")

start_marker = (
    "const readback = await pg.evaluate("
)

end_marker = (
    "}, { pageUrl: pageUrlStr, "
    "expectedDraftItemId, fname, "
    "localSha256, localSize });"
)

start = source.index(start_marker) + len(start_marker)
end = source.index(end_marker, start) + 1

# Actual production callback, not a rewritten test version.
callback = source[start:end]

server_html = """
<html>
  <body>
    <div class="que">
      <div class="filemanager" data-itemid="DRAFT_B">
        <div class="fp-content">
          <div
            class="fp-file"
            data-file-name="report.pdf"
            data-file-sha256="abc123"
            data-file-size="5"
          >
            <span class="fp-filename">report.pdf</span>
          </div>
        </div>
      </div>
    </div>
  </body>
</html>
"""

with sync_playwright() as p:
    options = {"headless": True}
    chrome = os.environ.get(
        "AUTOTASK_CHROMIUM_EXECUTABLE_PATH"
    )

    if chrome:
        options["executable_path"] = chrome

    browser = p.chromium.launch(**options)
    page = browser.new_page()

    page.set_content(
        "<html><body>Independent fixture</body></html>"
    )

    page.evaluate(
        """
        html => {
          window.fetch = async () => ({
            ok: true,
            text: async () => html
          });
        }
        """,
        server_html
    )

    def verify(draft_id):
        return page.evaluate(
            f"({callback})",
            {
                "pageUrl":
                    "https://sandbox.invalid/mod/quiz/attempt.php",
                "expectedDraftItemId": draft_id,
                "fname": "report.pdf",
                "localSha256": "abc123",
                "localSize": 5
            }
        )

    # File is present in DRAFT_B.
    positive = verify("DRAFT_B")
    assert positive["persisted"] is True

    # File is not present in DRAFT_A.
    wrong_draft = verify("DRAFT_A")
    assert wrong_draft["persisted"] is False

    # Missing draft identity must never search the whole page.
    missing_draft = verify(None)
    assert missing_draft["persisted"] is False, (
        "ACK-14 FAILED: Missing draft ID caused "
        "cross-widget file verification"
    )

    print("ACK-14 PASS: exact draft scoping enforced")
    browser.close()
