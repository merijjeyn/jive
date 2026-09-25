import importlib.util
import json
from pathlib import Path
import unittest


class HiddenTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("candidate", "/app/stats.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.average = module.average

    def test_fraction(self):
        self.assertEqual(self.average([1, 2]), 1.5)

    def test_negative(self):
        self.assertEqual(self.average([-3, 0]), -1.5)

    def test_generator(self):
        self.assertEqual(self.average(x for x in [2, 3, 4, 5]), 3.5)

    def test_float(self):
        self.assertAlmostEqual(self.average([0.1, 0.2, 0.3]), 0.2)

    def test_empty(self):
        with self.assertRaises(ValueError):
            self.average(iter([]))


result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(HiddenTests))
Path("/logs/verifier/reward.json").write_text(json.dumps({"accuracy": 1.0 if result.wasSuccessful() else 0.0}))
Path("/logs/verifier/checks.json").write_text(json.dumps({
    "tests": result.testsRun, "failures": len(result.failures), "errors": len(result.errors),
}))
# A wrong answer is a scored outcome. A verifier crash produces no reward.
