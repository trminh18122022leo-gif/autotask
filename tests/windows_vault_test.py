"""Real Windows Credential Manager & OS Keyring Acceptance Tests (Phase 6: VAULT-01 to VAULT-05)
Directly exercises the native OS Keyring backend (WinVaultKeyring on Windows) and vault_bridge.py.
Guarantees clean lifecycle: set, get, delete, assert zero residue in Windows Vault.
"""
import sys
import os
import unittest
import subprocess
import keyring
from keyring.errors import KeyringError

TEST_SERVICE = "AutoTaskAI_TestProbe_Service"
TEST_USER = "test_probe_user_v115"
TEST_SECRET = "sk-test-entropy-v115-secure-probe-998877"

TEST_MODEL_PROFILE = "test_probe_profile_v115"
BRIDGE_SCRIPT = os.path.join(os.path.dirname(__file__), "..", "desktop", "vault_bridge.py")


class WindowsVaultAcceptanceTest(unittest.TestCase):
    def setUp(self):
        # Guarantee clean state before each test
        self._cleanup_credentials()

    def tearDown(self):
        # Guarantee zero residual credentials remain after test execution
        self._cleanup_credentials()

    def _cleanup_credentials(self):
        try:
            keyring.delete_password(TEST_SERVICE, TEST_USER)
        except Exception:
            pass
        try:
            keyring.delete_password("AutoTaskAI_v04_BYOK", TEST_MODEL_PROFILE)
        except Exception:
            pass
        try:
            keyring.delete_password("AutoTaskAI_v06_LMS", f"{TEST_USER}:username")
        except Exception:
            pass
        try:
            keyring.delete_password("AutoTaskAI_v06_LMS", f"{TEST_USER}:password")
        except Exception:
            pass

    def test_vault_01_backend_is_real_os_keyring(self):
        """VAULT-01: Keyring backend is a valid OS keyring (WinVaultKeyring on Windows)."""
        kr = keyring.get_keyring()
        kr_name = type(kr).__name__
        self.assertIsNotNone(kr)
        if sys.platform == "win32":
            self.assertIn("Vault", kr_name, f"Expected Windows Vault backend on win32, got {kr_name}")
        self.assertGreater(kr.priority, 0, "Keyring priority must be greater than 0")

    def test_vault_02_set_and_get_password(self):
        """VAULT-02 & VAULT-03: Directly set password in Windows Vault and retrieve exact match."""
        # 1. Set password in native OS Keyring
        keyring.set_password(TEST_SERVICE, TEST_USER, TEST_SECRET)

        # 2. Retrieve password
        retrieved = keyring.get_password(TEST_SERVICE, TEST_USER)
        self.assertEqual(retrieved, TEST_SECRET, "Retrieved password must match stored probe secret")

    def test_vault_03_delete_and_verify_no_residual(self):
        """VAULT-04 & VAULT-05: Delete password from Windows Vault and assert zero credential residue."""
        # Store probe
        keyring.set_password(TEST_SERVICE, TEST_USER, TEST_SECRET)
        self.assertEqual(keyring.get_password(TEST_SERVICE, TEST_USER), TEST_SECRET)

        # Delete probe
        keyring.delete_password(TEST_SERVICE, TEST_USER)

        # Assert no residue
        post_deletion = keyring.get_password(TEST_SERVICE, TEST_USER)
        self.assertIsNone(post_deletion, "Post-deletion password query must return None (zero residue)")

    def test_vault_04_vault_bridge_check_command(self):
        """VAULT-06: vault_bridge.py check command outputs KEYRING_OK with active backend."""
        res = subprocess.run(
            [sys.executable, BRIDGE_SCRIPT, "check"],
            capture_output=True,
            text=True,
            timeout=8
        )
        self.assertEqual(res.returncode, 0)
        self.assertIn("KEYRING_OK:", res.stdout)
        if sys.platform == "win32":
            self.assertIn("WinVaultKeyring", res.stdout)

    def test_vault_05_vault_bridge_full_lifecycle(self):
        """VAULT-07: vault_bridge.py set-model (via stdin), get-model, and delete-model lifecycle."""
        probe_key = "sk-proj-testkey1234567890abcdef"

        # 1. Set model key via stdin (no secret in process arguments)
        p_set = subprocess.run(
            [sys.executable, BRIDGE_SCRIPT, "set-model", TEST_MODEL_PROFILE],
            input=probe_key,
            capture_output=True,
            text=True,
            timeout=8
        )
        self.assertEqual(p_set.returncode, 0)
        self.assertIn("OK", p_set.stdout)

        # 2. Get model key
        p_get = subprocess.run(
            [sys.executable, BRIDGE_SCRIPT, "get-model", TEST_MODEL_PROFILE],
            capture_output=True,
            text=True,
            timeout=8
        )
        self.assertEqual(p_get.returncode, 0)
        self.assertEqual(p_get.stdout.strip(), probe_key)

        # 3. Delete model key
        p_del = subprocess.run(
            [sys.executable, BRIDGE_SCRIPT, "delete-model", TEST_MODEL_PROFILE],
            capture_output=True,
            text=True,
            timeout=8
        )
        self.assertEqual(p_del.returncode, 0)
        self.assertIn("OK", p_del.stdout)

        # 4. Verify post-deletion get fails
        p_post_get = subprocess.run(
            [sys.executable, BRIDGE_SCRIPT, "get-model", TEST_MODEL_PROFILE],
            capture_output=True,
            text=True,
            timeout=8
        )
        self.assertNotEqual(p_post_get.returncode, 0)
        self.assertIn("Credential not found", p_post_get.stderr)


if __name__ == "__main__":
    unittest.main()
