package polyglot

type Item struct {
	Price float64
	Qty   int
}

func ComputeTotal(items []Item) float64 {
	var total float64
	for _, it := range items {
		total += it.Price * float64(it.Qty)
	}
	return total
}

type OrderProcessor struct {
	TaxRate float64
}

func (o OrderProcessor) Process(items []Item) float64 {
	return ComputeTotal(items) * (1 + o.TaxRate)
}
