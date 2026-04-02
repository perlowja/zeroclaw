#!/usr/bin/env python3
"""Tests for zeroclaw-sbase-bridge.py

Tests the bridge's dispatch logic, JSON protocol, and error handling
with a mocked Selenium driver — no browser or seleniumbase required.

Run with:
    python3 -m pytest scripts/browser/test_zeroclaw_sbase_bridge.py -v
    python3 scripts/browser/test_zeroclaw_sbase_bridge.py
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

# ---------------------------------------------------------------------------
# Load the bridge module by file path (hyphenated filename can't be imported
# with a normal `import` statement).
# ---------------------------------------------------------------------------
_SCRIPT_DIR = Path(__file__).parent
_BRIDGE_PATH = _SCRIPT_DIR / "zeroclaw-sbase-bridge.py"
_spec = importlib.util.spec_from_file_location("sbase_bridge", _BRIDGE_PATH)
sbase_bridge = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sbase_bridge)

Bridge = sbase_bridge.Bridge
_ok = sbase_bridge._ok
_err = sbase_bridge._err


# ===================================================================
# Helpers
# ===================================================================


class TestHelpers(unittest.TestCase):
    """Test _ok and _err response helpers."""

    def test_ok_format(self):
        result = _ok({"key": "value"})
        self.assertEqual(result, {"success": True, "data": {"key": "value"}})

    def test_err_format(self):
        result = _err("boom")
        self.assertEqual(result, {"success": False, "error": "boom"})


# ===================================================================
# Dispatch routing
# ===================================================================


class TestDispatchRouting(unittest.TestCase):
    """Test that dispatch() routes to the correct handler."""

    def test_unknown_action(self):
        bridge = Bridge()
        result = bridge.dispatch({"action": "nonexistent"})
        self.assertFalse(result["success"])
        self.assertIn("Unknown action", result["error"])

    def test_empty_action(self):
        bridge = Bridge()
        result = bridge.dispatch({})
        self.assertFalse(result["success"])
        self.assertIn("Unknown action", result["error"])

    def test_all_action_methods_are_routable(self):
        """Every action_* method on Bridge is reachable via dispatch."""
        bridge = Bridge()
        actions = [
            name.replace("action_", "")
            for name in dir(bridge)
            if name.startswith("action_")
        ]
        for action in actions:
            handler = getattr(bridge, f"action_{action}", None)
            self.assertIsNotNone(handler, f"No handler for action '{action}'")


# ===================================================================
# Action handlers (with mocked driver)
# ===================================================================


class TestActionsWithMockedDriver(unittest.TestCase):
    """Test each action handler with a mocked Selenium driver."""

    def setUp(self):
        self.bridge = Bridge()
        self.driver = MagicMock()
        self.bridge._driver = self.driver

    # -- open --

    def test_open_success(self):
        self.driver.current_url = "https://example.com/"
        self.bridge._ensure_driver = MagicMock()
        result = self.bridge.dispatch(
            {"action": "open", "url": "https://example.com"}
        )
        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["url"], "https://example.com/")

    def test_open_missing_url(self):
        result = self.bridge.dispatch({"action": "open"})
        self.assertFalse(result["success"])
        self.assertIn("Missing 'url'", result["error"])

    def test_open_empty_url(self):
        result = self.bridge.dispatch({"action": "open", "url": ""})
        self.assertFalse(result["success"])

    # -- get_title / get_url --

    def test_get_title(self):
        self.driver.title = "Test Page"
        result = self.bridge.dispatch({"action": "get_title"})
        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["output"], "Test Page")

    def test_get_url(self):
        self.driver.current_url = "https://example.com/page"
        result = self.bridge.dispatch({"action": "get_url"})
        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["output"], "https://example.com/page")

    # -- snapshot --

    def test_snapshot(self):
        self.driver.title = "Snapshot Title"
        self.driver.current_url = "https://example.com"
        self.driver.execute_script.return_value = "Visible page text"
        result = self.bridge.dispatch({"action": "snapshot"})
        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["title"], "Snapshot Title")
        self.assertEqual(result["data"]["url"], "https://example.com")
        self.assertEqual(result["data"]["text"], "Visible page text")

    def test_snapshot_truncates_long_text(self):
        self.driver.title = "T"
        self.driver.current_url = "https://x.com"
        self.driver.execute_script.return_value = "A" * 60_000
        result = self.bridge.dispatch({"action": "snapshot"})
        self.assertTrue(result["success"])
        self.assertEqual(len(result["data"]["text"]), 50_000)

    def test_snapshot_handles_no_body(self):
        self.driver.title = "Empty"
        self.driver.current_url = "about:blank"
        self.driver.execute_script.return_value = None
        result = self.bridge.dispatch({"action": "snapshot"})
        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["text"], "")

    # -- click --

    def test_click(self):
        result = self.bridge.dispatch({"action": "click", "selector": "#btn"})
        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["clicked"], "#btn")

    def test_click_missing_selector(self):
        result = self.bridge.dispatch({"action": "click"})
        self.assertFalse(result["success"])
        self.assertIn("Missing 'selector'", result["error"])

    def test_click_uc_fallback(self):
        """When uc_click fails, falls back to regular click."""
        self.driver.uc_click.side_effect = Exception("uc_click failed")
        result = self.bridge.dispatch({"action": "click", "selector": "#btn"})
        self.assertTrue(result["success"])
        self.driver.click.assert_called_once_with("#btn")

    # -- fill --

    def test_fill(self):
        mock_element = MagicMock()
        self.driver.find_element.return_value = mock_element
        result = self.bridge.dispatch(
            {"action": "fill", "selector": "#input", "value": "hello"}
        )
        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["filled"], "#input")
        self.assertEqual(result["data"]["value"], "hello")
        self.driver.find_element.assert_called_once_with("css selector", "#input")
        mock_element.clear.assert_called_once()
        mock_element.send_keys.assert_called_once_with("hello")

    def test_fill_missing_selector(self):
        result = self.bridge.dispatch({"action": "fill", "value": "text"})
        self.assertFalse(result["success"])
        self.assertIn("Missing 'selector'", result["error"])

    # -- type --

    def test_type(self):
        result = self.bridge.dispatch(
            {"action": "type", "selector": "#field", "text": "typed text"}
        )
        self.assertTrue(result["success"])
        self.driver.send_keys.assert_called_once_with("#field", "typed text")

    def test_type_missing_selector(self):
        result = self.bridge.dispatch({"action": "type", "text": "no target"})
        self.assertFalse(result["success"])

    # -- get_text --

    def test_get_text(self):
        self.driver.get_text.return_value = "Element text"
        result = self.bridge.dispatch({"action": "get_text", "selector": "#p"})
        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["output"], "Element text")

    def test_get_text_default_body(self):
        self.driver.get_text.return_value = "Body text"
        result = self.bridge.dispatch({"action": "get_text"})
        self.assertTrue(result["success"])
        self.driver.get_text.assert_called_once_with("body")

    # -- screenshot --

    def test_screenshot(self):
        result = self.bridge.dispatch(
            {"action": "screenshot", "path": "/tmp/shot.png"}
        )
        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["path"], "/tmp/shot.png")
        self.driver.save_screenshot.assert_called_once_with("/tmp/shot.png")

    def test_screenshot_default_path(self):
        result = self.bridge.dispatch({"action": "screenshot"})
        self.assertTrue(result["success"])
        self.assertIn("/tmp/zeroclaw-sbase-", result["data"]["path"])

    # -- wait --

    def test_wait_ms(self):
        result = self.bridge.dispatch({"action": "wait", "ms": 500})
        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["waited_ms"], 500)

    def test_wait_selector(self):
        result = self.bridge.dispatch(
            {"action": "wait", "selector": "#loaded", "ms": 3000}
        )
        self.assertTrue(result["success"])
        self.driver.wait_for_element_visible.assert_called_once_with(
            "#loaded", timeout=3.0
        )

    def test_wait_text(self):
        result = self.bridge.dispatch(
            {"action": "wait", "text": "Done", "ms": 5000}
        )
        self.assertTrue(result["success"])
        self.driver.wait_for_text_visible.assert_called_once_with(
            "Done", timeout=5.0
        )

    def test_wait_no_args(self):
        result = self.bridge.dispatch({"action": "wait"})
        self.assertFalse(result["success"])
        self.assertIn("requires", result["error"])

    # -- press --

    def test_press(self):
        result = self.bridge.dispatch({"action": "press", "key": "Enter"})
        self.assertTrue(result["success"])
        self.driver.press_keys.assert_called_once_with("body", "Enter")

    def test_press_missing_key(self):
        result = self.bridge.dispatch({"action": "press"})
        self.assertFalse(result["success"])

    # -- hover --

    def test_hover(self):
        mock_element = MagicMock()
        self.driver.find_element.return_value = mock_element

        # Mock the selenium ActionChains module (may not be installed)
        mock_ac_mod = MagicMock()
        mock_ac_instance = MagicMock()
        mock_ac_instance.move_to_element.return_value = mock_ac_instance
        mock_ac_mod.ActionChains.return_value = mock_ac_instance

        with patch.dict(
            "sys.modules",
            {
                "selenium": MagicMock(),
                "selenium.webdriver": MagicMock(),
                "selenium.webdriver.common": MagicMock(),
                "selenium.webdriver.common.action_chains": mock_ac_mod,
            },
        ):
            result = self.bridge.dispatch(
                {"action": "hover", "selector": "#link"}
            )

        self.assertTrue(result["success"])
        self.driver.find_element.assert_called_once_with("css selector", "#link")
        mock_ac_instance.move_to_element.assert_called_once_with(mock_element)
        mock_ac_instance.perform.assert_called_once()

    def test_hover_missing_selector(self):
        result = self.bridge.dispatch({"action": "hover"})
        self.assertFalse(result["success"])

    # -- scroll --

    def test_scroll_down(self):
        result = self.bridge.dispatch(
            {"action": "scroll", "direction": "down", "pixels": 500}
        )
        self.assertTrue(result["success"])
        self.driver.execute_script.assert_called_once_with(
            "window.scrollBy(0, 500);"
        )

    def test_scroll_up(self):
        result = self.bridge.dispatch({"action": "scroll", "direction": "up"})
        self.assertTrue(result["success"])
        self.driver.execute_script.assert_called_once_with(
            "window.scrollBy(0, -300);"
        )

    def test_scroll_left(self):
        result = self.bridge.dispatch(
            {"action": "scroll", "direction": "left", "pixels": 200}
        )
        self.assertTrue(result["success"])
        self.driver.execute_script.assert_called_once_with(
            "window.scrollBy(-200, 0);"
        )

    def test_scroll_right(self):
        result = self.bridge.dispatch(
            {"action": "scroll", "direction": "right", "pixels": 200}
        )
        self.assertTrue(result["success"])
        self.driver.execute_script.assert_called_once_with(
            "window.scrollBy(200, 0);"
        )

    # -- is_visible --

    def test_is_visible_true(self):
        self.driver.is_element_visible.return_value = True
        result = self.bridge.dispatch({"action": "is_visible", "selector": "#el"})
        self.assertTrue(result["success"])
        self.assertTrue(result["data"]["visible"])

    def test_is_visible_false(self):
        self.driver.is_element_visible.return_value = False
        result = self.bridge.dispatch(
            {"action": "is_visible", "selector": "#hidden"}
        )
        self.assertTrue(result["success"])
        self.assertFalse(result["data"]["visible"])

    def test_is_visible_missing_selector(self):
        result = self.bridge.dispatch({"action": "is_visible"})
        self.assertFalse(result["success"])

    # -- close --

    def test_close_with_driver(self):
        result = self.bridge.dispatch({"action": "close"})
        self.assertTrue(result["success"])
        self.assertTrue(result["data"]["closed"])
        self.driver.quit.assert_called_once()
        self.assertIsNone(self.bridge._driver)

    def test_close_without_driver(self):
        bridge = Bridge()
        result = bridge.dispatch({"action": "close"})
        self.assertTrue(result["success"])

    def test_close_swallows_quit_exception(self):
        self.driver.quit.side_effect = Exception("already closed")
        result = self.bridge.dispatch({"action": "close"})
        self.assertTrue(result["success"])


# ===================================================================
# Driver-not-started errors
# ===================================================================


class TestDriverNotStarted(unittest.TestCase):
    """Actions that need a driver raise RuntimeError before it's started."""

    def test_get_title(self):
        bridge = Bridge()
        with self.assertRaises(RuntimeError) as ctx:
            bridge.dispatch({"action": "get_title"})
        self.assertIn("Browser not started", str(ctx.exception))

    def test_snapshot(self):
        bridge = Bridge()
        with self.assertRaises(RuntimeError) as ctx:
            bridge.dispatch({"action": "snapshot"})
        self.assertIn("Browser not started", str(ctx.exception))

    def test_click(self):
        bridge = Bridge()
        with self.assertRaises(RuntimeError) as ctx:
            bridge.dispatch({"action": "click", "selector": "#btn"})
        self.assertIn("Browser not started", str(ctx.exception))


