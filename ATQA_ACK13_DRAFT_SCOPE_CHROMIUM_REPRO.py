import os
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

source = Path(
    "dist/src/lms/advanced-adapters.js"
).read_text(encoding="utf-8")

start = (
    "await pg.evaluate(async "
    "({ pageUrl, expectedDraftItemId, fname, "
    "localSha256, localSize }) => {"
)

end = (
    "}, { pageUrl: pageUrlStr, "
    "expectedDraftItemId, fname, "
    "localSha256, localSize });"
)

a = source.index(start)
b = source.index(end, a)

callback = source[
    a + len("await pg.evaluate("): b + 1
]

# Server only has a file in DRAFT_B.
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
    default_exec = (
        r"C:\Users\Admin\AppData\Local\ms-playwright\chromium-1248\chrome-win64\chrome.exe"
        if os.name == "nt"
        else "/usr/bin/chromium"
    )
    exec_path = os.environ.get("CHROMIUM_PATH", default_exec)
    launch_kwargs = {"headless": True, "args": ["--no-sandbox"]}
    if exec_path and os.path.exists(exec_path):
        launch_kwargs["executable_path"] = exec_path

    browser = p.chromium.launch(**launch_kwargs)

    page = browser.new_page()
    page.set_content(
        "<html><body>Isolated regression</body></html>"
    )

    page.evaluate(
        """
        (html) => {
          window.fetch = async () => ({
            ok: true,
            text: async () => html
          });
        }
        """,
        server_html
    )

    args = {
        "pageUrl":
            "https://sandbox.invalid/mod/quiz/attempt.php",
        "expectedDraftItemId": "DRAFT_A",
        "fname": "report.pdf",
        "localSha256": "abc123",
        "localSize": 5
    }

    result = page.evaluate(callback, args)

    print("ACK-13 readback result:", result)

    assert result.get("persisted") is False, (
        "Wrong widget draft was falsely accepted"
    )

    browser.close()
