//go:build !linux

package handlers

// listeningPorts is only implemented on Linux, where /proc exposes sockets.
func listeningPorts(pid int) []int { return nil }
