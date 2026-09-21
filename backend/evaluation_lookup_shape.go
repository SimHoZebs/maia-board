package main

func (r *lookupRequest) UnmarshalJSON(data []byte) error {
	type plain lookupRequest
	decoded, err := decodeStrict[plain](data, []string{"engine", "fen", "ply"}, nil)
	if err != nil {
		return err
	}
	*r = lookupRequest(decoded)
	return nil
}

func (b *batchLine) UnmarshalJSON(data []byte) error {
	type plain batchLine
	decoded, err := decodeStrict[plain](data, []string{"initial_fen", "moves"}, nil)
	if err != nil {
		return err
	}
	*b = batchLine(decoded)
	return nil
}
