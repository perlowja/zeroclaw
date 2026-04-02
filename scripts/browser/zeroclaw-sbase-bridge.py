#!/usr/bin/env python3
"""ZeroClaw SeleniumBase UC Mode Bridge.

Accepts JSON commands on stdin (one per line), executes them via
SeleniumBase's Undetected Chrome (UC) mode, and returns JSON responses
on stdout.  Designed to be spawned as a long-lived subprocess by the
Rust BrowserTool backend.

Protocol
--------
Request  (one JSON object per line on stdin):
    {"action": "open", "url": "https://example.com"}
    {"action": "snapshot"}
    {"action": "click", "selector": "#btn"}
    {"action": "fill", "selector": "#input", "value": "text"}
    {"action": "type", "selector": "#input", "text": "hello"}
    {"action": "get_text", "selector": "body"}
    {"action": "get_title"}
    {"action": "get_url"}
    {"action": "screenshot", "path": "/tmp/shot.png"}
    {"action": "wait", "selector": "#el", "ms": 5000}
    {"action": "press", "key": "Enter"}
    {"action": "hover", "selector": "#el"}
    {"action": "scroll", "direction": "down", "pixels": 300}
    {"action": "is_visible", "selector": "#el"}
    {"action": "close"}

Response (one JSON object per line on stdout):
    {"success": true, "data": {"output": "..."}}
    {"success": false, "error": "..."}
"""

from __future__ import annotations

import json
import os
import platform
import sys
import time
import traceback
from typing import Any

# ---------------------------------------------------------------------------
# Detect display environment
# ---------------------------------------------------------------------------

_IS_MAC = platform.system() == "Darwin"
_HAS_DISPLAY = _IS_MAC or bool(os.environ.get("DISPLAY"))


def _create_driver(
    reconnect_timeout: int = 4,
    extra_driver_args: list[str] | None = None,
) -> Any:
    """Create a SeleniumBase UC-mode driver appropriate for the environment."""
    from seleniumbase import Driver

    kwargs: dict[str, Any] = {"uc": True}

    if extra_driver_args:
        for arg in extra_driver_args:
            if "=" in arg:
                k, v = arg.split("=", 1)
                # Attempt numeric conversion
                try:
                    v = int(v)
                except ValueError:
                    try:
                        v = float(v)
                    except ValueError:
                        if v.lower() in ("true", "false"):
                            v = v.lower() == "true"
                kwargs[k] = v

    if _HAS_DISPLAY:
        kwargs["headless"] = False
    else:
        # Linux server without DISPLAY — use xvfb for invisible headed mode
        kwargs["headless"] = False
        kwargs["xvfb"] = True

    return Driver(**kwargs), reconnect_timeout


# ---------------------------------------------------------------------------
# Action handlers
# ---------------------------------------------------------------------------


