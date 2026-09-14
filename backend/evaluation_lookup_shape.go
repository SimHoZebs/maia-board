package main

func (r *lookupRequest) UnmarshalJSON(data []byte) error {
	type plain lookupRequest
	decoded, err := decodeStrict[plain](data, []string{"engine", "fen", "initial_fen", "moves"}, nil)
	if err != nil {
		return err
	}
	*r = lookupRequest(decoded)
	return nil
}
