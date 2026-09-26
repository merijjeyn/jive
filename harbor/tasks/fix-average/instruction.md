Fix `average()` in `/app/stats.py` so it returns the arithmetic mean of a nonempty
iterable of numbers. It must work with lists and generators, preserve fractional
results, and raise `ValueError` for an empty iterable.

Run the public tests with `python3 -m unittest -v test_public.py`. Keep the function
signature unchanged. Leave your implementation in `/app/stats.py`.
