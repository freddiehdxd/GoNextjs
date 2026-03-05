package handlers

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"

	"panel-backend/internal/config"
	"panel-backend/internal/middleware"
	"panel-backend/internal/models"
	"panel-backend/internal/services"
)

const (
	collectInterval = 2 * time.Second
	historySize     = 60 // 60 data points = 2 minutes at 2s interval
	topProcessCount = 5
)

// StatsHandler handles system stats with background collection and WebSocket push
type StatsHandler struct {
	cfg    *config.Config
	pm2    *services.PM2
	mu     sync.RWMutex
	cached *models.Stats

	// Previous readings for delta calculations
	prevCPU     cpuTimes
	prevPerCore []cpuTimes
	prevNet     netCounters
	prevDiskIO  diskIOCounters
	prevTime    time.Time

	// Slow-poll cached data (processes + PM2 apps, refreshed every 10s)
	slowTick     int
	cachedProcs  []models.ProcessStats
	cachedApps   models.AppsStats

	// History ring buffer
	history   [historySize]historyPoint
	historyIdx int
	historyLen int

	// WebSocket clients
	clientsMu sync.Mutex
	clients   map[*websocket.Conn]struct{}
	upgrader  websocket.Upgrader

	// Total memory for process % calculation
	totalMem int64
}

type cpuTimes struct {
	user, nice, system, idle, iowait, irq, softirq, steal uint64
}

type netCounters struct {
	rxBytes int64
	txBytes int64
	iface   string
}

type diskIOCounters struct {
	readBytes  int64
	writeBytes int64
	device     string
}

type historyPoint struct {
	timestamp int64
	cpu       float64
	memory    float64
	diskRead  int64
	diskWrite int64
	netRx     int64
	netTx     int64
}

// NewStatsHandler creates a new stats handler and starts background collection
func NewStatsHandler(pm2 *services.PM2, cfg *config.Config) *StatsHandler {
	h := &StatsHandler{
		cfg:     cfg,
		pm2:     pm2,
		clients: make(map[*websocket.Conn]struct{}),
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				return true // behind NGINX, always local
			},
			ReadBufferSize:  1024,
			WriteBufferSize: 4096,
		},
	}

	// Initial readings
	h.prevCPU = readCPUTimes()
	h.prevPerCore = readPerCoreTimes()
	h.prevNet = readNetCounters()
	h.prevDiskIO = readDiskIOCounters()
	h.prevTime = time.Now()
	h.totalMem = readTotalMemory()

	// Start background collector
	go h.collect()

	return h
}

// Get handles GET /api/stats (HTTP polling fallback)
func (h *StatsHandler) Get(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	stats := h.cached
	h.mu.RUnlock()

	if stats == nil {
		Success(w, nil)
		return
	}

	Success(w, stats)
}

// WebSocket handles GET /api/stats/ws — pushes live stats every 2s
func (h *StatsHandler) WebSocket(w http.ResponseWriter, r *http.Request) {
	// Verify JWT from query param or cookie
	tokenStr := r.URL.Query().Get("token")
	if tokenStr == "" {
		if cookie, err := r.Cookie("panel_token"); err == nil {
			tokenStr = cookie.Value
		}
	}
	if tokenStr == "" {
		http.Error(w, "Not authenticated", http.StatusUnauthorized)
		return
	}
	if !middleware.ValidateToken(tokenStr, h.cfg.JWTSecret) {
		http.Error(w, "Invalid token", http.StatusUnauthorized)
		return
	}

	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade error: %v", err)
		return
	}

	h.clientsMu.Lock()
	h.clients[conn] = struct{}{}
	h.clientsMu.Unlock()

	// Send current stats immediately
	h.mu.RLock()
	live := h.buildLiveStats()
	h.mu.RUnlock()
	if data, err := json.Marshal(live); err == nil {
		conn.WriteMessage(websocket.TextMessage, data)
	}

	// Read pump (handles pong and close)
	go func() {
		defer func() {
			h.clientsMu.Lock()
			delete(h.clients, conn)
			h.clientsMu.Unlock()
			conn.Close()
		}()
		conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		conn.SetPongHandler(func(string) error {
			conn.SetReadDeadline(time.Now().Add(60 * time.Second))
			return nil
		})
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				break
			}
		}
	}()
}

