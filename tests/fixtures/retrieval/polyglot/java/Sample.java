package polyglot;

import java.util.List;
import java.util.Map;

public class Sample {
    public static double computeTotal(List<Map<String, Number>> items) {
        double total = 0.0;
        for (Map<String, Number> it : items) {
            double price = it.getOrDefault("price", 0).doubleValue();
            double qty = it.getOrDefault("qty", 1).doubleValue();
            total += price * qty;
        }
        return total;
    }
}

class OrderProcessor {
    private final double taxRate;

    public OrderProcessor(double taxRate) {
        this.taxRate = taxRate;
    }

    public double process(List<Map<String, Number>> items) {
        return Sample.computeTotal(items) * (1 + taxRate);
    }
}
