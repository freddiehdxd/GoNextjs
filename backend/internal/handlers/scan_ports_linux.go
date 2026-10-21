//go:build linux

package handlers

import (
	"bufio"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// listeningPorts returns the TCP ports on which pid or any of its descendants
// is listening, ascending. PM2 often runs `npm start`, so the socket usually
// belongs to a grandchild rather than the PID PM2 reports.
func listeningPorts(pid int) []int {
	if pid <= 0 {
		return nil
	}
	inodes := make(map[string]bool)
	for _, p := range processTree(pid) {
		for _, ino := range socketInodes(p) {
			inodes[ino] = true
		}
	}
	if len(inodes) == 0 {
		return nil
	}
	seen := make(map[int]bool)
	var ports []int
	for _, table := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		for ino, port := range listenSockets(table) {
			if inodes[ino] && !seen[port] {
				seen[port] = true
				ports = append(ports, port)
			}
		}
	}
	sort.Ints(ports)
	return ports
}

// processTree returns root followed by all of its descendants.
func processTree(root int) []int {
	children := make(map[int][]int)
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return []int{root}
	}
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		data, err := os.ReadFile(filepath.Join("/proc", e.Name(), "stat"))
		if err != nil {
			continue
		}
		// pid (comm) state ppid ... — comm may contain spaces, so split after ")".
		s := string(data)
		closeIdx := strings.LastIndex(s, ")")
		if closeIdx < 0 {
			continue
		}
		fields := strings.Fields(s[closeIdx+1:])
		if len(fields) < 2 {
			continue
		}
		ppid, err := strconv.Atoi(fields[1])
		if err != nil {
			continue
		}
		children[ppid] = append(children[ppid], pid)
	}
	tree := []int{root}
	for i := 0; i < len(tree); i++ {
		tree = append(tree, children[tree[i]]...)
	}
	return tree
}

// socketInodes returns the socket inodes pid holds open.
func socketInodes(pid int) []string {
	fdDir := filepath.Join("/proc", strconv.Itoa(pid), "fd")
	entries, err := os.ReadDir(fdDir)
	if err != nil {
		return nil
	}
	var inodes []string
	for _, e := range entries {
		target, err := os.Readlink(filepath.Join(fdDir, e.Name()))
		if err != nil {
			continue
		}
		if strings.HasPrefix(target, "socket:[") && strings.HasSuffix(target, "]") {
			inodes = append(inodes, target[len("socket:["):len(target)-1])
		}
	}
	return inodes
}

// listenSockets parses a /proc/net/tcp-style table into inode → local port
// for sockets in the LISTEN state.
func listenSockets(path string) map[string]int {
	out := make(map[string]int)
	f, err := os.Open(path)
	if err != nil {
		return out
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Scan() // header
	for sc.Scan() {
		// sl local_address rem_address st tx:rx tr:when retrnsmt uid timeout inode
		fields := strings.Fields(sc.Text())
		if len(fields) < 10 || fields[3] != "0A" {
			continue
		}
		idx := strings.LastIndex(fields[1], ":")
		if idx < 0 {
			continue
		}
		port, err := strconv.ParseInt(fields[1][idx+1:], 16, 32)
		if err != nil {
			continue
		}
		out[fields[9]] = int(port)
	}
	return out
}