// collect runs every 2 seconds to gather system stats
func (h *StatsHandler) collect() {
	// Small initial delay
	time.Sleep(500 * time.Millisecond)
	h.doCollect()

	ticker := time.NewTicker(collectInterval)
	defer ticker.Stop()

	pingTicker := time.NewTicker(30 * time.Second)
	defer pingTicker.Stop()

	for {
		select {
		case <-ticker.C:
			h.doCollect()
			h.broadcast()
		case <-pingTicker.C:
			h.pingClients()
		}
	}
}

func (h *StatsHandler) doCollect() {
	now := time.Now()
	elapsed := now.Sub(h.prevTime).Seconds()
	if elapsed < 0.1 {
		elapsed = 1
	}

	stats := &models.Stats{}

	// ---- Fast path: lightweight /proc reads every 2s ----

	// CPU (aggregate)
	currentCPU := readCPUTimes()
	stats.CPU = h.calculateCPU(currentCPU)

	// Per-core CPU
	currentPerCore := readPerCoreTimes()
	stats.CPU.PerCore = h.calculatePerCore(currentPerCore)

	// Memory
	stats.Memory = readMemory()

	// Disk
	stats.Disk = readDisk()

	// Network I/O
	currentNet := readNetCounters()
	stats.Network = models.NetworkStats{
		RxBytesPerSec: int64(float64(currentNet.rxBytes-h.prevNet.rxBytes) / elapsed),
		TxBytesPerSec: int64(float64(currentNet.txBytes-h.prevNet.txBytes) / elapsed),
		RxTotal:       currentNet.rxBytes,
		TxTotal:       currentNet.txBytes,
		Interface:     currentNet.iface,
	}
	if stats.Network.RxBytesPerSec < 0 {
		stats.Network.RxBytesPerSec = 0
	}
	if stats.Network.TxBytesPerSec < 0 {
		stats.Network.TxBytesPerSec = 0
	}

	// Disk I/O
	currentDiskIO := readDiskIOCounters()
	stats.DiskIO = models.DiskIOStats{
		ReadBytesPerSec:  int64(float64(currentDiskIO.readBytes-h.prevDiskIO.readBytes) / elapsed),
		WriteBytesPerSec: int64(float64(currentDiskIO.writeBytes-h.prevDiskIO.writeBytes) / elapsed),
		ReadTotal:        currentDiskIO.readBytes,
		WriteTotal:       currentDiskIO.writeBytes,
		Device:           currentDiskIO.device,
	}
	if stats.DiskIO.ReadBytesPerSec < 0 {
		stats.DiskIO.ReadBytesPerSec = 0
	}
	if stats.DiskIO.WriteBytesPerSec < 0 {
		stats.DiskIO.WriteBytesPerSec = 0
	}

	// System info
	stats.System = readSystem()

	// ---- Slow path: expensive ops every 5th tick (10s) ----
	h.slowTick++
	if h.slowTick >= 5 {
		h.slowTick = 0

		// Top processes (iterates all /proc/[pid]/)
		h.cachedProcs = readTopProcesses(h.totalMem)

		// PM2 list (spawns pm2 jlist subprocess)
		pm2List, err := h.pm2.List()
		if err == nil {
			running := 0
			stopped := 0
			appList := make([]map[string]interface{}, 0, len(pm2List))
			for _, p := range pm2List {
				if p.Status == "online" {
					running++
				} else {
					stopped++
				}
				appList = append(appList, map[string]interface{}{
					"name":   p.Name,
					"status": p.Status,
					"cpu":    p.CPU,
					"memory": p.Memory,
					"uptime": p.Uptime,
				})
			}
			h.cachedApps = models.AppsStats{
				Total:   len(pm2List),
				Running: running,
				Stopped: stopped,
				List:    appList,
			}
		}
	}

	// Use cached slow data
	stats.Processes = h.cachedProcs
	stats.Apps = h.cachedApps
	if stats.Apps.List == nil {
		stats.Apps.List = []interface{}{}
	}

	// Update previous readings
	h.prevCPU = currentCPU
	h.prevPerCore = currentPerCore
	h.prevNet = currentNet
	h.prevDiskIO = currentDiskIO
	h.prevTime = now

	// Store and update history
	h.mu.Lock()
	h.cached = stats

	// Add to ring buffer
	h.history[h.historyIdx] = historyPoint{
		timestamp: now.Unix(),
		cpu:       stats.CPU.Usage,
		memory:    stats.Memory.Percent,
		diskRead:  stats.DiskIO.ReadBytesPerSec,
		diskWrite: stats.DiskIO.WriteBytesPerSec,
		netRx:     stats.Network.RxBytesPerSec,
		netTx:     stats.Network.TxBytesPerSec,
	}
	h.historyIdx = (h.historyIdx + 1) % historySize
	if h.historyLen < historySize {
		h.historyLen++
	}

	h.mu.Unlock()
}

