# RadixKV ⚡

A high-performance, distributed in-memory Key-Value store and cache engine built in **Node.js / TypeScript**. RadixKV implements the standard **Redis Serialization Protocol (RESP v2)**, coordinates operations across CPU cores using worker threads and a consistent hash ring, guarantees durability via an Append-Only File (AOF), and includes a live real-time React observability cockpit.

---

## 🚀 Key Features

- **Streaming RESP v2 Protocol Engine**: Zero-copy state-machine parser handling TCP packet fragmentation, split CRLF delimiters, pipelining, and inline requests.
- **Multi-Core Clustered Sharding**: Dynamically partitions key space across physical CPU cores using Node.js `worker_threads`.
- **Consistent Hash Ring**: MD5 hashing ring with 150 virtual nodes per shard ensuring uniform key distribution and minimal churn during rebalancing.
- **Deadlock-Free Atomic Concurrency**: Uses `SharedArrayBuffer` and `Atomics` (`AtomicMutex`, `AtomicMultiLock`) with strict sorted lock acquisition for multi-key operations (e.g. cross-shard `DEL`).
- **Hybrid TTL Expiration**: Passive lazy eviction on access + active 100ms probabilistic background sweeps (identical to Redis).
- **Strict $O(1)$ LRU Eviction**: Doubly-linked list LRU eviction policy with proactive heap-pressure capping.
- **AOF Durability & Crash Recovery**: Sequential mutation logging with automatic crash truncation repair and replays.
- **Cold Storage Archival**: Custom zero-dependency BSON encoder/decoder with gzip compression for cold data tiering.
- **Real-Time Observability Cockpit**: React + Tailwind + WebSocket dashboard tracking sub-millisecond percentiles (P50/P90/P95/P99), hit ratios, 64-block memory heatmap, and in-browser interactive terminal.

---

## 🏛️ Architecture

```
                      +-----------------------------+
                      |   Redis Clients (TCP 6379)   |
                      +--------------+--------------+
                                     |
                                     v
                 +---------------------------------------+
                 |       Master Router / Coordinator      |
                 |  - RESP Streaming Parser              |
                 |  - MD5 Consistent Hash Ring (150 vnodes)|
                 |  - SharedArrayBuffer Atomic Locks     |
                 +----+--------------+--------------+----+
                      |              |              |
                      v              v              v
               +------------+  +------------+  +------------+
               |  Worker 0  |  |  Worker 1  |  |  Worker N  |
               | (Core DRAM)|  | (Core DRAM)|  | (Core DRAM)|
               +------------+  +------------+  +------------+
                      |              |              |
            +---------+-------+      |       +------+-------+
            |  AOF Durability |      |       | BSON Archive |
            | (fsync / replay)|      |       | (Gzip Cold)  |
            +-----------------+      |       +--------------+
                                     v
                      +-----------------------------+
                      |  Telemetry Engine (HTTP/WS) |
                      |    - Microsecond Percentiles|
                      |    - WebSocket (Port 3000)  |
                      +--------------+--------------+
                                     |
                                     v
                      +-----------------------------+
                      | React Observability Cockpit |
                      |  - Live Charts & Heatmap    |
                      |  - Interactive Web Terminal |
                      +-----------------------------+
```

---

## 📦 Getting Started

### Prerequisites
- Node.js >= 22.0.0 (Native TypeScript support via `--experimental-strip-types`)
- npm >= 9.0.0

### Installation
```bash
git clone https://github.com/navsharma26/RadixKV.git
cd RadixKV
npm install
npm run build:web
```

---

## 🛠️ Usage

### 1. Start Multi-Core Cluster with Web Dashboard
```bash
npm run telemetry
```
- **TCP Redis Server**: `127.0.0.1:6379`
- **Web Dashboard & Cockpit**: `http://localhost:3000`
- **WebSocket Stream**: `ws://localhost:3000/ws`

### 2. Start Single-Core Server with AOF
```bash
npm start
```

### 3. Connect via any Redis Client
You can use `redis-cli`, `nc`, or standard Redis SDKs (Node, Python, Go):
```bash
redis-cli -p 6379
```

Supported commands:
```redis
PING
SET key value
SET session token EX 60
GET key
INCR counter
TTL session
DEL key
QUIT
```

---

## 🧪 Testing & Verification

Run the full test suite (10 test suites, 68 tests covering parser, storage, durability, hashing, and concurrency):
```bash
npm test
```

Run benchmarks:
```bash
npm run bench
```

**Single-Core Throughput:** ~350,000+ ops/sec (sub-30µs average latency)  
**Clustered Multi-Worker:** Multi-core parallel key routing with atomic synchronization.

---

## 📊 Live Observability Dashboard

The built-in cockpit (at `http://localhost:3000`) provides:
- **KPI Metrics**: Real-time throughput (ops/sec), average latency, cache hit/miss ratio, connected sockets, and heap memory.
- **Microsecond Latency Charts**: Rolling 60-second window tracking P50, P90, P95, and P99 percentiles.
- **64-Block Cluster Heatmap**: Real-time visualization of key density and memory distribution across shards.
- **In-Browser Terminal**: Execute Redis commands directly against the cluster.
- **Workload Simulator**: Toggle automated traffic generator on/off directly from the UI or via HTTP API.

---

## 📜 License

MIT License © 2026 Navneet Sharma
