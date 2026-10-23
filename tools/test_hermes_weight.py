import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import hermes_weight as hw  # noqa: E402

PS = "\n".join([
    "  484     1 330000 3592:41.01 /System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer -daemon",
    "50470     1 250000 7:01.22 /Users/x/.hermes/hermes-agent/apps/desktop/release/mac-arm64/Hermes.app/Contents/MacOS/Hermes",
    "50476 50470 130000 242:53.52 /Users/x/.hermes/hermes-agent/apps/desktop/release/mac-arm64/Hermes.app/Contents/Frameworks/Hermes Helper.app/Contents/MacOS/Hermes Helper --type=gpu-process",
    "55749 50470 580000 119:04.60 /Users/x/.hermes/tools/python3 -I -c import os serve --host 127.0.0.1 --port 0",
    "27605 27599 320000 46:47.30 /Users/x/.hermes/tools/python3 -I -c import os gateway run --external-supervisor",
    "47755 27605 230000 0:12.00 /Users/x/.hermes/tools/python3 -m hermes_cli.main -p web-dev --cli --accept-hooks chat -q work kanban task t_1",
    "47800 47755  20000 0:01.00 /bin/zsh -c npm test",
    "60000     1  60000 0:01.00 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
    "60001 60000 120000 0:02.50 /Users/x/.hermes/tools/python3 -I -c import os -p noe --cli",
])


class HermesWeightTest(unittest.TestCase):
    def test_parse_cputime(self):
        self.assertEqual(hw.parse_cputime("0:12.00"), 12.0)
        self.assertAlmostEqual(hw.parse_cputime("339:25.67"), 20365.67, places=2)
        self.assertAlmostEqual(hw.parse_cputime("1:02:03.5"), 3723.5)
        self.assertEqual(hw.parse_cputime("2-00:00:01"), 172801.0)

    def test_parse_ps_keeps_spaces_in_command(self):
        s = hw.parse_ps(PS)
        self.assertEqual(len(s), 9)
        self.assertEqual(s[50476]["ppid"], 50470)
        self.assertIn("Hermes Helper.app", s[50476]["cmd"])
        self.assertTrue(s[50476]["cmd"].endswith("--type=gpu-process"))
        self.assertEqual(s[484]["rss_kb"], 330000)

    def test_classify(self):
        g = hw.classify(hw.parse_ps(PS), 27605)
        self.assertEqual(g["desktop_ui"], {50470, 50476})
        self.assertEqual(g["desktop_backend"], {55749})
        self.assertEqual(g["gateway"], {27605})
        self.assertEqual(g["kanban_workers"], {47755, 47800})
        self.assertEqual(g["terminal_clients"], {60001})
        self.assertEqual(g["terminal_apps"], {60000})
        self.assertEqual(g["windowserver"], {484})

    def test_group_cpu_percent_counts_new_processes_fully(self):
        s0 = hw.parse_ps(PS)
        s1 = {pid: dict(p) for pid, p in s0.items()}
        s1[50476]["cpu_s"] += 6.0
        s1[99999] = {"ppid": 50470, "rss_kb": 1000, "cpu_s": 3.0,
                     "cmd": "/x/Hermes.app/Contents/Frameworks/Hermes Helper.app/Contents/MacOS/Hermes Helper --type=renderer"}
        cpu = hw.group_cpu_percent(s0, s1, hw.classify(s1, 27605), 60.0)
        self.assertEqual(cpu["desktop_ui"], 15.0)  # (6 + 3) / 60
        self.assertEqual(cpu["gateway"], 0.0)

    def test_startup_detects_ready_and_cleans_up(self):
        cmd = [sys.executable, "-c", "import time; print('Session: weight-test-42', flush=True); time.sleep(60)"]
        r = hw.startup("unit", cmd, ready="Session:", timeout=10, hold=1)
        self.assertIsNotNone(r["ready_s"])
        self.assertLess(r["ready_s"], 5)
        self.assertGreater(r["client_rss_mb"], 0)
        self.assertEqual(r["new_runtimes"], [])
        self.assertFalse(any("weight-test-42" in p["cmd"] for p in hw.snapshot().values()))


if __name__ == "__main__":
    unittest.main()