// buildLiveStats creates the full LiveStats payload (must hold RLock)
func (h *StatsHandler) buildLiveStats() *models.LiveStats {
	hist := models.StatsHistory{
		Timestamps: make([]int64, 0, h.historyLen),
		CPU:        make([]float64, 0, h.historyLen),
		Memory:     make([]float64, 0, h.historyLen),
		DiskRead:   make([]int64, 0, h.historyLen),
		DiskWrite:  make([]int64, 0, h.historyLen),
		NetRx:      make([]int64, 0, h.historyLen),
		NetTx:      make([]int64, 0, h.historyLen),
	}

	// Read ring buffer in order (oldest first)
	start := 0
	if h.historyLen == historySize {
		start = h.historyIdx // oldest entry
	}
	for i := 0; i < h.historyLen; i++ {
		idx := (start + i) % historySize
		p := h.history[idx]
		hist.Timestamps = append(hist.Timestamps, p.timestamp)
		hist.CPU = append(hist.CPU, p.cpu)
		hist.Memory = append(hist.Memory, p.memory)
		hist.DiskRead = append(hist.DiskRead, p.diskRead)
		hist.DiskWrite = append(hist.DiskWrite, p.diskWrite)
		hist.NetRx = append(hist.NetRx, p.netRx)
		hist.NetTx = append(hist.NetTx, p.netTx)
	}

	return &models.LiveStats{
		Current: h.cached,
		History: hist,
	}
}

// broadcast sends current stats to all WebSocket clients
func (h *StatsHandler) broadcast() {
	h.mu.RLock()
	live := h.buildLiveStats()
	h.mu.RUnlock()

	data, err := json.Marshal(live)
	if err != nil {
		return
	}

	h.clientsMu.Lock()
	defer h.clientsMu.Unlock()

	for conn := range h.clients {
		if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
			conn.Close()
			delete(h.clients, conn)
		}
	}
}

func (h *StatsHandler) pingClients() {
	h.clientsMu.Lock()
	defer h.clientsMu.Unlock()

	for conn := range h.clients {
		if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
			conn.Close()
			delete(h.clients, conn)
		}
	}
}

// ---- CPU ----

func (h *StatsHandler) calculateCPU(current cpuTimes) models.CPUStats {
	usage := calcCPUPercent(h.prevCPU, current)
	model := readCPUModel()
	loadAvg := readLoadAvg()

	return models.CPUStats{
		Usage:   round2(usage),
		Cores:   runtime.NumCPU(),
		Model:   model,
		LoadAvg: loadAvg,
	}
}

func (h *StatsHandler) calculatePerCore(current []cpuTimes) []float64 {
	result := make([]float64, len(current))
	for i := range current {
		if i < len(h.prevPerCore) {
			result[i] = round2(calcCPUPercent(h.prevPerCore[i], current[i]))
		}
	}
	return result
}

