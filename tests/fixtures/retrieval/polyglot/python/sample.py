"""Synthetic polyglot fixture for retrieval tests."""


def compute_total(items):
    total = 0
    for item in items:
        total += item.get("price", 0) * item.get("qty", 1)
    return total


class OrderProcessor:
    def __init__(self, tax_rate=0.0):
        self.tax_rate = tax_rate

    def process(self, items):
        subtotal = compute_total(items)
        return subtotal * (1 + self.tax_rate)
