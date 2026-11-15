package main

import "errors"

// errString 让 store.go 能直接返回业务错误（避免到处 fmt.Errorf）。
func errString(msg string) error { return errors.New(msg) }