func calcCPUPercent(prev, curr cpuTimes) float64 {
	prevTotal := prev.user + prev.nice + prev.system + prev.idle +
		prev.iowait + prev.irq + prev.softirq + prev.steal
	currTotal := curr.user + curr.nice + curr.system + curr.idle +
		curr.iowait + curr.irq + curr.softirq + curr.steal

	prevIdle := prev.idle + prev.iowait
	currIdle := curr.idle + curr.iowait

	totalDelta := float64(currTotal - prevTotal)
	idleDelta := float64(currIdle - prevIdle)

	if totalDelta > 0 {
		return ((totalDelta - idleDelta) / totalDelta) * 100
	}
	return 0
}

func readCPUTimes() cpuTimes {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return cpuTimes{}
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	if scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "cpu ") {
			return parseCPULine(line)
		}
	}
	return cpuTimes{}
}

func readPerCoreTimes() []cpuTimes {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return nil
	}
	defer f.Close()

	var cores []cpuTimes
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "cpu") && !strings.HasPrefix(line, "cpu ") {
			cores = append(cores, parseCPULine(line))
		}
	}
	return cores
}

func parseCPULine(line string) cpuTimes {
	fields := strings.Fields(line)
	if len(fields) >= 9 {
		return cpuTimes{
			user:    parseUint(fields[1]),
			nice:    parseUint(fields[2]),
			system:  parseUint(fields[3]),
			idle:    parseUint(fields[4]),
			iowait:  parseUint(fields[5]),
			irq:     parseUint(fields[6]),
			softirq: parseUint(fields[7]),
			steal:   parseUint(fields[8]),
		}
	}
	return cpuTimes{}
}

func readCPUModel() string {
	f, err := os.Open("/proc/cpuinfo")
	if err != nil {
		return "Unknown"
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "model name") {
			parts := strings.SplitN(line, ":", 2)
			if len(parts) == 2 {
				return strings.TrimSpace(parts[1])
			}
		}
	}
	return "Unknown"
}

func readLoadAvg() []float64 {
	data, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return []float64{0, 0, 0}
	}

	fields := strings.Fields(string(data))
	if len(fields) < 3 {
		return []float64{0, 0, 0}
	}

	result := make([]float64, 3)
	for i := 0; i < 3; i++ {
		result[i], _ = strconv.ParseFloat(fields[i], 64)
	}
	return result
}

// ---- Memory ----

func readMemory() models.MemoryStats {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return models.MemoryStats{}
	}
	defer f.Close()

	memInfo := make(map[string]int64)
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		valStr := strings.TrimSpace(parts[1])
		valStr = strings.TrimSuffix(valStr, " kB")
		valStr = strings.TrimSpace(valStr)
		if val, err := strconv.ParseInt(valStr, 10, 64); err == nil {
			memInfo[key] = val * 1024 // kB to bytes
		}
	}

	total := memInfo["MemTotal"]
	free := memInfo["MemFree"]
	buffers := memInfo["Buffers"]
	cached := memInfo["Cached"]
	sReclaimable := memInfo["SReclaimable"]

	used := total - free - buffers - cached - sReclaimable
	if used < 0 {
		used = total - free
	}

	var percent float64
	if total > 0 {
		percent = float64(used) / float64(total) * 100
	}

	return models.MemoryStats{
		Total:   total,
		Used:    used,
		Free:    total - used,
		Percent: round2(percent),
	}
}

func readTotalMemory() int64 {
	m := readMemory()
	return m.Total
}

// ---- Disk ----

func readDisk() models.DiskStats {
	var stat syscall.Statfs_t
	if err := syscall.Statfs("/", &stat); err != nil {
		return models.DiskStats{}
	}

	total := int64(stat.Blocks) * int64(stat.Bsize)
	free := int64(stat.Bavail) * int64(stat.Bsize)
	used := total - free

	var percent float64
	if total > 0 {
		percent = float64(used) / float64(total) * 100
	}

	return models.DiskStats{
		Total:   total,
		Used:    used,
		Percent: round2(percent),
	}
}

// ---- Network I/O ----

