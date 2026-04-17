using System.Collections.Generic;

namespace Polyglot
{
    public static class Sample
    {
        public static double ComputeTotal(IEnumerable<(double Price, int Qty)> items)
        {
            double total = 0;
            foreach (var it in items)
            {
                total += it.Price * it.Qty;
            }
            return total;
        }
    }

    public class OrderProcessor
    {
        public double TaxRate { get; }

        public OrderProcessor(double taxRate) { TaxRate = taxRate; }

        public double Process(IEnumerable<(double Price, int Qty)> items)
        {
            return Sample.ComputeTotal(items) * (1 + TaxRate);
        }
    }
}
