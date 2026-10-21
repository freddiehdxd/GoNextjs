//go:build linux

package handlers

import (
	"net"
	"os"
	"testing"
)

func TestListeningPorts(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	want := ln.Addr().(*net.TCPAddr).Port

	for _, p := range listeningPorts(os.Getpid()) {
		if p == want {
			return
		}
	}
	t.Errorf("listeningPorts(self) does not include %d", want)
}

func TestListeningPortsBadPid(t *testing.T) {
	if got := listeningPorts(0); got != nil {
		t.Errorf("got %v, want nil", got)
	}
}