func readNetCounters() netCounters {
	f, err := os.Open("/proc/net/dev")
	if err != nil {
		return netCounters{}
	}
	defer f.Close()

	var best netCounters
	var bestRx int64

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 {
			continue
		}
		iface := strings.TrimSpace(parts[0])
		if iface == "lo" {
			continue // skip loopback
		}

		fields := strings.Fields(parts[1])
		if len(fields) < 10 {
			continue
		}

		rx, _ := strconv.ParseInt(fields[0], 10, 64)
		tx, _ := strconv.ParseInt(fields[8], 10, 64)

		// Pick the interface with the most traffic
		if rx > bestRx {
			bestRx = rx
			best = netCounters{rxBytes: rx, txBytes: tx, iface: iface}
		}
	}

	return best
}

// ---- Disk I/O ----

func readDiskIOCounters() diskIOCounters {
	f, err := os.Open("/proc/diskstats")
	if err != nil {
		return diskIOCounters{}
	}
	defer f.Close()

	var result diskIOCounters
	var bestReads int64

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 14 {
			continue
		}
		dev := fields[2]

		// Skip partitions (e.g., sda1) — only look at whole disks
		// Also skip loop, dm, ram devices
		if strings.HasPrefix(dev, "loop") || strings.HasPrefix(dev, "ram") || strings.HasPrefix(dev, "dm-") {
			continue
		}
		// For vda/sda type disks, skip partitions (has trailing digit after letters)
		isPartition := false
		if len(dev) > 0 {
			last := dev[len(dev)-1]
			if last >= '0' && last <= '9' {
				// Check if it's like sda1/vda1 (partition) vs nvme0n1 (whole disk)
				if !strings.Contains(dev, "nvme") {
					isPartition = true
				}
			}
		}
		if isPartition {
			continue
		}

		// fields[5] = sectors read, fields[9] = sectors written
		// Each sector is 512 bytes
		sectorsRead, _ := strconv.ParseInt(fields[5], 10, 64)
		sectorsWritten, _ := strconv.ParseInt(fields[9], 10, 64)

		readBytes := sectorsRead * 512
		writeBytes := sectorsWritten * 512

		if sectorsRead > bestReads {
			bestReads = sectorsRead
			result = diskIOCounters{
				readBytes:  readBytes,
				writeBytes: writeBytes,
				device:     dev,
			}
		}
	}

	return result
}

// ---- System ----

func readSystem() models.SystemStats {
	hostname, _ := os.Hostname()

	uptimeStr := ""
	if data, err := os.ReadFile("/proc/uptime"); err == nil {
		fields := strings.Fields(string(data))
		if len(fields) > 0 {
			if secs, err := strconv.ParseFloat(fields[0], 64); err == nil {
				uptimeStr = formatUptime(int(secs))
			}
		}
	}

	return models.SystemStats{
		Uptime:   uptimeStr,
		Hostname: hostname,
		Platform: runtime.GOOS,
		Arch:     runtime.GOARCH,
	}
}

// ---- Top Processes ----

