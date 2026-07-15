(() => {
  "use strict";

  const course = window.COURSE;
  const modules = new Map(course.modules.map((module) => [module.id, module]));

  function addAfter(moduleId, lessonId, lesson) {
    const module = modules.get(moduleId);
    const index = module.lessons.findIndex((item) => item.id === lessonId);
    module.lessons.splice(index + 1, 0, lesson);
    module.duration += lesson.duration;
  }

  function addBefore(moduleId, lessonId, lesson) {
    const module = modules.get(moduleId);
    const index = module.lessons.findIndex((item) => item.id === lessonId);
    module.lessons.splice(index, 0, lesson);
    module.duration += lesson.duration;
  }

  addAfter("kernel-boundary", "kernel", {
    id: "process-lifecycle",
    number: "00",
    title: "Processes, threads, signals, and PID 1",
    duration: 19,
    summary: "Linux tracks schedulable tasks, process relationships, signal delivery, exit status, and namespace-local process identities.",
    prediction: "A shell is PID 1 in a container and starts the application as its child. If the shell does not forward SIGTERM, which process receives Kubernetes' first stop signal?",
    core: [
      "A process owns an address space and resource tables. Threads in that process share selected state while each thread remains a schedulable kernel task with its own registers, stack, signal mask, and task ID.",
      "clone3 creates a task with explicit sharing and namespace choices. execve replaces the current process image without creating a new PID. By default, an exited child remains a zombie until its parent reaps it; SIGCHLD disposition can request automatic reaping.",
      "Signals are kernel-delivered notifications. Some arise synchronously from the current instruction, while others arrive asynchronously from another process, timer, terminal, or lifecycle event. Kubernetes asks the runtime to stop a container, the runtime signals the container process, and the grace period runs before forced termination. An entrypoint that fails to forward signals or reap children changes that lifecycle."
    ],
    mechanics: [
      { title: "Task and thread", text: "The scheduler runs tasks. Threads are tasks that share an address space and other resources with peers." },
      { title: "clone3 and execve", text: "clone3 creates a task with selected sharing; execve replaces the caller's program image in place." },
      { title: "Signal", text: "A numbered notification targets a process or thread and follows its mask, disposition, and handler rules." },
      { title: "wait and pidfd", text: "A parent collects exit status with wait-family calls, while pidfds provide race-resistant process handles." }
    ],
    kernel: [
      "PID namespaces give one task different PIDs as seen from nested namespaces. PID 1 inside a namespace has special signal and orphan-reaping responsibilities, and the kernel terminates the namespace's remaining processes if that init process exits.",
      "A thread group shares a process ID while individual threads have task IDs. /proc exposes both views, and schedulers, debuggers, cgroups, and signal calls may operate at different scopes."
    ],
    bridge: { title: "Container lifecycle is process lifecycle", text: "Entrypoints, preStop hooks, grace periods, sidecars, restart policy, and Job completion all depend on signal delivery, child reaping, and exit status." },
    failure: { title: "PID 1 is not a ceremonial label", text: "A wrapper that ignores SIGTERM or leaves zombies can make shutdown exceed its grace period and hide the application's real exit behavior." },
    visual: { type: "flow", title: "Start and stop one container process", nodes: [["clone3", "create task"], ["execve", "replace image"], ["PID 1", "namespace init"], ["SIGTERM", "graceful stop"], ["wait", "reap status"]] },
    check: {
      question: "What does execve do to the calling process?",
      choices: ["Creates a child PID", "Replaces its program image", "Moves it to another cgroup", "Creates a VM"],
      answer: 1,
      explanation: "execve replaces the caller's address space and program image while retaining its PID and selected process attributes."
    },
    sources: [
      ["clone(2) and clone3", "https://man7.org/linux/man-pages/man2/clone.2.html"],
      ["execve(2)", "https://man7.org/linux/man-pages/man2/execve.2.html"],
      ["PID namespaces", "https://man7.org/linux/man-pages/man7/pid_namespaces.7.html"],
      ["Kubernetes Pod termination", "https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination"]
    ]
  });

  addAfter("kernel-boundary", "process-lifecycle", {
    id: "vfs-files-mounts",
    number: "00",
    title: "File descriptors, VFS, and mounts",
    duration: 20,
    summary: "VFS connects process-local file descriptors to open file descriptions, paths, inodes, mounts, filesystems, and device implementations.",
    prediction: "A process calls dup on a file descriptor. Do the two descriptor numbers now have independent file offsets?",
    core: [
      "A file descriptor is a process-local table index. Its entry refers to an open file description that carries state such as the current offset and status flags. dup creates another descriptor for the same open file description, while a separate open call normally creates a new one.",
      "VFS gives system calls one interface across filesystems. Path lookup walks dentries through a mount tree; dentries associate names with inodes, and an inode represents a filesystem object and its metadata rather than one pathname.",
      "A mount attaches a filesystem tree at a path. Bind mounts expose an existing subtree elsewhere. Mount namespaces provide different mount-tree views, and propagation rules decide whether later mount events cross a shared boundary."
    ],
    mechanics: [
      { title: "File descriptor", text: "A small integer indexes one process's descriptor table and can refer to files, sockets, pipes, or kernel objects." },
      { title: "Open file description", text: "The kernel object holds the file offset, status flags, operations, and reference to the opened object." },
      { title: "Dentry and inode", text: "A dentry represents a pathname component; an inode represents the underlying filesystem object and metadata." },
      { title: "Mount", text: "A mount connects a filesystem or subtree into a namespace-specific path hierarchy." }
    ],
    kernel: [
      "Path lookup uses caches but still enforces namespace, mount, permission, symlink, and rename rules. A deleted file may remain reachable through an open descriptor until the final reference is released.",
      "Mount propagation matters for container volume delivery. A host mount created after a container starts appears inside that container only when the relevant parent and bind mount relationship propagates the event."
    ],
    bridge: { title: "Volumes cross a mount boundary", text: "CSI node publishing, projected files, image root filesystems, and container bind mounts all rely on VFS objects and a mount tree that the runtime exposes inside a mount namespace." },
    failure: { title: "A path is not the open object", text: "Replacing, renaming, or deleting a pathname does not automatically change an already open file description. Inspect descriptors and mounts, not only directory listings." },
    codebase: {
      title: "NBD becomes a mounted filesystem path",
      text: "E2B's orchestrator exposes a userspace-backed block device, then the host kernel and filesystem make its contents reachable through ordinary file operations.",
      url: "https://github.com/e2b-dev/infra/blob/643d726f0ff4f3fd8ac0c1592812ffa88e62e2d3/packages/orchestrator/pkg/sandbox/nbd/dispatch.go",
      label: "Pinned E2B NBD dispatcher"
    },
    visual: { type: "flow", title: "Resolve one pathname", nodes: [["fd table", "process"], ["open file", "kernel object"], ["dentry", "name"], ["inode", "object"], ["filesystem", "implementation"]] },
    check: {
      question: "What usually happens to the file offset after dup creates a second descriptor?",
      choices: ["Each descriptor gets a private offset", "Both descriptors share the open file description and offset", "The inode is copied", "The filesystem unmounts"],
      answer: 1,
      explanation: "dup creates another reference to the same open file description, so the descriptors share its file offset and status flags."
    },
    sources: [
      ["Linux VFS", "https://docs.kernel.org/filesystems/vfs.html"],
      ["open(2)", "https://man7.org/linux/man-pages/man2/open.2.html"],
      ["mount_namespaces(7)", "https://man7.org/linux/man-pages/man7/mount_namespaces.7.html"],
      ["Shared subtree propagation", "https://docs.kernel.org/filesystems/sharedsubtree.html"]
    ]
  });

  addAfter("containers", "container", {
    id: "container-filesystems",
    number: "00",
    title: "OverlayFS, image layers, and volumes",
    duration: 18,
    summary: "A container root filesystem combines read-only image content with a writable layer and explicit mounts, while persistence follows the backing mount rather than the container name.",
    prediction: "A container deletes a file that exists in a lower image layer. Must the runtime modify that read-only layer?",
    core: [
      "OCI images store content-addressed filesystem layers and configuration. A snapshotter prepares a root filesystem from those layers. OverlayFS can present lower read-only directories plus one upper writable directory as a merged mount.",
      "A write to lower-layer content may copy the object into the upper layer before modification. A deletion can create a whiteout that hides the lower object without changing it. These behaviors affect first-write latency, inode use, and disk accounting.",
      "Volumes and bind mounts cover selected paths in the merged root. Their data follows the volume or host backing store, not the ephemeral writable layer. Mount propagation and namespace setup determine whether later host mounts become visible."
    ],
    mechanics: [
      { title: "Lower layer", text: "Read-only image content can be shared across many container root filesystems." },
      { title: "Upper layer", text: "Container-local writes and metadata changes land in the writable directory." },
      { title: "Copy up and whiteout", text: "OverlayFS copies modified lower objects upward and records deletion without rewriting the lower layer." },
      { title: "Volume mount", text: "A runtime mounts another filesystem or subtree over a path inside the container's mount namespace." }
    ],
    kernel: [
      "OverlayFS identity and rename rules differ from a plain filesystem because one visible object can originate in a lower or upper layer. Features such as redirect_dir, metacopy, and index change specific behavior and compatibility.",
      "A read-only root filesystem does not make every mounted path read-only. tmpfs, projected configuration, secrets, sockets, and persistent volumes each keep their own mount flags and backing lifetime."
    ],
    bridge: { title: "Image storage and volume storage solve different problems", text: "Image layers distribute executable content, the writable layer holds ephemeral mutations, and Kubernetes volumes attach data with a separate lifecycle and access contract." },
    failure: { title: "Disk usage can hide below the merged view", text: "Copy-up, deleted-but-open files, image layers, logs, and volume data can be charged to different filesystems. Check the upper directory, mounts, and open descriptors." },
    visual: { type: "flow", title: "Build a container filesystem view", nodes: [["image layers", "lowerdirs"], ["snapshotter", "prepare"], ["upperdir", "writes"], ["merged root", "OverlayFS"], ["volumes", "cover paths"]] },
    check: {
      question: "How can OverlayFS hide a lower-layer file without modifying the lower layer?",
      choices: ["A whiteout in the upper layer", "A CPU quota", "A network namespace", "A KVM exit"],
      answer: 0,
      explanation: "The upper layer records a whiteout so the merged view omits the lower object."
    },
    sources: [
      ["Linux OverlayFS", "https://docs.kernel.org/filesystems/overlayfs.html"],
      ["OCI image specification", "https://github.com/opencontainers/image-spec/blob/main/spec.md"],
      ["Kubernetes volumes", "https://kubernetes.io/docs/concepts/storage/volumes/"]
    ]
  });

  addBefore("compute", "lock-free", {
    id: "futex-memory-order",
    number: "00",
    title: "Mutexes, futexes, and memory ordering",
    duration: 17,
    summary: "An uncontended mutex can coordinate with userspace atomics, while futex wait and wake operations let contended threads sleep and resume through the kernel.",
    prediction: "A thread acquires an uncontended mutex. Must it enter the kernel on that acquisition?",
    core: [
      "A mutex protects an invariant, not merely a line of code. Fast paths often use an atomic state word in userspace. If the lock is available, acquisition can finish without a syscall; contention may use a futex operation so a waiter sleeps instead of spinning indefinitely.",
      "FUTEX_WAIT blocks only if the userspace word still has an expected value. That value check prevents a lost wake between the userspace decision and kernel sleep. FUTEX_WAKE makes selected waiters runnable but does not transfer application ownership by itself.",
      "Memory ordering defines which reads and writes become visible around synchronization. A correct design needs happens-before relationships in the language model as well as an atomic machine instruction. Race-free ownership is a stronger requirement than atomic access to one field."
    ],
    mechanics: [
      { title: "Fast path", text: "An atomic state transition acquires or releases an uncontended lock without sleeping." },
      { title: "Futex wait", text: "The kernel blocks a task only when the userspace word still equals the expected value." },
      { title: "Futex wake", text: "The kernel marks one or more matching waiters runnable; userspace still arbitrates lock ownership." },
      { title: "Happens before", text: "The language memory model defines when one goroutine or thread must observe another's prior writes." }
    ],
    kernel: [
      "A futex key identifies a userspace address in a private or shared mapping. The kernel queues waiters only on slow paths, leaving the protected data and uncontended protocol in userspace.",
      "Spinning can help when a lock holder will release soon on another CPU, but it wastes service time when the owner is descheduled or the critical section blocks. Implementations mix spinning and sleeping according to observed state."
    ],
    bridge: { title: "Synchronization consumes scheduler and cache resources", text: "A hot mutex can create futex sleeps, wakeups, run-queue movement, and cache-line transfers even when every container remains under its CPU limit." },
    failure: { title: "Atomic does not mean race-free", text: "Making one counter atomic does not protect related fields or define a compound invariant. State the ownership and memory-order rule first." },
    visual: { type: "flow", title: "One contended mutex", nodes: [["atomic try", "userspace"], ["contended", "state word"], ["FUTEX_WAIT", "sleep"], ["unlock", "release"], ["FUTEX_WAKE", "runnable"]] },
    check: {
      question: "Why does FUTEX_WAIT compare the userspace word before sleeping?",
      choices: ["To allocate a huge page", "To avoid sleeping after the condition already changed", "To choose a Kubernetes node", "To flush a disk cache"],
      answer: 1,
      explanation: "The comparison closes the race between the userspace condition check and entering the kernel wait queue."
    },
    sources: [
      ["futex(2)", "https://man7.org/linux/man-pages/man2/futex.2.html"],
      ["futex(7)", "https://man7.org/linux/man-pages/man7/futex.7.html"],
      ["Go memory model", "https://go.dev/ref/mem"]
    ]
  });

  addAfter("memory", "memory-management", {
    id: "memory-pressure",
    number: "00",
    title: "Reclaim, swap, OOM, and PSI",
    duration: 20,
    summary: "Memory pressure is a sequence of reclaim, writeback, throttling, swap, and allocation failure, not a single percentage threshold.",
    prediction: "A cgroup reaches memory.high but remains below memory.max. Must the kernel immediately kill one of its processes?",
    core: [
      "Linux tracks anonymous pages, clean and dirty file-cache pages, slab objects, page tables, and other memory with different reclaim costs. Clean cache can be dropped, dirty cache needs writeback, and eligible anonymous memory may move to swap when swap is configured.",
      "Cgroup v2 memory.low and memory.min protect memory against reclaim to different degrees. memory.high pushes allocations into reclaim and throttling without acting as a hard kill boundary. memory.max is the hard limit where cgroup OOM handling can begin after reclaim cannot satisfy demand.",
      "Pressure Stall Information reports time in which tasks are delayed by CPU, memory, or I/O resource pressure. The some metric means at least one task is stalled; full means all non-idle tasks in the measured scope are stalled together."
    ],
    mechanics: [
      { title: "Reclaim", text: "The kernel frees reclaimable pages or writes dirty data so memory can be reused." },
      { title: "Swap", text: "Eligible anonymous pages can move to configured swap space, trading memory capacity for storage latency." },
      { title: "memcg OOM", text: "A cgroup that cannot reclaim within memory.max can invoke an OOM decision inside that resource domain." },
      { title: "PSI", text: "Pressure metrics quantify lost task time rather than only reporting allocated bytes or queue length." }
    ],
    kernel: [
      "Overcommit policy decides how virtual-memory commitments are admitted, while actual page faults still need physical or swap backing later. A successful malloc therefore does not prove that future writes can all be satisfied.",
      "Dirty-page limits and writeback couple memory and storage. A workload can show memory pressure because pages wait for writeback, then surface as I/O PSI and allocation latency before any OOM event."
    ],
    bridge: { title: "Kubernetes limits enter the memcg path", text: "A container memory limit becomes a cgroup boundary, while kubelet eviction policy reacts to node signals. A memcg OOM kill and a kubelet eviction are different events with different evidence." },
    failure: { title: "RSS alone misses the pressure path", text: "Inspect memory.current, memory.stat, memory.events, swap, PSI, and node eviction signals before deciding that a process leaked memory." },
    visual: { type: "flow", title: "An allocation under pressure", nodes: [["page fault", "demand"], ["memory.high", "reclaim"], ["writeback/swap", "free pages"], ["memory.max", "hard boundary"], ["OOM or success", "result"]] },
    check: {
      question: "What does cgroup v2 memory.high normally do?",
      choices: ["Immediately powers off the node", "Pushes allocations into reclaim and throttling", "Pins pages to one NUMA node", "Creates a second page table"],
      answer: 1,
      explanation: "memory.high is a pressure boundary that drives reclaim and throttles offending allocation paths rather than acting as the hard OOM limit."
    },
    sources: [
      ["Linux cgroup v2 memory controller", "https://docs.kernel.org/admin-guide/cgroup-v2.html#memory"],
      ["Pressure Stall Information", "https://docs.kernel.org/accounting/psi.html"],
      ["Linux overcommit accounting", "https://docs.kernel.org/mm/overcommit-accounting.html"],
      ["Kubernetes node pressure eviction", "https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/"]
    ]
  });

  addBefore("storage-io", "block-devices", {
    id: "interrupts-dma-iommu",
    number: "00",
    title: "Interrupts, DMA, IOMMUs, and device queues",
    duration: 19,
    summary: "Drivers submit work through device queues, DMA moves payloads between a device and memory, and interrupts or polling report completion.",
    prediction: "A NIC is allowed to DMA into one mapped buffer. Does CPU page-table permission alone prevent it from writing to another physical page?",
    core: [
      "A driver prepares descriptors in memory, maps buffers for DMA, and notifies a device through registers or a queue. The device can read or write those mapped memory regions without asking the CPU to copy each byte.",
      "The DMA API accounts for cache coherence, device address limits, and platform mapping rules. An IOMMU can translate and restrict device-visible addresses, which supports isolation for passthrough and protects host memory from an assigned device outside its allowed mappings.",
      "A device can signal completion with a line interrupt, MSI or MSI-X message, or a polled queue. High-rate paths often batch work and moderate interrupts. Queue placement, IRQ affinity, and CPU locality affect latency even when bandwidth is unchanged."
    ],
    mechanics: [
      { title: "Descriptor ring", text: "Memory records buffer addresses, lengths, ownership, and status for queued device work." },
      { title: "DMA mapping", text: "The kernel creates a device-usable mapping and applies architecture-specific cache and address rules." },
      { title: "IOMMU", text: "A translation and protection unit constrains the addresses a device can reach through DMA." },
      { title: "IRQ or poll", text: "An interrupt requests CPU attention, while polling spends CPU cycles checking for completed work." }
    ],
    kernel: [
      "PCIe and root-complex topology determine a device's physical NUMA locality. The IOMMU governs DMA translation and isolation, while IRQ routing and queue affinity determine which CPUs service that device.",
      "blk-mq maps software submission queues to hardware dispatch queues. Queue depth can keep hardware busy, but excess depth adds waiting and can raise tail latency when requests contend."
    ],
    bridge: { title: "Device assignment spans three control planes", text: "Kubernetes selects and allocates a resource, VFIO or a device driver enforces host ownership, and the IOMMU plus hardware determine the actual DMA boundary." },
    failure: { title: "Local CPU does not imply local device", text: "A Pod can receive a local CPU set yet use a GPU or NIC attached to another socket. Check PCIe topology, NUMA nodes, IRQ affinity, and DMA isolation separately." },
    visual: { type: "flow", title: "Submit one device request", nodes: [["driver", "build descriptor"], ["DMA map", "device address"], ["device queue", "consume"], ["DMA", "move bytes"], ["IRQ or poll", "complete"]] },
    check: {
      question: "What is the IOMMU's key role for device passthrough?",
      choices: ["Schedule Kubernetes Pods", "Translate and isolate DMA addresses", "Parse HTTP routes", "Create filesystem inodes"],
      answer: 1,
      explanation: "The IOMMU limits and translates the memory addresses that an assigned device can access through DMA."
    },
    sources: [
      ["Linux DMA API guide", "https://docs.kernel.org/core-api/dma-api-howto.html"],
      ["Linux generic IRQ handling", "https://docs.kernel.org/core-api/genericirq.html"],
      ["VFIO and IOMMU isolation", "https://docs.kernel.org/driver-api/vfio.html"],
      ["Linux blk-mq", "https://docs.kernel.org/block/blk-mq.html"]
    ]
  });

  addBefore("networking", "network-namespaces", {
    id: "socket-to-wire",
    number: "00",
    title: "From socket to wire",
    duration: 21,
    summary: "A socket API operation becomes transport state, route and neighbor lookups, packets, queueing, and NIC work before bytes reach another process.",
    prediction: "A TCP server calls listen but never accept. Can the kernel still complete an incoming TCP handshake?",
    core: [
      "A socket is a file descriptor for protocol state. A TCP server binds an address, listens, and accepts established connections as new sockets. The kernel can complete handshakes into a pending queue before the application accepts them. UDP keeps datagram boundaries and has no TCP-style connection handshake.",
      "Routing uses destination prefixes, policy rules, and metrics to choose a next hop and output interface. On a local link, ARP resolves IPv4 neighbors and Neighbor Discovery resolves IPv6 neighbors so the kernel can build an Ethernet frame with a destination MAC address.",
      "The path must fit its MTU after tunnel headers are added. Path MTU Discovery depends on useful ICMP feedback or Packet Too Big messages. NIC queues, RSS, RPS, XPS, IRQ affinity, qdiscs, and socket buffers decide where packets wait and which CPU processes them."
    ],
    mechanics: [
      { title: "listen and accept", text: "listen creates connection queues; accept returns a new connected socket to the application." },
      { title: "Route lookup", text: "Longest-prefix matching plus policy rules selects a next hop and output interface." },
      { title: "ARP or ND", text: "The network stack maps an on-link IP next hop to link-layer reachability information." },
      { title: "MTU and queue", text: "Packet size, encapsulation overhead, queue limits, and scheduling determine whether traffic waits, fragments, or drops." }
    ],
    kernel: [
      "A SYN backlog and completed accept queue protect different stages of TCP setup. SYN cookies, retransmission, listen limits, and application accept rate can therefore produce different failure patterns.",
      "Receive-side scaling hashes flows into NIC queues. RPS and RFS can steer receive processing in software, while XPS influences transmit queue selection. Distribution can improve parallelism or break cache locality."
    ],
    bridge: { title: "A Pod socket still follows a Linux packet path", text: "The network namespace changes the visible interfaces, routes, and port space, but the same transport, route, neighbor, MTU, queue, and device mechanics remain underneath." },
    failure: { title: "Test the layer that can fail", text: "A successful DNS lookup does not prove a route, a completed handshake does not prove accept capacity, and a small ping does not prove the tunneled application payload fits the path MTU." },
    visual: { type: "flow", title: "Send one TCP segment", nodes: [["socket", "TCP state"], ["route", "next hop"], ["ARP or ND", "neighbor"], ["qdisc/NIC queue", "wait"], ["wire", "Ethernet frame"]] },
    check: {
      question: "Which lookup determines the output interface for an IP destination?",
      choices: ["Route lookup", "Page-table walk", "Cgroup membership", "KVM_RUN"],
      answer: 0,
      explanation: "The routing decision selects the next hop and output interface before neighbor resolution builds the link-layer destination."
    },
    sources: [
      ["socket(7)", "https://man7.org/linux/man-pages/man7/socket.7.html"],
      ["ip-route(8)", "https://man7.org/linux/man-pages/man8/ip-route.8.html"],
      ["Linux networking scaling", "https://docs.kernel.org/networking/scaling.html"],
      ["Linux IP sysctls and PMTU", "https://docs.kernel.org/networking/ip-sysctl.html"]
    ]
  });

  addAfter("networking", "netfilter", {
    id: "kubernetes-network-plumbing",
    number: "00",
    title: "CNI, Services, DNS, policy, and overlays",
    duration: 23,
    summary: "Kubernetes defines network intent, while the runtime, CNI plugins, DNS, Service data plane, and policy engine create the packet path on each node.",
    prediction: "A NetworkPolicy object is accepted by the API server. Does that alone prove packets are now filtered on every node?",
    core: [
      "For a normal non-hostNetwork Pod, the runtime creates or retains a sandbox network namespace and calls a CNI plugin. CNI ADD and delegated IPAM configure interfaces, addresses, and routes; CHECK can validate supported state; DEL removes resources even when some prior state is already gone.",
      "Services select backends represented by EndpointSlices. In current upstream Kubernetes, kube-proxy nftables mode is stable and requires Linux 5.13 or newer, while IPVS mode is deprecated because it did not match every Service edge case. Service externalIPs is deprecated in v1.36.",
      "CoreDNS answers cluster names according to Kubernetes DNS records and each Pod's resolver configuration. NetworkPolicy expresses allowed traffic but requires a network plugin that enforces the API. Cross-node paths may route Pod addresses directly or encapsulate packets in an overlay, reducing usable MTU."
    ],
    mechanics: [
      { title: "CNI and IPAM", text: "The runtime passes a network namespace and configuration; plugins create links, addresses, routes, and allocation state." },
      { title: "EndpointSlice", text: "The control plane partitions Service backend addresses into scalable endpoint objects." },
      { title: "Service data plane", text: "nftables, iptables, eBPF, or another implementation turns a virtual IP into backend selection and connection state." },
      { title: "NetworkPolicy", text: "The API states allowed ingress and egress; the selected network plugin must translate that intent into enforcement." }
    ],
    kernel: [
      "Netfilter NAT normally chooses a translation for the first packet of a tracked flow. Conntrack records that relationship so later packets and the reverse direction follow the established mapping without repeating an independent backend choice.",
      "Conntrack tables, socket buffers, softirq CPU, tunnel devices, qdiscs, and NIC queues are finite shared node resources. A network noisy neighbor may exhaust entries or processing time without exceeding its application CPU request."
    ],
    bridge: { title: "Gateway is a family of route contracts", text: "HTTPRoute and GRPCRoute understand application messages, TCPRoute makes transport decisions, and TLSRoute can inspect TLS handshake metadata without terminating the encrypted application stream." },
    failure: { title: "API intent is not packet proof", text: "Confirm the CNI implementation, programmed rules or BPF state, EndpointSlices, DNS answer, conntrack entry, overlay MTU, and capture location before blaming the Service object." },
    codebase: {
      title: "Pinned network assembly example",
      text: "E2B's current orchestrator code builds namespaces, veth and TAP devices, routing, and host filtering before a Firecracker guest sends traffic.",
      url: "https://github.com/e2b-dev/infra/blob/643d726f0ff4f3fd8ac0c1592812ffa88e62e2d3/packages/orchestrator/pkg/sandbox/network/network.go",
      label: "Pinned E2B network setup"
    },
    visual: { type: "flow", title: "Create and reach a Pod", nodes: [["runtime", "sandbox netns"], ["CNI ADD", "link + IPAM"], ["EndpointSlice", "backends"], ["Service data plane", "select"], ["CoreDNS/policy", "name + allow"]] },
    check: {
      question: "What must exist for NetworkPolicy objects to affect packets?",
      choices: ["A plugin that implements policy enforcement", "A larger TLB", "A guest BIOS", "A filesystem journal"],
      answer: 0,
      explanation: "The API stores policy intent, while a compatible network plugin must program and enforce the corresponding data path."
    },
    sources: [
      ["CNI specification", "https://github.com/containernetworking/cni/blob/main/SPEC.md"],
      ["Kubernetes virtual IPs and Service proxies", "https://kubernetes.io/docs/reference/networking/virtual-ips/"],
      ["Kubernetes DNS", "https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/"],
      ["Kubernetes NetworkPolicy", "https://kubernetes.io/docs/concepts/services-networking/network-policies/"],
      ["Gateway API guides", "https://gateway-api.sigs.k8s.io/guides/"]
    ]
  });

  const linuxNetworking = modules.get("networking");
  const kubernetesNetworkingLessons = ["kubernetes-network-plumbing", "load-balancing"].map((lessonId) => {
    const index = linuxNetworking.lessons.findIndex((lesson) => lesson.id === lessonId);
    return linuxNetworking.lessons.splice(index, 1)[0];
  });
  linuxNetworking.title = "Packets on a Linux host";
  linuxNetworking.shortTitle = "Linux networking";
  linuxNetworking.description = "Follow sockets through routes, neighbors, namespaces, Netfilter, queues, and a physical or virtual interface.";
  linuxNetworking.outcomes = [
    "Trace a socket operation through TCP or UDP, routing, neighbor resolution, and NIC queues.",
    "Build a network path from namespaces, veth pairs, interfaces, and routes.",
    "Separate Netfilter hooks, conntrack state, NAT, iptables syntax, and nftables rules."
  ];
  linuxNetworking.trace = ["socket", "route", "neighbor", "Netfilter", "NIC queue"];
  linuxNetworking.duration = linuxNetworking.lessons.reduce((total, lesson) => total + lesson.duration, 0);

  const ebpfModule = modules.get("ebpf");
  const fleetModule = modules.get("fleet-scheduling");
  ebpfModule.number = "10";
  fleetModule.number = "11";
  const kubernetesNetworking = {
    id: "kubernetes-networking",
    number: "09",
    title: "Kubernetes networking and traffic",
    shortTitle: "Kubernetes networking",
    duration: kubernetesNetworkingLessons.reduce((total, lesson) => total + lesson.duration, 0),
    color: "#176a9a",
    soft: "#e1f1fa",
    description: "Follow network intent through CNI, IPAM, DNS, EndpointSlices, Service state, policy, overlays, and Gateway routes.",
    outcomes: [
      "Order the Pod sandbox, CNI, IPAM, and container-start lifecycle.",
      "Trace Services, EndpointSlices, conntrack, DNS, and NetworkPolicy into a node data plane.",
      "Choose L4, TLS-aware, or application-aware routing from the information required."
    ],
    trace: ["Pod sandbox", "CNI + IPAM", "Service", "policy", "Gateway"],
    lessons: kubernetesNetworkingLessons,
    quizExtra: [
      {
        question: "Which upstream kube-proxy mode is deprecated in Kubernetes v1.36?",
        choices: ["nftables", "IPVS", "EndpointSlice", "CoreDNS"],
        answer: 1,
        explanation: "IPVS mode was deprecated in v1.35, while nftables mode is stable and is the current Linux direction for kube-proxy."
      },
      {
        question: "What records scalable Service backend addresses?",
        choices: ["EndpointSlices", "Page tables", "Mount namespaces", "Virtqueues"],
        answer: 0,
        explanation: "The control plane stores Service backend addresses in EndpointSlice objects."
      }
    ],
    lab: {
      id: "kubernetes-packet-walk",
      title: "Trace a Kubernetes packet",
      kind: "network",
      badge: "Browser model + cluster",
      intro: "Compare Pod-to-Pod, ClusterIP, egress NAT, TCP, and HTTP routing while each step names the owner and visible headers.",
      notebook: [
        {
          title: "Inspect the declared backend path",
          text: "Read the Service and EndpointSlices before inspecting a node data plane.",
          command: "kubectl get service -A\nkubectl get endpointslice -A -o wide"
        },
        {
          title: "Inspect Pod DNS and network identity",
          text: "Run inside a disposable Pod to compare its resolver settings, addresses, and routes.",
          command: "kubectl run net-inspect --rm -it --restart=Never --image=nicolaka/netshoot -- sh -c 'cat /etc/resolv.conf; ip addr; ip route'"
        }
      ]
    }
  };
  course.modules.push(kubernetesNetworking);

  const containerLesson = modules.get("containers").lessons.find((lesson) => lesson.id === "container");
  containerLesson.core.push(
    "A user namespace maps container user and group IDs to different host IDs, which can reduce the authority of container root. Kubernetes Pod user namespaces are stable in v1.36 when the node, runtime, and storage path meet the feature requirements."
  );
  containerLesson.mechanics.push(
    { title: "no_new_privs", text: "A task can prevent execve from granting new privilege through set-ID bits or file capabilities, which is also a prerequisite for unprivileged seccomp filters." },
    { title: "LSM policy", text: "SELinux, AppArmor, Landlock, and other Linux Security Modules apply policy in addition to UID, capability, namespace, and seccomp checks." }
  );
  containerLesson.sources.push(
    ["Kubernetes Pod user namespaces", "https://kubernetes.io/docs/concepts/workloads/pods/user-namespaces/"],
    ["Kubernetes Linux security constraints", "https://kubernetes.io/docs/concepts/security/linux-kernel-security-constraints/"]
  );

  const cpuLesson = modules.get("compute").lessons.find((lesson) => lesson.id === "cpu-scheduling");
  cpuLesson.core.push(
    "One Kubernetes CPU is a unit of schedulable capacity, not a promise of fixed work. Logical CPUs may be SMT siblings, frequency changes with power and thermal policy, and IRQ, softirq, steal, and iowait accounting describe time that application CPU usage alone does not explain."
  );
  cpuLesson.sources.push(
    ["Linux x86 CPU topology", "https://docs.kernel.org/arch/x86/topology.html"],
    ["proc_stat(5)", "https://man7.org/linux/man-pages/man5/proc_stat.5.html"]
  );

  const kataLesson = modules.get("cloud-vmms").lessons.find((lesson) => lesson.id === "kata-containers");
  kataLesson.bridge.text += " RuntimeClass overhead lets the scheduler include the runtime's additional CPU or memory cost in Pod accounting.";
  kataLesson.sources.push(["Kubernetes Pod overhead", "https://kubernetes.io/docs/concepts/scheduling-eviction/pod-overhead/"]);

  const schedulingLesson = modules.get("fleet-scheduling").lessons.find((lesson) => lesson.id === "kubernetes-scheduling");
  schedulingLesson.kernel.push(
    "Container-level in-place resize is stable, Pod-level in-place resize is beta and enabled by default, and Pod-level resource-manager integration remains alpha in Kubernetes v1.36. Dynamic Resource Allocation core APIs are GA."
  );
  schedulingLesson.sources.push(
    ["Kubernetes resource managers", "https://kubernetes.io/docs/concepts/workloads/resource-managers/"],
    ["Dynamic Resource Allocation", "https://kubernetes.io/docs/concepts/scheduling-eviction/dynamic-resource-allocation/"]
  );

  const noisyNeighborLesson = modules.get("fleet-scheduling").lessons.find((lesson) => lesson.id === "noisy-neighbors");
  noisyNeighborLesson.kernel.push(
    "Kubelet PSI reporting is stable in Kubernetes v1.36. It exposes node and Pod pressure signals, but the underlying Linux some and full semantics still determine what each number means."
  );

  modules.get("kernel-boundary").lab.notebook.push({
    title: "Choose the evidence surface",
    text: "procfs exposes process and kernel state, sysfs exposes devices and topology, cgroupfs exposes resource domains, and tracefs exposes event tracing.",
    command: "printf 'procfs: '; stat -fc %T /proc\nprintf 'sysfs: '; stat -fc %T /sys\nprintf 'cgroupfs: '; stat -fc %T /sys/fs/cgroup\nprintf 'tracefs: '; stat -fc %T /sys/kernel/tracing 2>/dev/null || true"
  });

  modules.get("compute").lab.notebook.push({
    title: "Inspect logical CPU topology and accounting",
    text: "Compare logical CPU siblings with aggregate kernel accounting before treating one CPU as one fixed-performance core.",
    command: "lscpu -e=CPU,CORE,SOCKET,NODE,ONLINE,MAXMHZ,MINMHZ\nsed -n '1,6p' /proc/stat"
  });

  modules.get("storage-io").lab.notebook.push({
    title: "Check quiesce-before-teardown ordering",
    text: "Read the local lifecycle and NBD paths together. The invariant is that outstanding handlers release mmap references before the cache is unmapped.",
    command: "rg -n 'Drain|Close|Unmount|quiesce|pendingResponses' pkg/lifecycle pkg/nbd pkg/block"
  });

  course.modules.sort((left, right) => Number(left.number) - Number(right.number));
  let lessonNumber = 1;
  for (const module of course.modules) {
    for (const lesson of module.lessons) {
      lesson.number = String(lessonNumber).padStart(2, "0");
      lessonNumber += 1;
    }
  }

  course.totalMinutes = course.modules.reduce((total, module) => total + module.duration, 0) + course.capstone.duration;
})();
