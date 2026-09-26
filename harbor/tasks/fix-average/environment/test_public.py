import unittest
from stats import average


class AverageTests(unittest.TestCase):
    def test_whole_number(self):
        self.assertEqual(average([2, 4]), 3)

    def test_fraction(self):
        self.assertEqual(average([1, 2]), 1.5)


if __name__ == "__main__":
    unittest.main()