func readTopProcesses(totalMem int64) []models.ProcessStats {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}

	// Read system-wide CPU times for process CPU% calculation
	sysJiffies := readTotalJiffies()

	type procInfo struct {
		pid     int
		name    string
		cpu     uint64 // utime + stime
		rss     int64  // pages
		user    string
		command string
	}

	var procs []procInfo

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid < 1 {
			continue
		}

		// Read /proc/[pid]/stat
		statData, err := os.ReadFile(filepath.Join("/proc", entry.Name(), "stat"))
		if err != nil {
			continue
		}

		// Parse: pid (comm) state ...
		statStr := string(statData)
		// Find the closing paren to handle spaces in comm
		closeIdx := strings.LastIndex(statStr, ")")
		if closeIdx < 0 || closeIdx+2 >= len(statStr) {
			continue
		}
		// Name is between first ( and last )
		openIdx := strings.Index(statStr, "(")
		name := ""
		if openIdx >= 0 && closeIdx > openIdx {
			name = statStr[openIdx+1 : closeIdx]
		}

		rest := strings.Fields(statStr[closeIdx+2:])
		if len(rest) < 22 {
			continue
		}

		utime, _ := strconv.ParseUint(rest[11], 10, 64) // field 14 (0-indexed from after comm: 11)
		stime, _ := strconv.ParseUint(rest[12], 10, 64) // field 15
		rss, _ := strconv.ParseInt(rest[21], 10, 64)     // field 24

		// Read /proc/[pid]/status for user
		user := ""
		if statusData, err := os.ReadFile(filepath.Join("/proc", entry.Name(), "status")); err == nil {
			for _, line := range strings.Split(string(statusData), "\n") {
				if strings.HasPrefix(line, "Uid:") {
					fields := strings.Fields(line)
					if len(fields) >= 2 {
						user = uidToName(fields[1])
					}
					break
				}
			}
		}

		// Read /proc/[pid]/cmdline for full command
		command := name
		if cmdData, err := os.ReadFile(filepath.Join("/proc", entry.Name(), "cmdline")); err == nil && len(cmdData) > 0 {
			cmd := strings.ReplaceAll(string(cmdData), "\x00", " ")
			cmd = strings.TrimSpace(cmd)
			if len(cmd) > 80 {
				cmd = cmd[:80]
			}
			if cmd != "" {
				command = cmd
			}
		}

		procs = append(procs, procInfo{
			pid:     pid,
			name:    name,
			cpu:     utime + stime,
			rss:     rss,
			user:    user,
			command: command,
		})
	}

	// Sort by CPU+RSS (combined score)
	pageSize := int64(os.Getpagesize())
	sort.Slice(procs, func(i, j int) bool {
		// Sort by RSS descending as primary (memory usage is more stable)
		return procs[i].rss > procs[j].rss
	})

	// Take top N
	count := topProcessCount
	if len(procs) < count {
		count = len(procs)
	}

	result := make([]models.ProcessStats, 0, count)
	for i := 0; i < count; i++ {
		p := procs[i]
		memBytes := p.rss * pageSize
		var memPct float64
		if totalMem > 0 {
			memPct = round2(float64(memBytes) / float64(totalMem) * 100)
		}
		var cpuPct float64
		if sysJiffies > 0 {
			cpuPct = round2(float64(p.cpu) / float64(sysJiffies) * 100 * float64(runtime.NumCPU()))
		}

		result = append(result, models.ProcessStats{
			PID:     p.pid,
			Name:    p.name,
			CPU:     cpuPct,
			Memory:  memBytes,
			MemPct:  memPct,
			User:    p.user,
			Command: p.command,
		})
	}

	return result
}

func readTotalJiffies() uint64 {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return 0
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	if scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) >= 9 && fields[0] == "cpu" {
			var total uint64
			for _, f := range fields[1:] {
				v, _ := strconv.ParseUint(f, 10, 64)
				total += v
			}
			return total
		}
	}
	return 0
}

var uidCache sync.Map

func uidToName(uid string) string {
	if v, ok := uidCache.Load(uid); ok {
		return v.(string)
	}

	// Try /etc/passwd
	f, err := os.Open("/etc/passwd")
	if err != nil {
		return uid
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		parts := strings.SplitN(scanner.Text(), ":", 4)
		if len(parts) >= 3 && parts[2] == uid {
			uidCache.Store(uid, parts[0])
			return parts[0]
		}
	}

	uidCache.Store(uid, uid)
	return uid
}

// ---- Helpers ----

func formatUptime(totalSecs int) string {
	days := totalSecs / 86400
	hours := (totalSecs % 86400) / 3600
	mins := (totalSecs % 3600) / 60

	if days > 0 {
		return fmt.Sprintf("%dd %dh %dm", days, hours, mins)
	}
	if hours > 0 {
		return fmt.Sprintf("%dh %dm", hours, mins)
	}
	return fmt.Sprintf("%dm", mins)
}

func parseUint(s string) uint64 {
	v, _ := strconv.ParseUint(s, 10, 64)
	return v
}

func round2(f float64) float64 {
	return float64(int(f*100)) / 100
}