# ===================================================================
# JSON protocol round-trip
# ===================================================================


class TestProtocol(unittest.TestCase):
    """Verify response shapes match the Rust AgentBrowserResponse schema."""

    def test_ok_json_roundtrip(self):
        result = _ok({"url": "https://example.com"})
        parsed = json.loads(json.dumps(result))
        self.assertTrue(parsed["success"])
        self.assertEqual(parsed["data"]["url"], "https://example.com")

    def test_err_json_roundtrip(self):
        result = _err("something broke")
        parsed = json.loads(json.dumps(result))
        self.assertFalse(parsed["success"])
        self.assertEqual(parsed["error"], "something broke")

    def test_response_matches_rust_schema(self):
        """Response shape: { success: bool, data: Option<Value>, error: Option<String> }"""
        ok = _ok({"output": "text"})
        self.assertIn("success", ok)
        self.assertIn("data", ok)
        self.assertIsInstance(ok["success"], bool)
        self.assertIsInstance(ok["data"], dict)

        err = _err("msg")
        self.assertIn("success", err)
        self.assertIn("error", err)
        self.assertIsInstance(err["success"], bool)
        self.assertIsInstance(err["error"], str)


# ===================================================================
# Subprocess REPL integration test
# ===================================================================


class TestSubprocessProtocol(unittest.TestCase):
    """Test the bridge as a real subprocess, verifying the stdin/stdout
    JSON protocol without needing seleniumbase (by sending only actions
    that don't require a driver, or by catching expected errors)."""

    def test_ready_signal_and_close(self):
        """Bridge emits ready signal on startup and handles close."""
        proc = subprocess.Popen(
            [sys.executable, "-u", str(_BRIDGE_PATH)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            # Read ready signal
            ready = json.loads(proc.stdout.readline())
            self.assertTrue(ready["success"])
            self.assertEqual(ready["data"]["status"], "ready")

            # Send close (doesn't need a driver)
            proc.stdin.write(json.dumps({"action": "close"}) + "\n")
            proc.stdin.flush()
            resp = json.loads(proc.stdout.readline())
            self.assertTrue(resp["success"])
            self.assertTrue(resp["data"]["closed"])

            proc.wait(timeout=5)
            self.assertEqual(proc.returncode, 0)
        finally:
            proc.terminate()

    def test_unknown_action_via_subprocess(self):
        """Unknown actions return an error response (no crash)."""
        proc = subprocess.Popen(
            [sys.executable, "-u", str(_BRIDGE_PATH)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            # Skip ready signal
            proc.stdout.readline()

            # Send unknown action
            proc.stdin.write(json.dumps({"action": "bogus"}) + "\n")
            proc.stdin.flush()
            resp = json.loads(proc.stdout.readline())
            self.assertFalse(resp["success"])
            self.assertIn("Unknown action", resp["error"])

            # Clean up
            proc.stdin.write(json.dumps({"action": "close"}) + "\n")
            proc.stdin.flush()
            proc.stdout.readline()
            proc.wait(timeout=5)
        finally:
            proc.terminate()

    def test_invalid_json_via_subprocess(self):
        """Invalid JSON input returns an error (no crash)."""
        proc = subprocess.Popen(
            [sys.executable, "-u", str(_BRIDGE_PATH)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            proc.stdout.readline()  # ready

            proc.stdin.write("not valid json\n")
            proc.stdin.flush()
            resp = json.loads(proc.stdout.readline())
            self.assertFalse(resp["success"])
            self.assertIn("Invalid JSON", resp["error"])

            proc.stdin.write(json.dumps({"action": "close"}) + "\n")
            proc.stdin.flush()
            proc.stdout.readline()
            proc.wait(timeout=5)
        finally:
            proc.terminate()


if __name__ == "__main__":
    unittest.main()
