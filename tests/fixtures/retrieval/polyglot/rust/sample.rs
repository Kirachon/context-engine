pub struct Item {
    pub price: f64,
    pub qty: u32,
}

pub fn compute_total(items: &[Item]) -> f64 {
    let mut total = 0.0;
    for it in items {
        total += it.price * it.qty as f64;
    }
    total
}

pub struct OrderProcessor {
    pub tax_rate: f64,
}

impl OrderProcessor {
    pub fn process(&self, items: &[Item]) -> f64 {
        compute_total(items) * (1.0 + self.tax_rate)
    }
}