class Bridge:
    """Manages a SeleniumBase UC-mode browser session."""

    def __init__(
        self,
        reconnect_timeout: int = 4,
        extra_driver_args: list[str] | None = None,
    ) -> None:
        self._driver: Any = None
        self._reconnect_timeout = reconnect_timeout
        self._extra_driver_args = extra_driver_args or []

    @property
    def driver(self) -> Any:
        if self._driver is None:
            raise RuntimeError("Browser not started. Send an 'open' action first.")
        return self._driver

    def _ensure_driver(self) -> None:
        if self._driver is None:
            self._driver, self._reconnect_timeout = _create_driver(
                reconnect_timeout=self._reconnect_timeout,
                extra_driver_args=self._extra_driver_args,
            )

    # -- actions -----------------------------------------------------------

    def action_open(self, cmd: dict) -> dict:
        url = cmd.get("url", "")
        if not url:
            return _err("Missing 'url' for open action")
        self._ensure_driver()
        try:
            self._driver.uc_open_with_reconnect(url, self._reconnect_timeout)
        except Exception:
            # Fallback to regular get
            self._driver.get(url)
        return _ok({"url": self._driver.current_url})

    def action_snapshot(self, cmd: dict) -> dict:
        driver = self.driver
        # Get page source as a text snapshot (accessibility tree is not
        # available through selenium; return the page text content instead).
        try:
            text = driver.execute_script(
                "return document.body ? document.body.innerText : '';"
            )
            title = driver.title
            url = driver.current_url
            return _ok({
                "title": title,
                "url": url,
                "text": text[:50000] if text else "",
            })
        except Exception as exc:
            return _err(str(exc))

    def action_click(self, cmd: dict) -> dict:
        selector = cmd.get("selector", "")
        if not selector:
            return _err("Missing 'selector' for click action")
        driver = self.driver
        try:
            driver.uc_click(selector)
        except Exception:
            # Fallback to regular click
            try:
                driver.click(selector)
            except Exception as exc:
                return _err(f"Click failed: {exc}")
        return _ok({"clicked": selector})

    def action_fill(self, cmd: dict) -> dict:
        selector = cmd.get("selector", "")
        value = cmd.get("value", "")
        if not selector:
            return _err("Missing 'selector' for fill action")
        driver = self.driver
        try:
            # Use Selenium element API directly: clear field, then type value.
            # SeleniumBase's Driver.type() adds "\n" by default which submits
            # forms, so we use the lower-level element API instead.
            element = driver.find_element("css selector", selector)
            element.clear()
            element.send_keys(value)
        except Exception as exc:
            return _err(f"Fill failed: {exc}")
        return _ok({"filled": selector, "value": value})

    def action_type(self, cmd: dict) -> dict:
        selector = cmd.get("selector", "")
        text = cmd.get("text", "")
        if not selector:
            return _err("Missing 'selector' for type action")
        driver = self.driver
        try:
            driver.send_keys(selector, text)
        except Exception as exc:
            return _err(f"Type failed: {exc}")
        return _ok({"typed": selector, "text": text})

    def action_get_text(self, cmd: dict) -> dict:
        selector = cmd.get("selector", "body")
        driver = self.driver
        try:
            text = driver.get_text(selector)
            return _ok({"output": text})
        except Exception as exc:
            return _err(f"get_text failed: {exc}")

    def action_get_title(self, _cmd: dict) -> dict:
        return _ok({"output": self.driver.title})

    def action_get_url(self, _cmd: dict) -> dict:
        return _ok({"output": self.driver.current_url})

    def action_screenshot(self, cmd: dict) -> dict:
        path = cmd.get("path", f"/tmp/zeroclaw-sbase-{int(time.time())}.png")
        driver = self.driver
        try:
            driver.save_screenshot(path)
            return _ok({"path": path})
        except Exception as exc:
            return _err(f"Screenshot failed: {exc}")

    def action_wait(self, cmd: dict) -> dict:
        selector = cmd.get("selector")
        ms = cmd.get("ms")
        text = cmd.get("text")
        driver = self.driver
        try:
            if selector:
                timeout = (ms or 10000) / 1000.0
                driver.wait_for_element_visible(selector, timeout=timeout)
                return _ok({"waited_for": selector})
            if text:
                timeout = (ms or 10000) / 1000.0
                driver.wait_for_text_visible(text, timeout=timeout)
                return _ok({"waited_for_text": text})
            if ms:
                time.sleep(ms / 1000.0)
                return _ok({"waited_ms": ms})
            return _err("Wait requires 'selector', 'text', or 'ms'")
        except Exception as exc:
            return _err(f"Wait failed: {exc}")

    def action_press(self, cmd: dict) -> dict:
        key = cmd.get("key", "")
        if not key:
            return _err("Missing 'key' for press action")
        driver = self.driver
        try:
            driver.press_keys("body", key)
            return _ok({"pressed": key})
        except Exception as exc:
            return _err(f"Press failed: {exc}")

    def action_hover(self, cmd: dict) -> dict:
        selector = cmd.get("selector", "")
        if not selector:
            return _err("Missing 'selector' for hover action")
        driver = self.driver
        try:
            from selenium.webdriver.common.action_chains import ActionChains

            element = driver.find_element("css selector", selector)
            ActionChains(driver).move_to_element(element).perform()
            return _ok({"hovered": selector})
        except Exception as exc:
            return _err(f"Hover failed: {exc}")

    def action_scroll(self, cmd: dict) -> dict:
        direction = cmd.get("direction", "down")
        pixels = cmd.get("pixels", 300)
        driver = self.driver
        try:
            if direction == "down":
                driver.execute_script(f"window.scrollBy(0, {pixels});")
            elif direction == "up":
                driver.execute_script(f"window.scrollBy(0, -{pixels});")
            elif direction == "right":
                driver.execute_script(f"window.scrollBy({pixels}, 0);")
            elif direction == "left":
                driver.execute_script(f"window.scrollBy(-{pixels}, 0);")
            return _ok({"scrolled": direction, "pixels": pixels})
        except Exception as exc:
            return _err(f"Scroll failed: {exc}")

    def action_is_visible(self, cmd: dict) -> dict:
        selector = cmd.get("selector", "")
        if not selector:
            return _err("Missing 'selector' for is_visible action")
        driver = self.driver
        try:
            visible = driver.is_element_visible(selector)
            return _ok({"visible": visible, "selector": selector})
        except Exception as exc:
            return _err(f"is_visible failed: {exc}")

    def action_close(self, _cmd: dict) -> dict:
        if self._driver is not None:
            try:
                self._driver.quit()
            except Exception:
                pass
            self._driver = None
        return _ok({"closed": True})

    def dispatch(self, cmd: dict) -> dict:
        action = cmd.get("action", "")
        handler = getattr(self, f"action_{action}", None)
        if handler is None:
            return _err(f"Unknown action: {action}")
        return handler(cmd)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _ok(data: dict) -> dict:
    return {"success": True, "data": data}


def _err(msg: str) -> dict:
    return {"success": False, "error": msg}


def _write_response(resp: dict) -> None:
    sys.stdout.write(json.dumps(resp) + "\n")
    sys.stdout.flush()


# ---------------------------------------------------------------------------
# Main REPL loop
# ---------------------------------------------------------------------------


def main() -> None:
    reconnect_timeout = int(os.environ.get("ZEROCLAW_SBASE_RECONNECT_TIMEOUT", "4"))
    extra_args_raw = os.environ.get("ZEROCLAW_SBASE_EXTRA_ARGS", "")
    extra_args = [a.strip() for a in extra_args_raw.split(",") if a.strip()] if extra_args_raw else []

    bridge = Bridge(
        reconnect_timeout=reconnect_timeout,
        extra_driver_args=extra_args,
    )

    # Signal readiness
    _write_response({"success": True, "data": {"status": "ready"}})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError as exc:
            _write_response(_err(f"Invalid JSON: {exc}"))
            continue

        try:
            resp = bridge.dispatch(cmd)
        except Exception:
            resp = _err(traceback.format_exc())

        _write_response(resp)

        # Exit after close
        if cmd.get("action") == "close":
            break

    # Clean shutdown
    bridge.action_close({})


if __name__ == "__main__":
    main()
