window.COURSE = {
  version: 1,
  title: "Below the Pod",
  subtitle: "From Linux primitives to Kubernetes placement",
  totalMinutes: 607,
  stackLayers: [
    {
      id: "cluster",
      name: "Cluster",
      scope: "fleet",
      owns: "Desired state and placement",
      hides: "Machine-specific execution",
      next: "kube-scheduler selects a node"
    },
    {
      id: "node",
      name: "Node",
      scope: "machine",
      owns: "Kernel, kubelet, runtime, and devices",
      hides: "Physical topology behind allocatable resources",
      next: "kubelet asks the runtime to create a Pod sandbox"
    },
    {
      id: "pod",
      name: "Pod",
      scope: "logical host",
      owns: "Shared network identity and lifecycle",
      hides: "The processes that implement each container",
      next: "the runtime prepares namespaces and cgroups"
    },
    {
      id: "container",
      name: "Container",
      scope: "process set",
      owns: "Root filesystem and isolation policy",
      hides: "The host kernel shared with other containers",
      next: "the runtime starts the configured process"
    },
    {
      id: "kernel",
      name: "Kernel",
      scope: "privileged core",
      owns: "CPU time, memory, files, packets, and devices",
      hides: "Hardware details behind system calls and drivers",
      next: "a syscall, fault, or interrupt crosses the boundary"
    },
    {
      id: "machine",
      name: "CPU + memory",
      scope: "hardware",
      owns: "Instructions, cache lines, pages, and DMA",
      hides: "Nothing below this course's working model",
      next: "the CPU executes the next instruction"
    }
  ],
  modules: [
    {
      id: "kernel-boundary",
      number: "01",
      title: "The kernel boundary",
      shortTitle: "Kernel boundary",
      duration: 35,
      color: "#315ef4",
      soft: "#e7ecff",
      description: "Trace ordinary code until the CPU crosses into the kernel, blocks, faults, or handles a device event.",
      outcomes: [
        "Separate the kernel, userspace, a distribution, and a process.",
        "Classify syscalls, exceptions, interrupts, and normal instructions.",
        "Read file descriptors and procfs as live views of kernel state."
      ],
      trace: ["userspace", "syscall", "kernel", "driver", "device"],
      lessons: [
        {
          id: "kernel",
          number: "01",
          title: "What the kernel does",
          duration: 22,
          summary: "The kernel is the privileged program that turns hardware into controlled services for processes.",
          prediction: "A Go program calls os.Read. Which instruction crosses the privilege boundary: the Go call, the libc wrapper, or the syscall instruction?",
          core: [
            "A Linux process executes normal instructions in user mode. It cannot program a disk controller, replace a page table, or schedule another process directly. The kernel runs in a more privileged CPU mode and owns those operations.",
            "A system call is a deliberate request from a process. A page fault is a CPU exception caused by the current instruction. A hardware interrupt arrives from outside that instruction stream. All three can transfer control to kernel code, but their causes and return paths differ.",
            "Linux distributions package the kernel with userspace programs, libraries, configuration, and an update system. A container image supplies much of that userspace. It does not normally supply the running host kernel."
          ],
          mechanics: [
            { title: "System call", text: "The process asks for a kernel service through a defined ABI, such as read, mmap, clone, or io_uring_enter." },
            { title: "Exception", text: "The CPU reports a condition caused by the current instruction, such as a missing page or an illegal instruction." },
            { title: "Interrupt", text: "A device or timer asks the CPU for attention. The interrupted task may have no relation to the event." },
            { title: "File descriptor", text: "A process-local integer names an open kernel object such as a file, socket, pipe, eventfd, or KVM VM handle." }
          ],
          kernel: [
            "Entry code saves enough userspace state to return later, switches to a kernel stack, validates arguments, and dispatches the requested operation. A blocking call may put the task to sleep so another runnable task can use the CPU.",
            "Drivers translate generic kernel requests into device operations. DMA lets a device transfer bytes to or from memory without asking the CPU to copy each byte. Completion usually arrives through an interrupt or a polled queue."
          ],
          bridge: { title: "Why Kubernetes engineers care", text: "Every Pod eventually becomes processes that compete through one node kernel. CPU limits, memory faults, network rules, and storage mounts work only because the kernel enforces them." },
          failure: { title: "Common model error", text: "A container does not contain a second Linux kernel in the usual runtime model. A VM does. That one boundary explains many isolation and compatibility differences later in the course." },
          codebase: {
            title: "Trace the upstream blockstore",
            text: "E2B's public implementation connects its block cache and userspace NBD dispatcher to the same kernel storage boundaries used in this course.",
            url: "https://github.com/e2b-dev/infra/tree/main/packages/orchestrator/pkg/sandbox/nbd",
            label: "E2B NBD package"
          },
          visual: {
            type: "flow",
            title: "One read, five owners",
            nodes: [
              ["Go code", "user mode"],
              ["read syscall", "CPU entry"],
              ["VFS + ext4", "kernel"],
              ["NBD driver", "kernel device"],
              ["Go handler", "user mode"]
            ]
          },
          check: {
            question: "A timer fires while a process computes. What caused the kernel entry?",
            choices: ["A syscall", "A hardware interrupt", "A page fault", "A library call"],
            answer: 1,
            explanation: "The timer is external to the current instruction stream, so the CPU handles it as an interrupt."
          },
          sources: [
            ["Linux userspace API", "https://docs.kernel.org/userspace-api/index.html"],
            ["syscalls(2)", "https://man7.org/linux/man-pages/man2/syscalls.2.html"],
            ["proc(5)", "https://man7.org/linux/man-pages/man5/proc.5.html"]
          ]
        }
      ],
      quizExtra: [
        {
          question: "Which component may directly replace a process page-table entry?",
          choices: ["The process", "The kernel", "The container image", "The kube-scheduler"],
          answer: 1,
          explanation: "Page-table updates require privileged kernel work, even when a userspace request caused the change."
        },
        {
          question: "A load instruction touches a valid virtual address whose page is not resident. What event starts?",
          choices: ["A page fault", "A timer interrupt", "A hypercall", "A network packet"],
          answer: 0,
          explanation: "The current instruction causes a synchronous CPU exception called a page fault."
        },
        {
          question: "What does file descriptor 4 mean system-wide?",
          choices: ["Always stderr", "Always the fourth disk", "Nothing without a process", "The fourth syscall"],
          answer: 2,
          explanation: "A file descriptor number is interpreted through one process's descriptor table."
        }
      ],
      lab: {
        id: "kernel-event-stepper",
        title: "Who executes next?",
        kind: "event-stepper",
        badge: "Browser model",
        intro: "Step through a syscall, page fault, and device completion. Name the active layer before revealing each transition.",
        notebook: [
          {
            title: "Inspect one process",
            text: "Run this on Linux while the process is alive. The files expose kernel-owned state through procfs.",
            command: "pid=$$\nprintf 'fds\\n'\nls -l /proc/$pid/fd\nprintf 'maps\\n'\nsed -n '1,12p' /proc/$pid/maps"
          },
          {
            title: "Trace system calls",
            text: "Compare a source-level operation with the syscalls it causes. Library calls and syscalls are not one-to-one.",
            command: "strace -f -e trace=openat,read,mmap,clock_nanosleep sleep 0.1"
          }
        ]
      }
    },
    {
      id: "networking",
      number: "08",
      title: "Linux and Kubernetes networking",
      shortTitle: "Networking",
      duration: 58,
      color: "#147bb8",
      soft: "#dff2ff",
      description: "Follow one packet through a namespace, veth, route, Netfilter rule, Service decision, and protocol-aware proxy.",
      outcomes: [
        "Build a Pod network from namespaces, veth pairs, and routes.",
        "Separate iptables syntax, nftables rules, conntrack, and kube-proxy mode.",
        "Choose L4 or L7 balancing from the information needed for a decision."
      ],
      trace: ["socket", "netns", "veth", "Netfilter", "backend"],
      lessons: [
        {
          id: "network-namespaces",
          number: "24",
          title: "Network namespaces",
          duration: 19,
          summary: "A network namespace owns a separate view of interfaces, routes, sockets, firewall state, and several network sysctls.",
          prediction: "Two processes listen on TCP port 8080 in different network namespaces. Must one bind fail?",
          core: [
            "A new network namespace begins with its own loopback interface and network stack state. Physical or virtual interfaces can move into it. A veth pair acts like a cable whose two endpoints can live in different namespaces.",
            "Container networking commonly places one veth endpoint in the Pod namespace and the peer in the host namespace. The host side connects through a bridge, routes, an eBPF datapath, or another CNI implementation. IP address management and routing make the Pod reachable.",
            "All containers in a normal Pod share the Pod network namespace, so they share an IP address, port space, routes, and localhost. They can still run separate processes, mounts, and container cgroups."
          ],
          mechanics: [
            { title: "Namespace", text: "An ownership boundary for network devices, routes, firewall rules, port numbers, and protocol state." },
            { title: "veth pair", text: "Packets sent into one endpoint emerge from the peer, which can live in another namespace." },
            { title: "Route", text: "A destination lookup selects a next hop and output interface inside the current namespace." },
            { title: "CNI", text: "A runtime calls a plugin to configure Pod network resources according to a standard request contract." }
          ],
          kernel: [
            "A network device lives in exactly one network namespace at a time. Namespace file descriptors let a privileged manager create state in another namespace through setns or netlink without keeping a shell inside it.",
            "Conntrack entries, Netfilter rules, sockets, and interface indices are namespace-scoped. Packet capture location therefore changes what headers and translations are visible."
          ],
          bridge: { title: "The Pod IP is kernel state", text: "Kubernetes defines the network model, while the runtime and CNI implementation create Linux interfaces, namespaces, routes, tunnels, rules, or eBPF programs that realize it." },
          failure: { title: "Capture at the right boundary", text: "A packet can have different addresses before and after NAT, encapsulation, or namespace crossing. Record the namespace and interface with every tcpdump result." },
          codebase: {
            title: "E2B assembles a microVM network",
            text: "The orchestrator creates a namespace, veth pair, TAP device, routes, and host rules before connecting the Firecracker virtio-net device.",
            url: "https://github.com/e2b-dev/infra/tree/main/packages/orchestrator/pkg/sandbox/network",
            label: "E2B sandbox network"
          },
          visual: { type: "flow", title: "Pod to node", nodes: [["process socket", "Pod netns"], ["eth0", "veth end"], ["host peer", "node netns"], ["route/bridge", "forward"], ["node NIC", "egress"]] },
          check: {
            question: "What does a veth pair provide?",
            choices: ["Two connected virtual interfaces", "A CPU quota", "A page table", "A VM exit"],
            answer: 0,
            explanation: "Packets entering one veth endpoint emerge from the peer, which can be placed in another namespace."
          },
          sources: [
            ["network_namespaces(7)", "https://man7.org/linux/man-pages/man7/network_namespaces.7.html"],
            ["veth(4)", "https://man7.org/linux/man-pages/man4/veth.4.html"],
            ["Kubernetes network model", "https://kubernetes.io/docs/concepts/services-networking/"]
          ]
        },
        {
          id: "netfilter",
          number: "25",
          title: "iptables and nftables",
          duration: 20,
          summary: "Netfilter provides packet-processing hooks; iptables and nftables are user-facing rule systems that configure those hooks through different models.",
          prediction: "The iptables command exists on a modern node. Does that prove the kernel uses the old xtables backend?",
          core: [
            "Netfilter exposes hooks as packets enter, route through, leave, or reach local protocol stacks. Rules can filter, modify, count, log, or translate packets. Conntrack records flow state used by stateful filtering and NAT.",
            "iptables commands traditionally program protocol-specific tables and ordered chains through the xtables interface. nftables uses one nf_tables engine, typed expressions, sets, maps, transactions, and a unified rule language across address families.",
            "Many systems provide an iptables-nft compatibility frontend. The command still looks like iptables while it programs nftables. Separate the command syntax, kernel backend, and Kubernetes data-plane mode when debugging."
          ],
          mechanics: [
            { title: "Hook", text: "A defined point such as prerouting, input, forward, output, or postrouting where packet rules can run." },
            { title: "Conntrack", text: "Kernel state groups packets into flows and records direction, protocol state, and NAT relationships." },
            { title: "DNAT", text: "Destination translation changes where a packet is delivered, as in a virtual Service IP to a backend." },
            { title: "SNAT", text: "Source translation changes the return identity, often for egress or cross-node routing." }
          ],
          kernel: [
            "Ordered linear rules can become expensive as rule counts grow. Nftables sets and maps let one lookup replace many nearly identical rules. Transactions update a ruleset atomically instead of exposing partial intermediate state.",
            "Kube-proxy can implement Service virtual IPs with iptables, IPVS, nftables, or another supported mode depending on Kubernetes version and configuration. Some CNIs replace that path with eBPF."
          ],
          bridge: { title: "A Service is an API plus a data plane", text: "The Service object and EndpointSlices describe intent. A node component or CNI implementation programs rules, maps, or load-balancer state that sends packets to current backends." },
          failure: { title: "Rule counters need context", text: "A zero counter can mean the packet took another hook, namespace, address family, backend, or fast path. Confirm the actual packet path before editing rules." },
          codebase: {
            title: "E2B uses both tools",
            text: "The sandbox network path uses iptables NAT and an nftables firewall. The split makes command, backend, and policy boundaries visible in real code.",
            url: "https://github.com/e2b-dev/infra/blob/main/packages/orchestrator/pkg/sandbox/network/firewall.go",
            label: "E2B nftables firewall"
          },
          visual: { type: "flow", title: "Outbound packet hooks", nodes: [["Pod veth", "ingress"], ["prerouting", "DNAT?"], ["forward", "filter"], ["postrouting", "SNAT?"], ["node NIC", "leave"]] },
          check: {
            question: "Why can an iptables command still create nftables state?",
            choices: ["Compatibility frontend", "KVM translates it", "The TLB caches it", "CSI mounts it"],
            answer: 0,
            explanation: "The iptables-nft frontend accepts iptables syntax and programs the nftables kernel backend."
          },
          sources: [
            ["nftables manual", "https://www.netfilter.org/projects/nftables/manpage.html"],
            ["Netfilter hooks", "https://wiki.nftables.org/wiki-nftables/index.php/Netfilter_hooks"],
            ["Kubernetes virtual IPs", "https://kubernetes.io/docs/reference/networking/virtual-ips/"]
          ]
        },
        {
          id: "load-balancing",
          number: "26",
          title: "L4 and L7 load balancing",
          duration: 19,
          summary: "L4 decisions use transport endpoints and connection state; L7 decisions understand an application protocol such as HTTP.",
          prediction: "A router must send /images to one backend and /api to another on the same IP and port. Can a pure L4 decision see enough information?",
          core: [
            "An L4 load balancer chooses a backend from network and transport information such as source and destination addresses, ports, protocol, and connection state. It can handle TCP or UDP without understanding HTTP paths.",
            "An L7 proxy terminates or parses an application protocol. An HTTP proxy can route by host, path, method, header, or cookie, retry selected requests, enforce protocol policy, and emit request-level metrics. That requires more CPU, memory, buffering, and protocol responsibility.",
            "Kubernetes Services provide stable endpoints for Pods and are commonly implemented at L4. Gateway API or Ingress implementations add protocol-aware routing. A cloud LoadBalancer Service can also place an external provider in front of the node path."
          ],
          mechanics: [
            { title: "Connection selection", text: "A backend is chosen from an address and port tuple, then connection state keeps later packets consistent." },
            { title: "Request selection", text: "An L7 proxy can choose again per request when the protocol and connection reuse allow it." },
            { title: "TLS passthrough", text: "An L4 path forwards encrypted bytes and may inspect limited handshake metadata such as SNI only with explicit support." },
            { title: "TLS termination", text: "An L7 proxy decrypts traffic, owns certificates, and can inspect or modify application messages." }
          ],
          kernel: [
            "L4 paths can run in kernel rules, IPVS, eBPF, userspace proxies, smart NICs, or cloud appliances. L7 parsing usually lives in a proxy process, though kernel acceleration can support portions of the data path.",
            "Connection reuse changes balancing granularity. One long HTTP/2 connection can carry many requests to the backend selected for that connection unless a proxy terminates and redistributes streams or requests."
          ],
          bridge: { title: "Choose the lowest layer with enough information", text: "Use L4 when endpoint and connection data are sufficient. Pay the L7 cost only when routing, policy, observability, or resilience needs application semantics." },
          failure: { title: "Health is layer-specific", text: "A TCP handshake can succeed while an HTTP handler fails. Match the health check layer to the failure you need to remove from service." },
          codebase: {
            title: "Address and port versus HTTP and SNI",
            text: "E2B has TCP forwarding code and application-aware proxy code, which makes the decision boundary visible without pretending every proxy fits one layer.",
            url: "https://github.com/e2b-dev/infra/tree/main/packages/orchestrator/pkg/tcpfirewall",
            label: "E2B TCP forwarding"
          },
          visual: { type: "flow", title: "Same packet, different knowledge", nodes: [["client", "request"], ["L4", "IP + port"], ["or L7", "HTTP fields"], ["backend choice", "policy"], ["Pod", "serve"]] },
          check: {
            question: "Which decision requires L7 HTTP awareness?",
            choices: ["Route by destination port", "Route by URL path", "Track a TCP flow", "DNAT a Service IP"],
            answer: 1,
            explanation: "The URL path lives in the HTTP request, so the balancer must parse the application protocol."
          },
          sources: [
            ["Kubernetes Services", "https://kubernetes.io/docs/concepts/services-networking/service/"],
            ["Gateway API HTTP routing", "https://gateway-api.sigs.k8s.io/guides/http-routing/"],
            ["Gateway API TCP routing", "https://gateway-api.sigs.k8s.io/guides/tcp/" ]
          ]
        }
      ],
      lab: {
        id: "packet-walk",
        title: "Walk the packet",
        kind: "network",
        badge: "Browser model + Linux",
        intro: "Select Pod-to-Pod, ClusterIP, outbound NAT, TCP, or HTTP routing. Step through namespaces and rules while headers change.",
        notebook: [
          {
            title: "Create two network namespaces",
            text: "Run on a disposable Linux VM with root. The commands create only temporary namespaces and a veth pair.",
            command: "sudo ip netns add left\nsudo ip netns add right\nsudo ip link add veth-left type veth peer name veth-right\nsudo ip link set veth-left netns left\nsudo ip link set veth-right netns right\nsudo ip -n left addr add 10.44.0.1/30 dev veth-left\nsudo ip -n right addr add 10.44.0.2/30 dev veth-right\nsudo ip -n left link set veth-left up\nsudo ip -n right link set veth-right up\nsudo ip netns exec left ping -c 1 10.44.0.2"
          },
          {
            title: "Clean up",
            text: "Deleting the namespaces removes their veth endpoints and namespace-scoped state.",
            command: "sudo ip netns del left\nsudo ip netns del right"
          }
        ]
      }
    },
    {
      id: "ebpf",
      number: "09",
      title: "eBPF as a kernel extension point",
      shortTitle: "eBPF",
      duration: 38,
      color: "#007f6d",
      soft: "#dcf5ef",
      description: "Load constrained programs into defined kernel hooks, prove allowed memory behavior, and exchange state through maps.",
      outcomes: [
        "Trace source, bytecode, verifier, JIT, attach point, and map state.",
        "Choose a program type from its context and required action.",
        "Explain what the verifier checks without treating it as a universal proof."
      ],
      trace: ["compile", "load", "verify", "attach", "execute"],
      lessons: [
        {
          id: "ebpf-programs",
          number: "27",
          title: "eBPF programs, maps, and the verifier",
          duration: 26,
          summary: "eBPF runs verified bytecode at specific kernel hooks with a program-type contract and map-based state exchange.",
          prediction: "Two eBPF programs contain identical instructions but use different program types. Must the verifier allow the same helpers and context reads?",
          core: [
            "An eBPF toolchain compiles a restricted program into BPF instructions and metadata. A loader creates maps, asks the bpf syscall to load the program, receives verifier output, and attaches the accepted program to a supported hook.",
            "Program type defines the context, helpers, return-value meaning, and attach points. XDP sees packets early in a network driver path. Tracepoints observe defined events. cgroup hooks apply policy to members. LSM programs participate in security decisions.",
            "Maps store state shared between BPF programs and userspace. Common choices include hash maps, arrays, per-CPU maps, ring buffers, and LRU maps. Concurrency, key lifetime, update mode, memory charge, and read consistency still need design."
          ],
          mechanics: [
            { title: "Verifier", text: "Symbolically explores paths and tracks register, pointer, range, stack, and lifetime state against program rules." },
            { title: "JIT", text: "An accepted program may compile into native instructions for the host CPU before attachment." },
            { title: "Attach point", text: "A defined kernel event or hook determines when the program runs and what context it receives." },
            { title: "Map", text: "A kernel object holds keys, values, queues, stacks, events, or other shared program state." }
          ],
          kernel: [
            "The verifier rejects uninitialized reads, invalid pointer arithmetic, out-of-bounds access, unsafe lifetime use, and paths it cannot prove within its model. Bounded loops are possible when the verifier can establish safe bounds.",
            "CO-RE uses BTF type information and relocation so one compiled object can adapt field offsets across compatible kernels. Capability and unprivileged-BPF policy still control who may load each program type."
          ],
          bridge: { title: "Kubernetes datapaths and observability", text: "CNI implementations can attach eBPF at traffic hooks, while tracing agents use it to connect kernel events with cgroup and Pod identity. The Kubernetes API remains separate from the kernel program." },
          failure: { title: "Verified means accepted properties", text: "The verifier enforces defined safety rules for a kernel and program type. It does not prove business logic, policy intent, low overhead, or freedom from kernel defects." },
          visual: { type: "flow", title: "Source to hook", nodes: [["C/Rust", "source"], ["BPF bytecode", "object"], ["verifier", "prove"], ["JIT", "optional"], ["hook + maps", "run"]] },
          check: {
            question: "What primarily determines an eBPF program's available context and helpers?",
            choices: ["Program type", "Pod name", "Page size", "QEMU machine type"],
            answer: 0,
            explanation: "The program type defines the context contract, allowed helpers, return behavior, and compatible attach points."
          },
          sources: [
            ["Linux BPF documentation", "https://docs.kernel.org/bpf/index.html"],
            ["eBPF verifier", "https://docs.kernel.org/bpf/verifier.html"],
            ["BPF program types", "https://docs.kernel.org/bpf/programs.html"],
            ["BPF maps", "https://docs.kernel.org/bpf/maps.html"]
          ]
        }
      ],
      quizExtra: [
        {
          question: "Where does persistent eBPF state usually live?",
          choices: ["A BPF map", "The guest BIOS", "A Pod YAML comment", "A TLB entry"],
          answer: 0,
          explanation: "Maps are kernel objects designed for program and userspace state exchange."
        },
        {
          question: "What does CO-RE use to adapt field offsets?",
          choices: ["BTF metadata", "Conntrack NAT", "KVM_RUN", "cpu.max"],
          answer: 0,
          explanation: "Compile Once, Run Everywhere uses BTF types and relocations to adapt to compatible kernel layouts."
        },
        {
          question: "Does verifier acceptance prove that a tracing program has low overhead?",
          choices: ["Yes", "No"],
          answer: 1,
          explanation: "Acceptance addresses verifier safety rules. Frequency, map contention, data volume, and program work determine overhead."
        }
      ],
      lab: {
        id: "verifier-lab",
        title: "Think like the verifier",
        kind: "ebpf",
        badge: "Browser model + privileged Linux",
        intro: "Move through branches while the model tracks register types, nullable map pointers, bounds, and stack initialization.",
        notebook: [
          {
            title: "Check host support",
            text: "Run on Linux. bpftool often needs elevated privilege to show all program and feature details.",
            command: "test -d /sys/fs/bpf && echo 'BPF filesystem present'\ncommand -v bpftool >/dev/null && sudo bpftool feature probe kernel || echo 'bpftool unavailable'"
          },
          {
            title: "List loaded programs",
            text: "Program and map lists are live host state. Run only where you are allowed to inspect them.",
            command: "sudo bpftool prog list\nsudo bpftool map list"
          }
        ]
      }
    },
    {
      id: "fleet-scheduling",
      number: "10",
      title: "Placement, interference, and devices",
      shortTitle: "Fleet scheduling",
      duration: 70,
      color: "#ff624a",
      soft: "#ffebe7",
      description: "Filter and score nodes from requests, pack resources deliberately, then confront the runtime interference that placement math cannot see.",
      outcomes: [
        "Separate scheduler filtering, scoring, binding, and node-level enforcement.",
        "Compare spreading with requested-resource bin packing and fragmentation.",
        "Trace GPU passthrough through IOMMU, VFIO, device plugins, and topology."
      ],
      trace: ["pending Pod", "filter", "score", "bind", "runtime pressure"],
      lessons: [
        {
          id: "kubernetes-scheduling",
          number: "28",
          title: "Resource scheduling and bin packing",
          duration: 27,
          summary: "kube-scheduler filters infeasible nodes, scores feasible ones, and binds a Pod using declared state rather than live CPU or memory use.",
          prediction: "A node uses 10% of its CPU but already has CPU requests equal to allocatable capacity. Is a new requested CPU guaranteed to fit?",
          core: [
            "The scheduler processes one pending Pod through a scheduling cycle. Filter plugins remove nodes that violate resource, affinity, topology, taint, volume, or policy requirements. Score plugins rank the remaining nodes. The selected node is reserved and bound through the framework's later extension points.",
            "For ordinary CPU and memory capacity, the scheduler adds Pod requests and compares them with node allocatable resources. Live utilization does not replace that check. Extended resources, huge pages, volumes, ports, and topology add other fit dimensions.",
            "Bin packing intentionally prefers nodes that are already more allocated so other nodes remain empty or less fragmented. NodeResourcesFit supports strategies such as MostAllocated and RequestedToCapacityRatio. Spreading pursues a different operating goal."
          ],
          mechanics: [
            { title: "Filter", text: "A hard feasibility test. One failed required condition removes the node from this scheduling attempt." },
            { title: "Score", text: "A preference among feasible nodes. Weighted plugin scores combine into the final ranking." },
            { title: "Request", text: "Declared capacity reserved in scheduling math, whether or not current runtime use reaches it." },
            { title: "Bin packing", text: "A scoring choice that concentrates requested resources, often to free whole nodes or reduce cost." }
          ],
          kernel: [
            "After binding, kubelet and the runtime translate resource policy into cgroups, cpusets, huge-page mounts, and device assignments. The scheduler itself does not enforce those controls.",
            "Multidimensional packing creates stranded capacity. A node can have free CPU but insufficient memory, a free GPU on the wrong NUMA node, or large total memory without the requested huge-page pool."
          ],
          bridge: { title: "Pack for the bottleneck you own", text: "MostAllocated can free nodes but increase shared-resource contention. RequestedToCapacityRatio and resource weights let operators express a curve and prioritize scarce resources." },
          failure: { title: "Default claims need config evidence", text: "Available bin-packing strategies are not proof that a cluster uses them. Inspect the scheduler profile and plugin configuration before explaining a placement." },
          visual: { type: "flow", title: "One scheduling cycle", nodes: [["pending Pod", "queue"], ["filter", "feasible"], ["score", "rank"], ["reserve + permit", "coordinate"], ["bind", "node"]] },
          check: {
            question: "What normally drives the basic CPU capacity fit check?",
            choices: ["Live CPU usage", "Sum of CPU requests", "CPU cache misses", "HTTP request rate"],
            answer: 1,
            explanation: "The scheduler compares requested CPU against node allocatable capacity. Live use can differ after placement."
          },
          sources: [
            ["Kubernetes scheduler", "https://kubernetes.io/docs/concepts/scheduling-eviction/kube-scheduler/"],
            ["Scheduling framework", "https://kubernetes.io/docs/concepts/scheduling-eviction/scheduling-framework/"],
            ["Resource bin packing", "https://kubernetes.io/docs/concepts/scheduling-eviction/resource-bin-packing/"]
          ]
        },
        {
          id: "noisy-neighbors",
          number: "29",
          title: "Noisy neighbors at scale",
          duration: 23,
          summary: "Workloads can satisfy declared limits while contending for shared caches, bandwidth, reclaim work, queues, locks, and devices.",
          prediction: "Two Pods each use less than one CPU and stay below memory limits. Can one still increase the other's tail latency?",
          core: [
            "A noisy neighbor consumes or perturbs a shared resource in a way that harms another workload. The contested resource may be CPU run-queue time, last-level cache, memory bandwidth, NUMA links, page reclaim, storage queue depth, network buffers, conntrack, or a userspace service.",
            "Kubernetes requests and limits model only part of the machine. CPU quota controls time, not cache capacity. Memory limits control charged bytes, not bandwidth. Ephemeral-storage requests do not isolate every device queue. A shared daemon can become a cross-Pod bottleneck outside the application cgroup.",
            "Diagnosis needs correlated evidence from the affected layer. Pressure Stall Information reports time waiting on CPU, memory, or I/O pressure. cgroup files show throttling and memory events. Hardware counters reveal cache and bandwidth behavior. Queue latency and saturation identify device contention."
          ],
          mechanics: [
            { title: "Contention", text: "Concurrent demand exceeds a shared resource's useful capacity, increasing wait time or reducing work per unit time." },
            { title: "Interference", text: "One workload changes another's performance even when neither violates its visible resource limit." },
            { title: "PSI", text: "The kernel measures time that some or all non-idle tasks are stalled on CPU, memory, or I/O pressure." },
            { title: "Tail latency", text: "Rare slow requests often expose queueing and reclaim effects hidden by averages." }
          ],
          kernel: [
            "CPU throttling, reclaim, direct reclaim, writeback, and I/O scheduling can move work into kernel threads or shared paths. Attribution must include those paths rather than reading one process's CPU counter alone.",
            "Mitigations include better requests, limits, topology policy, dedicated pools, cache or bandwidth controls, queue shaping, workload separation, admission policy, and more capacity. Each targets a different shared boundary."
          ],
          bridge: { title: "Placement creates the interference set", text: "The scheduler chooses which workloads share a node. Node configuration and the kernel decide how they share resources after that point." },
          failure: { title: "Average utilization hides queues", text: "A device can show moderate average use while short bursts create deep queues and high p99 latency. Use time-aligned workload and pressure data." },
          codebase: {
            title: "One cache, many sandbox builds",
            text: "E2B's public build cache tracks shared disk use and evicts old entries. It shows how a node-local cache becomes part of the interference set.",
            url: "https://github.com/e2b-dev/infra/blob/main/packages/orchestrator/pkg/sandbox/build/cache.go",
            label: "E2B build cache"
          },
          visual: { type: "flow", title: "Find the contested boundary", nodes: [["Pod A", "demand"], ["shared resource", "queue"], ["Pod B", "victim"], ["layer metric", "evidence"], ["targeted control", "mitigation"]] },
          check: {
            question: "Which problem can remain even when both Pods stay below CPU quota?",
            choices: ["Last-level cache contention", "A missing Pod object", "An invalid YAML field", "No guest kernel in a VM"],
            answer: 0,
            explanation: "CPU quota controls execution time, while shared cache capacity and memory bandwidth remain separate resources."
          },
          sources: [
            ["Linux PSI", "https://docs.kernel.org/accounting/psi.html"],
            ["Kubernetes resource management", "https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/"],
            ["Kubernetes Pod QoS", "https://kubernetes.io/docs/concepts/workloads/pods/pod-qos/"]
          ]
        },
        {
          id: "gpu-passthrough",
          number: "30",
          title: "GPU and PCIe device virtualization",
          duration: 20,
          summary: "Device assignment grants a guest or container controlled access to PCIe hardware through IOMMU isolation, VFIO, and runtime allocation.",
          prediction: "Two PCIe functions share one IOMMU group. Can VFIO safely assign only one while the host driver controls the other?",
          core: [
            "PCIe devices can read and write system memory through DMA. An IOMMU translates and restricts device DMA addresses, providing the memory-isolation boundary needed for safe assignment. Interrupt remapping and platform topology are part of the same trust problem.",
            "VFIO exposes an IOMMU-protected device to userspace so a VMM can map device regions, configure DMA mappings, and receive interrupts. Whole-device passthrough gives a guest direct use but reduces host sharing and can complicate reset, migration, and observability.",
            "Sharing models differ. SR-IOV creates hardware virtual functions. Mediated devices partition through a host driver. NVIDIA MIG divides supported GPUs into isolated GPU instances but is not the same mechanism as PCIe SR-IOV. Kubernetes device plugins and Dynamic Resource Allocation advertise and assign these resources."
          ],
          mechanics: [
            { title: "IOMMU group", text: "The smallest set of devices the platform can isolate safely for DMA assignment." },
            { title: "VFIO", text: "A kernel framework exposes protected device access and DMA mapping to a userspace VMM." },
            { title: "Device plugin", text: "A node agent advertises extended resources and passes allocation details to kubelet and the runtime." },
            { title: "DRA", text: "Kubernetes APIs coordinate structured device claims, classes, allocation, and scheduling information." }
          ],
          kernel: [
            "A VMM maps guest memory into an IOMMU domain so device DMA reaches only assigned guest pages. MSI or MSI-X interrupts need routing into the guest. Reset support determines whether the device can move safely between owners.",
            "Topology matters for PCIe bandwidth, NUMA memory, peer-to-peer transfers, and CPU affinity. A feasible node can still provide poor locality if the selected CPU, memory, NIC, and GPU span sockets."
          ],
          bridge: { title: "Scheduling needs device identity", text: "A count such as nvidia.com/gpu can express availability but not every model, link, NUMA, sharing, or health property. Device plugins, labels, affinity, Topology Manager, and DRA carry different pieces." },
          failure: { title: "Never rebind a learner's live GPU", text: "VFIO experiments can detach the display or production accelerator from its host driver. Use captured topology, a dedicated host, or cloud hardware intended for passthrough labs." },
          visual: { type: "flow", title: "Assign one PCIe function", nodes: [["PCIe device", "DMA"], ["IOMMU group", "isolation"], ["VFIO", "userspace fd"], ["VMM", "guest mapping"], ["guest driver", "device"]] },
          check: {
            question: "What protects host memory from arbitrary DMA by an assigned device?",
            choices: ["IOMMU mappings", "A Pod label", "The page cache", "HTTP routing"],
            answer: 0,
            explanation: "The IOMMU constrains device DMA to mapped addresses within the assigned domain."
          },
          sources: [
            ["Linux VFIO", "https://docs.kernel.org/driver-api/vfio.html"],
            ["Kubernetes device plugins", "https://kubernetes.io/docs/concepts/extend-kubernetes/compute-storage-net/device-plugins/"],
            ["Dynamic Resource Allocation", "https://kubernetes.io/docs/concepts/scheduling-eviction/dynamic-resource-allocation/"],
            ["Kubernetes Topology Manager", "https://kubernetes.io/docs/tasks/administer-cluster/topology-manager/"]
          ]
        }
      ],
      lab: {
        id: "bin-packing-lab",
        title: "Place the fleet, then reveal reality",
        kind: "binpack",
        badge: "Browser model",
        intro: "Place Pods across nodes with CPU, memory, huge pages, GPUs, NUMA, and cached builds. Reveal actual use to expose fragmentation and noisy neighbors.",
        codeChallenge: {
          id: "best-fit",
          title: "Write a requested-resource bin packer",
          prompt: "Implement chooseNode(pod, nodes). Return the id of the feasible node with the least remaining CPU after placement. Break ties by id.",
          starter: "function chooseNode(pod, nodes) {\n  // Each node has id, cpuFree, and memoryFree.\n}\n",
          functionName: "chooseNode",
          tests: [
            { args: [{ cpu: 2, memory: 4 }, [{ id: "a", cpuFree: 4, memoryFree: 8 }, { id: "b", cpuFree: 3, memoryFree: 8 }]], expected: "b", label: "tightest CPU fit" },
            { args: [{ cpu: 3, memory: 8 }, [{ id: "a", cpuFree: 4, memoryFree: 4 }, { id: "b", cpuFree: 2, memoryFree: 16 }]], expected: null, label: "no feasible node" },
            { args: [{ cpu: 1, memory: 1 }, [{ id: "b", cpuFree: 2, memoryFree: 2 }, { id: "a", cpuFree: 2, memoryFree: 2 }]], expected: "a", label: "stable tie break" },
            { args: [{ cpu: 0.5, memory: 2 }, [{ id: "x", cpuFree: 1, memoryFree: 8 }, { id: "y", cpuFree: 3, memoryFree: 1 }]], expected: "x", label: "memory filters first" }
          ]
        },
        notebook: [
          {
            title: "Read scheduler evidence",
            text: "The event stream records filter failures and placement. Pair it with the Pod requests rather than current metrics alone.",
            command: "kubectl describe pod <pod-name>\nkubectl get pod <pod-name> -o jsonpath='{.spec.containers[*].resources}'"
          },
          {
            title: "Inspect node resource accounting",
            text: "Allocated resources in describe output sum requests and limits for scheduled Pods. They are not live utilization.",
            command: "kubectl describe node <node-name> | sed -n '/Allocated resources:/,/Events:/p'"
          }
        ]
      }
    },
    {
      id: "virtualization",
      number: "06",
      title: "The virtualization stack",
      shortTitle: "Virtualization",
      duration: 82,
      color: "#6d4cc3",
      soft: "#eee8ff",
      description: "Separate guest code, KVM, userspace device models, virtio queues, hypercalls, and nested execution into their real owners.",
      outcomes: [
        "Trace VM entry, guest execution, exit, emulation, and re-entry.",
        "Separate KVM from QEMU and virtio from device passthrough.",
        "Name the added costs and constraints in nested virtualization."
      ],
      trace: ["guest userspace", "guest kernel", "KVM", "VMM", "host device"],
      lessons: [
        {
          id: "virtual-machines",
          number: "15",
          title: "What a VM is",
          duration: 13,
          summary: "A VM gives a guest kernel a virtual machine interface while the host controls CPU execution, memory, interrupts, and devices.",
          prediction: "A process inside a VM makes read(2). Does it enter the host kernel directly?",
          core: [
            "A virtual machine runs a guest operating system against virtual CPUs, memory, interrupt controllers, timers, and devices. The guest kernel believes it owns a machine interface, while the virtualization stack mediates privileged operations and resource access.",
            "Guest userspace first enters the guest kernel on a syscall. Many guest-kernel instructions execute directly on the physical CPU in a constrained guest mode. Selected operations cause a VM exit so the host kernel or userspace VMM can handle them.",
            "VM isolation adds a separate kernel boundary and can run a different kernel from the host. It also adds boot, memory, device, and management work that ordinary containers can avoid."
          ],
          mechanics: [
            { title: "Guest", text: "The operating system and workloads running against the virtual hardware contract." },
            { title: "vCPU", text: "Guest CPU state scheduled through a host thread and hardware virtualization support." },
            { title: "Guest memory", text: "Guest-physical addresses backed by host virtual memory and ultimately host physical pages." },
            { title: "VM exit", text: "A transition from guest execution to the host when an operation needs virtualization handling." }
          ],
          kernel: [
            "Address translation can involve guest virtual to guest physical mappings plus host mappings from guest physical to host physical memory. Hardware nested page tables cache the combined result but still add miss and invalidation costs.",
            "A vCPU is usually represented by a host thread. Host scheduling, cgroups, affinity, NUMA placement, and oversubscription therefore influence guest timing."
          ],
          bridge: { title: "Container versus VM", text: "An ordinary container shares the host kernel. A VM runs a guest kernel. Kata combines a container workflow with a VM boundary, which makes both models necessary." },
          failure: { title: "Boundary count", text: "A syscall inside a guest enters the guest kernel. It reaches the host only when the virtualization path requires a VM exit or host I/O." },
          visual: { type: "flow", title: "One guest instruction", nodes: [["guest process", "user"], ["guest kernel", "syscall"], ["guest mode", "direct run"], ["VM exit", "if needed"], ["host", "handle"]] },
          check: {
            question: "Which boundary is unique to a VM compared with an ordinary Linux container?",
            choices: ["A guest kernel", "A process", "A root filesystem", "A cgroup"],
            answer: 0,
            explanation: "A VM contains a guest kernel that runs against virtual hardware. Ordinary containers use the host kernel."
          },
          sources: [
            ["KVM overview", "https://docs.kernel.org/virt/kvm/index.html"],
            ["QEMU system emulation", "https://qemu.readthedocs.io/en/master/system/introduction.html"]
          ]
        },
        {
          id: "kvm",
          number: "16",
          title: "KVM",
          duration: 13,
          summary: "KVM is the Linux kernel virtualization API that creates VMs and vCPUs, maps guest memory, and runs guest CPU state.",
          prediction: "If /dev/kvm is missing, can QEMU still emulate a guest CPU with its software translator?",
          core: [
            "The KVM API starts by opening /dev/kvm. System ioctls query capabilities and create a VM file descriptor. VM ioctls register guest memory and create vCPU descriptors. The VMM maps a shared run structure and calls KVM_RUN for each vCPU.",
            "Hardware virtualization lets KVM enter guest mode while the CPU enforces the configured boundary. KVM handles architecture state and selected in-kernel devices. It does not provide a full PC or cloud device model by itself.",
            "QEMU, Firecracker, and Cloud Hypervisor are userspace VMMs that use KVM. They choose the machine model, boot path, virtual devices, API, lifecycle, and policy around the same kernel capability."
          ],
          mechanics: [
            { title: "/dev/kvm", text: "The host capability entry point. Permissions determine which processes can create hardware-assisted VMs." },
            { title: "VM fd", text: "The handle for guest memory layout and VM-wide capabilities." },
            { title: "vCPU fd", text: "The handle for registers, execution state, and KVM_RUN on one virtual CPU." },
            { title: "kvm_run", text: "Shared state reports why guest execution exited and carries data for selected exits." }
          ],
          kernel: [
            "KVM_CREATE_VM and KVM_CREATE_VCPU construct kernel objects whose lifecycle follows file-descriptor references. KVM_SET_USER_MEMORY_REGION maps guest-physical ranges onto the VMM process's userspace memory.",
            "Capability checks are part of the stable ABI. A VMM should query KVM_CAP values instead of inferring behavior only from the host kernel version."
          ],
          bridge: { title: "KVM is not the whole hypervisor process", text: "KVM owns privileged CPU and memory virtualization in the host kernel. The userspace VMM owns much of the virtual machine model and device behavior." },
          failure: { title: "Access check", text: "A present kernel module is insufficient when the process cannot read and write /dev/kvm. Containerized VMMs also need the device passed through with suitable policy." },
          codebase: {
            title: "The E2B environment checks KVM",
            text: "The upstream smoke test checks that /dev/kvm exists before integration work. The workbench command adds permission checks; neither check proves that every KVM extension is available.",
            url: "https://github.com/e2b-dev/infra/blob/main/packages/orchestrator/cmd/smoketest/smoke_test.go",
            label: "E2B KVM smoke test"
          },
          visual: { type: "flow", title: "Create one vCPU", nodes: [["open /dev/kvm", "system fd"], ["CREATE_VM", "VM fd"], ["map memory", "guest RAM"], ["CREATE_VCPU", "vCPU fd"], ["KVM_RUN", "enter guest"]] },
          check: {
            question: "Who normally provides the userspace device model around KVM?",
            choices: ["The VMM", "The Pod image", "The TLB", "The cgroup controller"],
            answer: 0,
            explanation: "A userspace VMM such as QEMU or Firecracker builds the machine and device model around KVM."
          },
          sources: [
            ["KVM API", "https://docs.kernel.org/virt/kvm/api.html"],
            ["KVM documentation index", "https://docs.kernel.org/virt/kvm/index.html"]
          ]
        },
        {
          id: "qemu",
          number: "17",
          title: "QEMU",
          duration: 13,
          summary: "QEMU can emulate a complete machine in software or pair its device model with KVM-accelerated guest CPU execution.",
          prediction: "Two commands both use qemu-system-x86_64. One uses -accel tcg and one uses -accel kvm. Are their CPU paths the same?",
          core: [
            "QEMU system emulation assembles CPUs, memory, firmware, buses, interrupt controllers, storage, networking, display devices, and management interfaces into a virtual machine model.",
            "TCG translates guest instructions in software and can run a guest architecture that differs from the host. KVM acceleration instead asks the host kernel and hardware to execute compatible guest instructions directly, with QEMU handling device and management work around it.",
            "QEMU's broad machine and device support fits general-purpose VMs, migration, debugging, unusual architectures, and device compatibility. That breadth also creates more configuration and a larger device surface than a minimal cloud VMM."
          ],
          mechanics: [
            { title: "TCG", text: "QEMU's dynamic translator executes guest instructions in software without requiring KVM." },
            { title: "KVM acceleration", text: "Compatible guest CPU work runs through KVM while QEMU remains the userspace VMM." },
            { title: "Machine type", text: "A selected virtual board defines buses, firmware expectations, and default devices." },
            { title: "Device model", text: "Emulated and paravirtualized devices turn guest requests into host operations." }
          ],
          kernel: [
            "A KVM exit can return to QEMU when userspace emulation is required. In-kernel accelerators such as irqchip or vhost can keep selected paths out of the userspace VMM.",
            "QEMU process threads remain normal host tasks. Their CPU affinity, memory backing, I/O priorities, and cgroups shape the guest's observed performance."
          ],
          bridge: { title: "QEMU plus KVM", text: "Saying QEMU or KVM as if they are interchangeable hides the useful boundary. QEMU constructs and manages the machine; KVM runs guest CPU state with kernel and hardware support." },
          failure: { title: "Emulation versus virtualization", text: "TCG can trade speed for portability and observability. KVM needs a compatible host architecture and access to virtualization hardware." },
          visual: { type: "flow", title: "Two CPU paths", nodes: [["guest instruction", "input"], ["TCG", "translate"], ["or KVM", "guest mode"], ["QEMU devices", "I/O"], ["host", "resources"]] },
          check: {
            question: "Which QEMU accelerator can run without /dev/kvm?",
            choices: ["TCG", "KVM", "VFIO", "virtio-pci"],
            answer: 0,
            explanation: "TCG translates guest instructions in software and does not require the KVM device."
          },
          sources: [
            ["QEMU introduction", "https://qemu.readthedocs.io/en/master/system/introduction.html"],
            ["QEMU invocation", "https://qemu.readthedocs.io/en/master/system/invocation.html"]
          ]
        },
        {
          id: "virtio",
          number: "18",
          title: "virtio",
          duration: 15,
          summary: "virtio defines efficient virtual devices whose guest drivers and host backends exchange buffer descriptors through shared queues.",
          prediction: "A guest has a virtio-blk driver. Does that tell you whether QEMU, Firecracker, vhost, or another backend performs the host-side I/O?",
          core: [
            "Full hardware emulation preserves compatibility but can force the VMM to mimic device quirks. Virtio instead defines devices designed for virtual environments. The guest uses a virtio frontend driver, and a backend implements the device behavior.",
            "A virtqueue describes buffers through shared descriptor structures. The driver publishes available work and may notify the device. The backend consumes descriptors, performs I/O, records used entries, and may interrupt the guest.",
            "The transport can be PCI, MMIO, or another defined mechanism. Backends can live in the VMM, in the host kernel through vhost, or in a separate vhost-user process. Virtio names the contract, not one backend location."
          ],
          mechanics: [
            { title: "Descriptor", text: "A buffer address, length, flags, and optional link to another descriptor." },
            { title: "Available state", text: "The driver publishes which descriptor chains contain new work." },
            { title: "Used state", text: "The device reports completed descriptor chains and written lengths." },
            { title: "Notification", text: "Driver kicks and device interrupts signal new work or completion, with suppression rules to reduce exits." }
          ],
          kernel: [
            "Split queues use separate descriptor, available, and used areas. Packed queues combine state into one ring with wrap counters. Memory-order rules ensure one side sees initialized descriptors before published indices.",
            "Virtio reduces device-model overhead but does not eliminate host copies, VM exits, or contention by definition. Features such as event index, indirect descriptors, batching, and vhost change the path."
          ],
          bridge: { title: "The cloud VMM common language", text: "QEMU, Firecracker, and Cloud Hypervisor all expose virtio devices, but they support different device sets, transports, hotplug behavior, and backend choices." },
          failure: { title: "Queue ownership", text: "Buffers must remain valid until the used entry returns. Publishing an index before descriptor data is visible can expose stale or partial work to the backend." },
          codebase: {
            title: "Firecracker configures virtio devices",
            text: "E2B sends block, network, and vsock configuration through the Firecracker API before starting the microVM.",
            url: "https://github.com/e2b-dev/infra/blob/main/packages/orchestrator/pkg/sandbox/fc/client.go",
            label: "E2B Firecracker client"
          },
          visual: { type: "flow", title: "One virtqueue request", nodes: [["guest driver", "descriptor"], ["available ring", "publish"], ["backend", "consume"], ["used ring", "complete"], ["guest interrupt", "reap"]] },
          check: {
            question: "What does the used ring communicate?",
            choices: ["Completed descriptor chains", "Kubernetes node scores", "Guest page tables", "cgroup limits"],
            answer: 0,
            explanation: "The device places completed work in used state so the guest driver can reclaim buffers and finish requests."
          },
          sources: [
            ["Virtio 1.3 specification", "https://docs.oasis-open.org/virtio/virtio/v1.3/virtio-v1.3.html"],
            ["QEMU virtio", "https://qemu.readthedocs.io/en/master/system/devices/virtio/index.html"]
          ]
        },
        {
          id: "hypercalls",
          number: "19",
          title: "Hypercalls and VM exits",
          duration: 12,
          summary: "A hypercall is an intentional guest request to the hypervisor; a VM exit is the broader hardware transition used for many causes.",
          prediction: "A guest accesses an emulated MMIO register and exits. Did it necessarily make a hypercall?",
          core: [
            "A syscall crosses from userspace into that operating system's kernel. A hypercall crosses from a guest into a hypervisor-defined service. Both are intentional calls through an ABI, but they target different privilege boundaries.",
            "A VM exit is a hardware transition out of guest execution. Hypercalls can cause exits, but so can MMIO, selected privileged instructions, external interrupts, debug events, and configuration choices.",
            "Paravirtual interfaces use hypercalls or related shared-memory protocols when cooperation beats pretending to be physical hardware. Timekeeping, spinlock hints, shutdown, and host communication are common examples."
          ],
          mechanics: [
            { title: "Syscall", text: "Userspace asks its current kernel for a service." },
            { title: "Hypercall", text: "Guest software asks the hypervisor for a defined paravirtual service." },
            { title: "VM exit", text: "Hardware returns control to the host for any configured exit reason." },
            { title: "MMIO", text: "Guest device access uses memory-addressed registers and may require userspace device emulation." }
          ],
          kernel: [
            "On x86 KVM, defined hypercalls use vmcall or vmmcall instruction sequences with architecture-specific register conventions. KVM can handle some operations internally or return an exit to userspace.",
            "Exit cost includes saving and restoring state, dispatching the reason, cache and predictor effects, and any userspace round trip. Hardware can accelerate specific paths, so counts and costs vary."
          ],
          bridge: { title: "Classify before optimizing", text: "Reducing hypercalls does not remove every exit. Measure exit reasons and the I/O path before choosing a device or polling change." },
          failure: { title: "Common model error", text: "Not every guest-to-host transition is a hypercall, and not every hypercall requires userspace VMM handling." },
          visual: { type: "flow", title: "Three boundaries", nodes: [["app syscall", "guest kernel"], ["guest runs", "KVM"], ["hypercall", "intentional"], ["VM exit", "hardware"], ["host/VMM", "handler"]] },
          check: {
            question: "Which statement is correct?",
            choices: ["Every VM exit is a hypercall", "Every syscall enters the host kernel", "A hypercall is one possible VM-exit cause", "Virtio never causes exits"],
            answer: 2,
            explanation: "A hypercall may cause a VM exit, while many other events can also cause exits."
          },
          sources: [
            ["Linux KVM hypercalls", "https://docs.kernel.org/virt/kvm/x86/hypercalls.html"],
            ["KVM exit API", "https://docs.kernel.org/virt/kvm/api.html"]
          ]
        },
        {
          id: "nested-virtualization",
          number: "20",
          title: "Nested virtualization",
          duration: 16,
          summary: "Nested virtualization lets a guest hypervisor run its own guests by virtualizing the hardware virtualization interface itself.",
          prediction: "A cloud VM exposes KVM to a process. Does that prove an inner guest will perform like a bare-metal KVM guest?",
          core: [
            "Nested virtualization names three levels. L0 is the real host hypervisor. L1 is a guest that acts as a hypervisor. L2 is the nested guest. Hardware exposes one real virtualization facility, so L0 must virtualize that facility for L1.",
            "An L2 event can be handled by L1, L0, or both depending on control state. Nested page translation, interrupt delivery, timers, VM-control structures, and I/O paths can add work beyond ordinary virtualization.",
            "The main benefit is capability inside a VM: CI can test hypervisors, hosted platforms can run microVMs, and tenants can control an inner virtualization layer. The costs include performance variance, harder debugging, feature gaps, and an expanded trust chain."
          ],
          mechanics: [
            { title: "L0", text: "The host hypervisor with direct access to hardware virtualization support." },
            { title: "L1", text: "The guest hypervisor whose virtualization instructions and control state are virtualized by L0." },
            { title: "L2", text: "The nested guest managed by L1 but ultimately executed and isolated through L0." },
            { title: "Nested paging", text: "Guest and host translation layers compose, increasing miss and invalidation work in some paths." }
          ],
          kernel: [
            "On Intel, nested VMX exposes virtual VMX instructions and control structures to L1. L0 merges or shadows controls so the physical CPU can run L2 safely. AMD SVM follows a related architecture with different structures.",
            "Modern hardware and KVM reduce many costs, but no honest fixed overhead percentage applies. Exit patterns, memory translation, interrupt behavior, I/O devices, and workload locality determine the result."
          ],
          bridge: { title: "Kata inside a cloud VM", text: "A Kata or Firecracker runtime inside an already virtualized Kubernetes node needs usable nested KVM support unless that node is bare metal." },
          failure: { title: "Colima is not proof", text: "KinD nodes are containers sharing the Colima guest kernel. Nested virtualization starts only when another VMM runs inside that guest with working KVM access." },
          visual: { type: "flow", title: "L2 exit ownership", nodes: [["L2 guest", "nested workload"], ["L2 exit", "reason"], ["L1 hypervisor", "virtual owner"], ["L0 KVM", "real owner"], ["hardware", "VMX/SVM"]] },
          check: {
            question: "In nested virtualization, what is L1?",
            choices: ["The physical CPU", "The guest hypervisor", "The nested guest", "The host filesystem"],
            answer: 1,
            explanation: "L1 is a guest of L0 that acts as the hypervisor for the nested L2 guest."
          },
          sources: [
            ["Running nested guests with KVM", "https://docs.kernel.org/virt/kvm/x86/running-nested-guests.html"],
            ["Nested VMX", "https://docs.kernel.org/virt/kvm/x86/nested-vmx.html"]
          ]
        }
      ],
      lab: {
        id: "virtqueue-lab",
        title: "Drive one virtual I/O request",
        kind: "virtio",
        badge: "Browser model + KVM/root extension",
        intro: "Publish descriptors, kick the backend, complete I/O, and return the used entry. Then add one nested level and inspect which exits gain another handler.",
        notebook: [
          {
            title: "Check KVM access",
            text: "This only tests the device boundary. It does not prove that every extension or nested feature is available.",
            command: "test -r /dev/kvm && test -w /dev/kvm && echo 'KVM access: yes' || echo 'KVM access: no'"
          },
          {
            title: "Check nested parameters",
            text: "Run on the Linux host. Y or 1 shows the module setting, while cloud policy can still limit useful behavior.",
            command: "cat /sys/module/kvm_intel/parameters/nested 2>/dev/null || cat /sys/module/kvm_amd/parameters/nested 2>/dev/null || echo 'nested parameter unavailable'"
          }
        ]
      }
    },
    {
      id: "cloud-vmms",
      number: "07",
      title: "Cloud VMMs and Kata",
      shortTitle: "Cloud VMMs",
      duration: 57,
      color: "#d2537a",
      soft: "#f9e5ec",
      description: "Compare a minimal microVM, a cloud-focused VMM, and a Kubernetes runtime that wraps containers in VM isolation.",
      outcomes: [
        "Choose between QEMU, Firecracker, and Cloud Hypervisor from concrete needs.",
        "Trace Firecracker's process, KVM, and minimal virtio device model.",
        "Follow a Kata Pod through containerd, the VMM, guest kernel, and agent."
      ],
      trace: ["containerd", "runtime shim", "VMM", "guest agent", "workload"],
      lessons: [
        {
          id: "firecracker",
          number: "21",
          title: "Firecracker",
          duration: 20,
          summary: "Firecracker is a KVM-based VMM that gives each process one microVM and keeps the guest machine model intentionally small.",
          prediction: "Firecracker uses KVM and virtio. Does that make it a kernel module or a userspace process?",
          core: [
            "One Firecracker process encapsulates one microVM. An API thread handles configuration, a VMM thread owns the machine and device model, and one host thread per vCPU enters KVM_RUN.",
            "The guest receives a minimal set of devices centered on virtio block, network, vsock, balloon, and limited legacy support. Host TAP devices back network interfaces, while host files or configured backends provide block storage.",
            "The jailer adds process isolation through chroot, namespaces, cgroups, privilege dropping, and resource setup. KVM supplies the virtualization boundary, while seccomp and the jailer reduce the host process's reach."
          ],
          mechanics: [
            { title: "API thread", text: "Receives host control requests and configures the microVM outside the steady I/O path." },
            { title: "VMM thread", text: "Owns the machine model, virtio devices, metadata service, and selected synchronous device work." },
            { title: "vCPU thread", text: "Runs guest CPU state through KVM and returns on exits that need host handling." },
            { title: "Jailer", text: "Prepares host restrictions and then executes Firecracker with reduced privilege and filesystem access." }
          ],
          kernel: [
            "Firecracker can rate-limit virtio block and network devices with token buckets, which addresses I/O fairness separately from vCPU cgroups. CPU templates control which processor features the guest sees.",
            "Snapshot restore can map guest memory eagerly through the kernel or register it with UFFD for an external page handler. Huge-page backing changes restore constraints and fault granularity."
          ],
          bridge: { title: "Why microVMs", text: "A small device model and direct kernel boot target fast startup and reduced guest-facing surface while retaining a guest kernel boundary." },
          failure: { title: "Host integration remains your job", text: "Firecracker does not supply a full orchestration platform or network policy. The host must configure TAP, routing, filtering, storage files, lifecycle, and supervision." },
          codebase: {
            title: "E2B configures and starts Firecracker",
            text: "The orchestrator creates files and networking, applies machine configuration and drives, then issues the instance start action.",
            url: "https://github.com/e2b-dev/infra/tree/main/packages/orchestrator/pkg/sandbox/fc",
            label: "E2B Firecracker integration"
          },
          visual: { type: "flow", title: "One Firecracker process", nodes: [["host API", "configure"], ["API thread", "control"], ["VMM thread", "devices"], ["vCPU threads", "KVM_RUN"], ["guest", "kernel + work"]] },
          check: {
            question: "Which Firecracker thread normally runs guest CPU state through KVM?",
            choices: ["API thread", "vCPU thread", "Jailer parent", "S3 worker"],
            answer: 1,
            explanation: "Each vCPU has a host thread that enters the KVM_RUN loop."
          },
          sources: [
            ["Firecracker design", "https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md"],
            ["Firecracker getting started", "https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md"],
            ["Firecracker jailer", "https://github.com/firecracker-microvm/firecracker/blob/main/docs/jailer.md"]
          ]
        },
        {
          id: "cloud-hypervisor",
          number: "22",
          title: "Cloud Hypervisor",
          duration: 17,
          summary: "Cloud Hypervisor is a Rust, KVM-based VMM for modern cloud workloads with a broader feature set than a minimal microVM model.",
          prediction: "A workload needs CPU hotplug, virtio-fs, and VFIO passthrough. Which direction fits better: a minimal fixed microVM or a cloud VMM with those device features?",
          core: [
            "Cloud Hypervisor focuses on Linux and Windows cloud guests on KVM. It shares rust-vmm components with other VMMs while pursuing general cloud VM features such as CPU, memory, and device hotplug.",
            "Its device model includes virtio block, network, fs, pmem, vsock, balloon, and console paths, with vhost-user and VFIO options. An HTTP API and command-line interface control VM lifecycle and devices.",
            "Compared with Firecracker, Cloud Hypervisor accepts more device and lifecycle scope for workloads that need resizing, filesystem sharing, hotplug, confidential-computing features, or passthrough. Compared with QEMU, it supports a narrower set of architectures and legacy devices."
          ],
          mechanics: [
            { title: "rust-vmm", text: "Shared Rust crates provide building blocks such as KVM bindings and virtio components across VMM projects." },
            { title: "Hotplug", text: "Selected CPUs, memory, disks, network devices, and passthrough devices can change after boot." },
            { title: "virtio-fs", text: "A guest filesystem client communicates with a host-side daemon through a virtio transport." },
            { title: "VFIO", text: "A physical device or virtual function can be assigned through IOMMU-isolated host interfaces." }
          ],
          kernel: [
            "Cloud Hypervisor can use io_uring or other asynchronous backends for disk I/O depending on configuration and support. Vhost-user can move a backend into another process with its own isolation and failure boundary.",
            "A smaller legacy surface than QEMU does not remove the need to secure the VMM, kernel, device backends, management API, and host integration."
          ],
          bridge: { title: "Choose by required machine contract", text: "VMM selection should start with guest, device, hotplug, migration, security, and operations requirements. Language or startup time alone is not enough." },
          failure: { title: "Feature status changes", text: "Snapshot compatibility, migration, confidential-computing support, and experimental devices change across releases. Pin a tested version and read its release notes." },
          visual: { type: "flow", title: "Cloud Hypervisor scope", nodes: [["API/CLI", "control"], ["VMM", "Rust"], ["KVM", "vCPUs"], ["virtio/vhost", "devices"], ["VFIO", "passthrough"]] },
          check: {
            question: "Which need most clearly favors Cloud Hypervisor over a minimal Firecracker machine model?",
            choices: ["A guest kernel", "Device hotplug and VFIO", "KVM acceleration", "A block device"],
            answer: 1,
            explanation: "Cloud Hypervisor targets broader cloud VM device and lifecycle needs, including hotplug and VFIO."
          },
          sources: [
            ["Cloud Hypervisor project", "https://github.com/cloud-hypervisor/cloud-hypervisor"],
            ["Cloud Hypervisor docs", "https://www.cloudhypervisor.org/docs/"],
            ["Cloud Hypervisor hotplug", "https://github.com/cloud-hypervisor/cloud-hypervisor/blob/main/docs/hotplug.md"]
          ]
        },
        {
          id: "kata-containers",
          number: "23",
          title: "Kata Containers",
          duration: 20,
          summary: "Kata integrates a lightweight VM boundary into a container runtime workflow so Kubernetes can select it through RuntimeClass.",
          prediction: "A two-container Kata Pod starts. Does Kata normally create one VM per container or one VM for the Pod sandbox?",
          core: [
            "Kata implements a containerd or CRI-compatible runtime path that creates a VM for the Pod sandbox. The configured VMM can be QEMU, Cloud Hypervisor, Firecracker, or another supported backend. A guest kernel boots inside that VM.",
            "A Kata agent runs in the guest and creates the workload containers inside the VM. The host runtime shim communicates with the agent, commonly over vsock, and carries lifecycle requests plus standard I/O between the container manager and guest.",
            "Kubernetes selects the runtime through RuntimeClass. From the control plane, the object remains a Pod. On the node, the implementation changes from host-kernel containers to containers inside a guest-kernel boundary."
          ],
          mechanics: [
            { title: "Runtime shim", text: "Connects containerd's shim API to Kata lifecycle and VMM management." },
            { title: "VMM", text: "Creates the Pod VM and supplies the configured virtual devices." },
            { title: "Kata agent", text: "Runs inside the guest and manages workload containers on behalf of the host runtime." },
            { title: "vsock", text: "Provides host-guest communication without requiring an ordinary guest network path." }
          ],
          kernel: [
            "The workload remains containerized inside the guest, so guest namespaces and cgroups can still separate processes. Host cgroups also constrain the VMM process and supporting backends.",
            "Filesystem sharing may use virtio-fs, block devices, image mechanisms, or VMM-specific choices. The exact volume and rootfs path depends on the Kata configuration and hypervisor."
          ],
          bridge: { title: "Kubernetes API, different isolation", text: "RuntimeClass lets the same Pod scheduling model choose a node runtime with a guest kernel boundary. Admission, storage, device, and observability behavior still need compatibility checks." },
          failure: { title: "Do not assume the storage crossing", text: "A CSI volume may be mounted on the host and shared into the VM, exposed as a block device, or handled another way. Prove the deployed Kata configuration before drawing the path." },
          visual: { type: "flow", title: "A Kata Pod starts", nodes: [["kubelet", "CRI"], ["Kata shim", "runtime"], ["VMM", "Pod VM"], ["Kata agent", "guest"], ["containers", "workload"]] },
          check: {
            question: "Which component runs inside the Kata guest?",
            choices: ["kube-scheduler", "Kata agent", "host kubelet", "GitHub Pages"],
            answer: 1,
            explanation: "The Kata agent runs inside the guest and manages workload containers for the host runtime."
          },
          sources: [
            ["Kata architecture", "https://github.com/kata-containers/kata-containers/blob/main/docs/design/architecture/README.md"],
            ["Kata virtualization", "https://github.com/kata-containers/kata-containers/blob/main/docs/design/virtualization.md"],
            ["Kubernetes RuntimeClass", "https://kubernetes.io/docs/concepts/containers/runtime-class/"]
          ]
        }
      ],
      lab: {
        id: "vmm-selector",
        title: "Choose the machine boundary",
        kind: "vmm-selector",
        badge: "Browser model + KVM/root extension",
        intro: "Set device, hotplug, startup, guest, and isolation needs. Compare QEMU, Firecracker, Cloud Hypervisor, ordinary runc, and Kata without hiding missing features.",
        notebook: [
          {
            title: "Inspect Firecracker's machine shape",
            text: "Use the local clone named by this course's source repo. The design document is the stable starting point for threads and devices.",
            command: "sed -n '35,170p' ~/code/open/firecracker/docs/design.md"
          },
          {
            title: "Check the Kata runtime path",
            text: "Run only on a cluster with Kata installed. The RuntimeClass name is deployment-specific.",
            command: "kubectl get runtimeclass\nkubectl get pods -A -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name,RUNTIME:.spec.runtimeClassName"
          }
        ]
      }
    },
    {
      id: "memory",
      number: "04",
      title: "Virtual memory and page faults",
      shortTitle: "Virtual memory",
      duration: 62,
      color: "#a84328",
      soft: "#ffebe7",
      description: "Translate addresses, fault pages into place, map files, and decide when larger pages or userspace fault handling earn their cost.",
      outcomes: [
        "Follow a virtual address through the TLB and page tables.",
        "Distinguish anonymous, file-backed, shared, and private mappings.",
        "Explain HugeTLB, transparent huge pages, and UFFD trade-offs."
      ],
      trace: ["virtual address", "TLB", "page table", "page fault", "physical page"],
      lessons: [
        {
          id: "memory-management",
          number: "09",
          title: "Memory management",
          duration: 17,
          summary: "Virtual memory gives each process an address space while the kernel controls which physical pages back it and when.",
          prediction: "malloc returns a large region, but RSS barely changes. Has the kernel already supplied every physical page?",
          core: [
            "A process issues virtual addresses. The CPU translates each address through page tables selected for that process. A translation lookaside buffer caches recent translations so most accesses do not walk the full table.",
            "A valid virtual range can exist without a resident physical page. The first access faults, and the kernel may allocate a zeroed anonymous page, load file data through the page cache, share an existing page, or copy a page before a private write.",
            "Under pressure, Linux reclaims clean file pages, writes dirty pages back, swaps eligible anonymous pages, compacts free space, or invokes an OOM policy when it cannot satisfy demand. Cgroup memory controls can localize much of this behavior to one workload."
          ],
          mechanics: [
            { title: "Virtual address", text: "A process-relative address that the CPU and kernel translate before reaching physical memory." },
            { title: "Page table", text: "A multi-level structure that records translations and permissions at page granularity." },
            { title: "TLB", text: "A CPU cache for translations. A miss can require several dependent memory reads for one access." },
            { title: "Page fault", text: "A synchronous exception that lets the kernel resolve a missing translation or reject an invalid access." }
          ],
          kernel: [
            "Virtual memory areas describe contiguous address ranges with common permissions and backing. Page-table entries track present state, permissions, accessed and dirty information, and architecture-specific details.",
            "Copy-on-write allows processes to share read-only physical pages after fork. The first write faults, allocates a private page, copies data, and updates the writer's page table."
          ],
          bridge: { title: "Container memory is node memory", text: "The process sees a virtual address space. The node kernel charges physical pages and page cache to cgroups, reclaims under pressure, and can kill a process when a cgroup reaches its limit." },
          failure: { title: "Allocated is not resident", text: "Virtual size, RSS, working set, page cache, and cgroup charge answer different questions. Use the metric that matches the failure path." },
          visual: { type: "flow", title: "Translate one load", nodes: [["0x7f...", "virtual"], ["TLB", "lookup"], ["page table", "walk"], ["fault handler", "if missing"], ["RAM", "physical"]] },
          check: {
            question: "What does a TLB cache?",
            choices: ["File contents", "Virtual-to-physical translations", "Kubernetes objects", "Disk blocks"],
            answer: 1,
            explanation: "The TLB caches address translations and related permissions close to the CPU."
          },
          sources: [
            ["Linux memory concepts", "https://docs.kernel.org/admin-guide/mm/concepts.html"],
            ["Linux memory management", "https://docs.kernel.org/admin-guide/mm/index.html"],
            ["Examining page tables", "https://docs.kernel.org/admin-guide/mm/pagemap.html"]
          ]
        },
        {
          id: "mmap",
          number: "10",
          title: "Memory-mapped files",
          duration: 15,
          summary: "mmap connects a virtual address range to anonymous memory, a file, or a device so ordinary loads and stores drive the access path.",
          prediction: "A process maps a 1 GiB sparse file and touches one 4 KiB page. Must 1 GiB of disk and RAM become allocated?",
          core: [
            "mmap creates a virtual memory area. With file backing, the offset inside the mapping corresponds to an offset in the file. Accesses fault pages through the kernel instead of calling read or write for each transfer.",
            "MAP_SHARED lets stores update shared page-cache pages and eventually the file. MAP_PRIVATE creates a copy-on-write view, so private modifications do not update the file. Neither mode makes durability automatic; writeback and fsync or msync semantics still matter.",
            "Mapping a sparse file separates logical size from allocated disk blocks. A page can be virtually addressable before storage space exists. On some write paths, failure to allocate backing storage can deliver SIGBUS to the process instead of a recoverable write error."
          ],
          mechanics: [
            { title: "VMA", text: "The kernel record for a contiguous virtual range with common permissions, flags, and backing." },
            { title: "MAP_SHARED", text: "Processes can observe writes through the shared mapping, and dirty pages can be written back to the file." },
            { title: "MAP_PRIVATE", text: "Reads can use file pages, while writes create private anonymous copies through faults." },
            { title: "Sparse file", text: "Logical offsets exist without physical disk extents until writes or preallocation assign them." }
          ],
          kernel: [
            "The page cache lets read and mmap paths meet on many of the same file-backed pages. A fault locates or loads the page, installs a page-table entry, and restarts the instruction.",
            "Changing or truncating a file underneath a mapping creates sharp edges. Access beyond the current mapped object can signal SIGBUS. Synchronization must cover both memory access and file lifecycle."
          ],
          bridge: { title: "A cache can be a mapping", text: "sandbox-blockstore mmaps sparse cache files with MAP_SHARED. Go slices then read and write the mapped pages while a bitmap records which blocks contain valid data." },
          failure: { title: "Node-wide blast radius", text: "The CSI daemon serves many volumes in one process. A SIGBUS from an unallocated mmap write can kill every active volume on that node, so the code preallocates storage with fallocate." },
          codebase: {
            title: "A public mmap block cache",
            text: "E2B maps a sparse cache file for read and write access, protects its lifecycle with a mutex, and records valid blocks separately.",
            url: "https://github.com/e2b-dev/infra/blob/main/packages/orchestrator/pkg/sandbox/block/cache.go",
            label: "E2B block cache"
          },
          visual: { type: "flow", title: "A store into a mapped file", nodes: [["store", "virtual address"], ["PTE", "present?"], ["page fault", "load/allocate"], ["page cache", "dirty"], ["writeback", "file blocks"]] },
          check: {
            question: "Which mapping mode keeps a process's writes out of the underlying file?",
            choices: ["MAP_SHARED", "MAP_PRIVATE", "PROT_READ", "MAP_FIXED"],
            answer: 1,
            explanation: "MAP_PRIVATE uses copy-on-write for modifications, so the file is not updated by those stores."
          },
          sources: [
            ["mmap(2)", "https://man7.org/linux/man-pages/man2/mmap.2.html"],
            ["Linux iomap buffered I/O", "https://docs.kernel.org/filesystems/iomap/operations.html"],
            ["fallocate(2)", "https://man7.org/linux/man-pages/man2/fallocate.2.html"]
          ]
        },
        {
          id: "hugepages",
          number: "11",
          title: "Huge pages",
          duration: 14,
          summary: "Larger pages extend TLB reach and shrink page-table work, but increase allocation, fragmentation, and waste risks.",
          prediction: "How many 4 KiB pages cover the same memory as one 2 MiB huge page?",
          core: [
            "A page-table entry and TLB entry cover one page. Increasing the page size lets the same number of translation entries cover more memory. One 2 MiB page spans 512 ordinary 4 KiB pages.",
            "HugeTLB uses an explicitly managed pool and hugetlbfs or mapping flags. Transparent Huge Pages let the kernel promote eligible memory without the application reserving a pool. The mechanisms have different allocation and fallback behavior.",
            "Large pages need contiguous physical memory and can waste space when only a small part is used. Compaction, pool sizing, NUMA distribution, page faults, snapshot tracking, and cgroup accounting all affect the result."
          ],
          mechanics: [
            { title: "TLB reach", text: "The bytes covered by current translation entries grow with page size, reducing misses for large working sets." },
            { title: "HugeTLB", text: "Applications consume pages from an explicitly sized pool with stricter reservation and mapping rules." },
            { title: "THP", text: "The kernel can promote eligible ranges and later split them, subject to policy and memory conditions." },
            { title: "Fragmentation", text: "Finding one contiguous large page is harder than finding many scattered base pages." }
          ],
          kernel: [
            "HugeTLB pools may be reserved at boot or adjusted later. Per-size sysfs directories expose counts. Allocation should respect NUMA policy, but insufficient contiguous memory can prevent the requested pool size.",
            "Nested paging makes translation cost more visible in VMs because guest and host translations interact. Huge backing pages can reduce page-table work, but dirty tracking or snapshot requirements may force smaller granularity."
          ],
          bridge: { title: "Kubernetes exposes huge pages as resources", text: "Pods request a page size explicitly, and the scheduler accounts for the preallocated node resource. Huge page resources cannot be overcommitted like ordinary memory requests." },
          failure: { title: "Bigger is not automatically faster", text: "Large pages can improve translation behavior or create allocation stalls and internal waste. Compare TLB misses, faults, latency, and memory use for the real workload." },
          codebase: {
            title: "Firecracker guest memory",
            text: "Firecracker can back guest memory with 2 MiB HugeTLB pages. Snapshot restore and dirty tracking add constraints that the Firecracker documentation calls out directly.",
            url: "https://github.com/firecracker-microvm/firecracker/blob/main/docs/hugepages.md",
            label: "Firecracker huge pages"
          },
          visual: { type: "flow", title: "Same memory, fewer translations", nodes: [["2 MiB range", "working set"], ["512 entries", "4 KiB"], ["or", "page size"], ["1 entry", "2 MiB"], ["trade-off", "contiguity"]] },
          check: {
            question: "What is a direct benefit of a larger page size?",
            choices: ["More Pod IPs", "Greater TLB reach", "Automatic durability", "No page faults"],
            answer: 1,
            explanation: "Each cached translation covers more bytes, so a fixed-size TLB can cover a larger working set."
          },
          sources: [
            ["Linux HugeTLB", "https://docs.kernel.org/admin-guide/mm/hugetlbpage.html"],
            ["Transparent Huge Pages", "https://docs.kernel.org/admin-guide/mm/transhuge.html"],
            ["Kubernetes huge pages", "https://kubernetes.io/docs/tasks/manage-hugepages/scheduling-hugepages/"]
          ]
        },
        {
          id: "uffd",
          number: "12",
          title: "Userfaultfd",
          duration: 16,
          summary: "UFFD lets a userspace manager receive selected page-fault events and resolve them with data or zero pages.",
          prediction: "A process faults on a registered missing page while the UFFD handler is dead. Can the faulting instruction finish by itself?",
          core: [
            "Userfaultfd moves handling for registered fault types from the normal kernel path to a userspace manager. The manager creates a UFFD object, negotiates features, registers virtual ranges, polls for events, and resolves faults through ioctls.",
            "A missing-page event reports the fault address. The manager aligns it to the page, finds the source bytes, then uses an operation such as UFFDIO_COPY or UFFDIO_ZEROPAGE. The blocked faulting thread resumes after the page becomes available.",
            "This supports live migration, post-copy restore, checkpoint systems, garbage collectors, and demand loading. It also creates a new dependency: latency and liveness of the handler now sit directly in the memory access path."
          ],
          mechanics: [
            { title: "Register", text: "The manager selects address ranges and fault modes that the UFFD object should monitor." },
            { title: "Poll", text: "Fault events arrive as readable messages on the file descriptor, which can join an event loop." },
            { title: "Resolve", text: "UFFDIO_COPY, ZEROPAGE, CONTINUE, or write-protect operations change fault state." },
            { title: "Wake", text: "The waiting thread can resume when the required page state has been installed." }
          ],
          kernel: [
            "Modern kernels can create UFFD through the syscall for permitted user-mode faults or through /dev/userfaultfd with filesystem-controlled access. Feature negotiation matters because supported events and operations vary.",
            "A handler must track remove, remap, fork, and write-protect behavior when it manages a changing address space. Fault resolution needs page-aligned ranges even when the triggering address points inside a page."
          ],
          bridge: { title: "Firecracker snapshot restore", text: "Firecracker can register guest-memory ranges, pass the UFFD and memory layout to an external handler, and let that handler supply snapshot pages as the guest touches them." },
          failure: { title: "Handler liveness is memory liveness", text: "A missing-page fault can wait forever if the external handler disappears. Production designs need supervision, timeouts around setup, and a recycle path." },
          codebase: {
            title: "E2B demand-loads guest memory",
            text: "The E2B UFFD path maps the memory layout, receives page faults, fetches the corresponding bytes, and resolves the page for Firecracker.",
            url: "https://github.com/e2b-dev/infra/tree/main/packages/orchestrator/pkg/sandbox/uffd",
            label: "E2B UFFD package"
          },
          visual: { type: "flow", title: "Fault leaves and returns", nodes: [["guest access", "missing page"], ["UFFD event", "address"], ["handler", "find bytes"], ["UFFDIO_COPY", "install page"], ["resume", "retry load"]] },
          check: {
            question: "Which operation can install source bytes into a missing UFFD-managed page?",
            choices: ["UFFDIO_COPY", "KVM_RUN", "CPUManager", "NFT_ACCEPT"],
            answer: 0,
            explanation: "UFFDIO_COPY copies userspace-provided bytes into the faulting range and resolves the missing-page fault."
          },
          sources: [
            ["Linux userfaultfd", "https://docs.kernel.org/admin-guide/mm/userfaultfd.html"],
            ["userfaultfd(2)", "https://man7.org/linux/man-pages/man2/userfaultfd.2.html"],
            ["Firecracker UFFD restore", "https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/handling-page-faults-on-snapshot-resume.md"]
          ]
        }
      ],
      lab: {
        id: "page-fault-lab",
        title: "Fault one page at a time",
        kind: "memory",
        badge: "Browser model + Linux",
        intro: "Change page size, touch virtual pages, and choose kernel or UFFD resolution. Watch TLB coverage, residency, and source I/O change.",
        codeChallenge: {
          id: "page-base",
          title: "Align a fault address",
          prompt: "Implement pageBase(address, pageSize). Return the start address of the page containing address.",
          starter: "function pageBase(address, pageSize) {\n  // Avoid bitwise operators because JS converts them to 32-bit values.\n}\n",
          functionName: "pageBase",
          tests: [
            { args: [4097, 4096], expected: 4096, label: "second 4 KiB page" },
            { args: [8191, 4096], expected: 4096, label: "last byte in page" },
            { args: [2097153, 2097152], expected: 2097152, label: "second 2 MiB page" },
            { args: [0, 4096], expected: 0, label: "zero address" }
          ]
        },
        notebook: [
          {
            title: "Compare logical and physical size",
            text: "The sparse file starts with a large logical size and almost no allocated blocks. One write allocates only a small extent.",
            command: "f=/tmp/sparse.img\ntruncate -s 1G \"$f\"\nstat -c 'logical=%s blocks=%b' \"$f\"\ndd if=/dev/zero of=\"$f\" bs=4096 count=1 conv=notrunc status=none\nstat -c 'logical=%s blocks=%b' \"$f\""
          },
          {
            title: "Inspect mappings",
            text: "Run this while a target process is active. smaps adds resident and dirty accounting to each mapping.",
            command: "sed -n '1,20p' /proc/self/maps\nsed -n '1,40p' /proc/self/smaps"
          }
        ]
      }
    },
    {
      id: "storage-io",
      number: "05",
      title: "Block devices and asynchronous I/O",
      shortTitle: "Storage + I/O",
      duration: 45,
      color: "#335f6d",
      soft: "#dfecef",
      description: "Follow bytes from filesystem offsets through block requests, userspace device handlers, and submission or completion queues.",
      outcomes: [
        "Separate block devices, filesystems, files, page cache, and object storage.",
        "Trace this codebase's CSI, ext4, NBD, mmap, and S3 path.",
        "Explain io_uring queues without promising automatic zero-copy I/O."
      ],
      trace: ["file offset", "filesystem", "block request", "device", "completion"],
      lessons: [
        {
          id: "block-devices",
          number: "13",
          title: "Block devices",
          duration: 23,
          summary: "A block device exposes addressable sectors and request semantics; a filesystem turns that space into files and directories.",
          prediction: "ext4 issues a read for logical block 900. Must the backing implementation be a physical disk?",
          core: [
            "A Linux block device accepts reads and writes at byte or sector offsets with alignment and size constraints determined by the device stack. The kernel can stack devices for partitioning, encryption, RAID, network transport, or logical volumes.",
            "A filesystem owns metadata that maps file offsets to filesystem blocks. VFS presents a common file API, while ext4 or another filesystem translates operations into page-cache work, journal updates, and block requests.",
            "NBD makes a userspace or remote implementation appear as /dev/nbdN. The kernel block layer sends protocol requests over sockets. The userspace server returns bytes or errors, while the mounted filesystem remains unaware of S3 or the Go process behind the device."
          ],
          mechanics: [
            { title: "Sector", text: "The device addressing unit exposed through the block interface, distinct from filesystem blocks and memory pages." },
            { title: "Filesystem", text: "On-disk metadata and kernel code map names and file offsets onto blocks with consistency rules." },
            { title: "NBD", text: "The kernel forwards block commands over a socket so another process can implement the device." },
            { title: "CSI", text: "Kubernetes calls a storage driver to create, publish, mount, and unpublish volumes. CSI is not the data path itself." }
          ],
          kernel: [
            "The block layer merges, splits, queues, and completes requests according to device limits and scheduling policy. Filesystem writeback and flush semantics determine when dirty data reaches durability boundaries.",
            "The NBD request header contains magic, command type, handle, offset, and length. Requests may complete out of order, so the opaque handle associates each response with its request."
          ],
          bridge: { title: "Object storage behind a block interface", text: "sandbox-blockstore resolves a virtual block to an immutable S3 build object, fills a read cache on demand, and stores changed 4 KiB blocks in a private mmap cache." },
          failure: { title: "Flush boundaries matter", text: "Acknowledging a request, dirtying a page, writing a local file, and committing an object store upload are different durability events. Name the required boundary before claiming persistence." },
          codebase: {
            title: "The 28-byte NBD request",
            text: "Dispatch decodes big-endian requests, runs supported commands concurrently, and serializes response writes on each socket.",
            url: "https://github.com/e2b-dev/infra/blob/main/packages/orchestrator/pkg/sandbox/nbd/dispatch.go",
            label: "E2B NBD dispatch"
          },
          visual: { type: "flow", title: "Read a sandbox file", nodes: [["application", "read"], ["VFS + ext4", "file to block"], ["/dev/nbdN", "kernel"], ["Go overlay", "cache or S3"], ["response", "same handle"]] },
          check: {
            question: "What does a filesystem add above a block device?",
            choices: ["Names and file-to-block metadata", "A second CPU", "A Pod IP", "A hypercall ABI"],
            answer: 0,
            explanation: "The filesystem maps names and file offsets onto block storage while maintaining metadata and consistency rules."
          },
          sources: [
            ["Linux block layer", "https://docs.kernel.org/block/index.html"],
            ["NBD protocol", "https://github.com/NetworkBlockDevice/nbd/blob/master/doc/proto.md"],
            ["CSI specification", "https://github.com/container-storage-interface/spec/blob/master/spec.md"]
          ]
        },
        {
          id: "io-uring",
          number: "14",
          title: "io_uring",
          duration: 18,
          summary: "io_uring uses shared submission and completion rings so applications can batch and coordinate asynchronous operations with fewer crossings.",
          prediction: "An application places eight reads in the submission queue. Must they complete in submission order?",
          core: [
            "An io_uring instance exposes a submission queue and a completion queue through shared mappings. Userspace prepares submission queue entries, publishes them, and tells the kernel how much work is ready. The kernel posts completion queue entries with results.",
            "Batching can reduce syscall traffic and keep multiple device requests in flight. Registered files or buffers, polling modes, linked operations, multishot requests, and fixed resources change particular costs. None of them means every operation avoids copying or blocking.",
            "The useful unit is the full workload. Queue depth can improve throughput on capable storage while increasing tail latency or CPU work. Kernel version, filesystem, page cache state, device, operation type, and cancellation behavior all matter."
          ],
          mechanics: [
            { title: "SQE", text: "One operation description, including opcode, file, buffer, offset, flags, and user_data." },
            { title: "CQE", text: "One completion result. user_data lets the application match it to its own operation state." },
            { title: "Batch", text: "Several SQEs can be published before one io_uring_enter call, reducing entry overhead." },
            { title: "Queue depth", text: "Multiple in-flight operations let hardware and the kernel overlap work, subject to contention and ordering needs." }
          ],
          kernel: [
            "The ring indices need acquire and release ordering so each side sees fully initialized entries. The kernel may complete operations inline, through worker threads, or through native asynchronous paths depending on the opcode and target.",
            "Cancellation and teardown need explicit ownership rules. A completion can race with a cancel request, and buffers must remain valid until the kernel no longer references them."
          ],
          bridge: { title: "Compare, do not conflate", text: "The local NBD handler uses blocking socket reads plus goroutines and a serialized response path. It does not use io_uring. The course places both queue models side by side." },
          failure: { title: "Asynchronous is not free", text: "Ring setup, worker creation, pinned resources, polling, and deeper queues consume CPU and memory. Measure IOPS per CPU and latency, not throughput alone." },
          visual: { type: "flow", title: "Submit and reap", nodes: [["prepare SQEs", "userspace"], ["publish tail", "release"], ["kernel consumes", "operations"], ["post CQEs", "results"], ["advance head", "userspace"]] },
          check: {
            question: "Which field commonly links a CQE back to application state?",
            choices: ["user_data", "Pod UID", "page size", "cgroup.procs"],
            answer: 0,
            explanation: "The application places an opaque user_data value in the SQE and receives it with the CQE."
          },
          sources: [
            ["io_uring(7)", "https://man7.org/linux/man-pages/man7/io_uring.7.html"],
            ["io_uring_setup(2)", "https://man7.org/linux/man-pages/man2/io_uring_setup.2.html"],
            ["io_uring project manual", "https://www.man7.org/linux/man-pages/man7/io_uring.7.html"]
          ]
        }
      ],
      lab: {
        id: "storage-path",
        title: "Trace and decode one block read",
        kind: "storage",
        badge: "Browser model + repository tests",
        intro: "Switch among buffered read, mmap fault, NBD, and io_uring paths. Keep page-cache, block-cache, and device-queue state separate.",
        codeChallenge: {
          id: "block-range",
          title: "Find touched blocks",
          prompt: "Implement blocksForRange(offset, length, blockSize). Return every block index touched by the half-open byte range.",
          starter: "function blocksForRange(offset, length, blockSize) {\n  // Return [] when length is zero.\n}\n",
          functionName: "blocksForRange",
          tests: [
            { args: [0, 4096, 4096], expected: [0], label: "one aligned block" },
            { args: [4095, 2, 4096], expected: [0, 1], label: "crosses a boundary" },
            { args: [8192, 0, 4096], expected: [], label: "empty range" },
            { args: [5000, 9000, 4096], expected: [1, 2, 3], label: "three touched blocks" }
          ]
        },
        notebook: [
          {
            title: "Run the no-root storage tests",
            text: "These exercise mmap cache behavior, overlay reads, shared fetches, and NBD dispatch without loading the kernel NBD module.",
            command: "go test ./pkg/block -run 'TestCache_WriteAndRead|TestOverlay_WriteAndRead|TestChunker_ConcurrentReadsShareFetch' -count=1\ngo test ./pkg/nbd -run 'TestDispatch_ReadCommand|TestDispatch_MultipleRequests|TestDispatch_Drain' -count=1"
          },
          {
            title: "Inspect an NBD request",
            text: "Read the protocol header fields, then match them to the decoder and response handle in the Go implementation.",
            command: "sed -n '86,180p' pkg/nbd/dispatch.go"
          }
        ]
      }
    },
    {
      id: "containers",
      number: "02",
      title: "From processes to Pods",
      shortTitle: "Processes to Pods",
      duration: 55,
      color: "#078f7e",
      soft: "#daf4ee",
      description: "Build a container from Linux controls, then follow the control plane until those controls exist on a node.",
      outcomes: [
        "Name every major ingredient in a Linux container.",
        "Map Pod, node, and cluster objects to concrete machine work.",
        "Compare cgroup v1 with the unified v2 hierarchy."
      ],
      trace: ["API object", "scheduler", "kubelet", "runtime", "process"],
      lessons: [
        {
          id: "container",
          number: "02",
          title: "What a container is",
          duration: 18,
          summary: "A container is a configured process environment, not a tiny VM and not a single kernel feature.",
          prediction: "If two containers report different hostnames, must they use different kernels?",
          core: [
            "A Linux container starts as one or more ordinary processes. The runtime chooses their root filesystem, namespaces, cgroup placement, credentials, capabilities, security filters, environment, and entry point.",
            "Namespaces change what a process can see or address. Cgroups account for and constrain resource use. Capabilities split root privileges into smaller powers. Seccomp limits system calls. LSMs such as SELinux or AppArmor can add policy. The image supplies files and metadata used to create this environment.",
            "The OCI runtime specification describes the bundle that a low-level runtime receives. A runtime such as runc reads that configuration, performs the Linux setup, and starts the configured process."
          ],
          mechanics: [
            { title: "Root filesystem", text: "Mounts and pivot_root or chroot give the process a filesystem view built from the image and runtime mounts." },
            { title: "Namespaces", text: "PID, mount, network, UTS, IPC, user, cgroup, and time namespaces isolate different kernel views." },
            { title: "Security policy", text: "Capabilities, seccomp, LSM labels, user IDs, and read-only mounts reduce what the process may do." },
            { title: "Lifecycle", text: "The runtime creates the environment, starts PID 1 for the container, reports status, and tears resources down." }
          ],
          kernel: [
            "clone and unshare create or join namespace membership. setns joins an existing namespace through a file descriptor. Mount operations prepare the rootfs, while cgroup filesystem writes place the process in a resource domain.",
            "Namespace isolation is selective. A process still reaches the shared host kernel through syscalls. Kernel attack surface and ABI compatibility therefore matter for ordinary containers."
          ],
          bridge: { title: "Image versus container", text: "The image is inert content and configuration. The container is the running process environment created from it." },
          failure: { title: "Common model error", text: "Namespaces and cgroups are necessary pieces, but they do not describe the whole container boundary. Filesystem setup and security policy matter too." },
          visual: {
            type: "flow",
            title: "Assemble the process boundary",
            nodes: [["image", "files"], ["runtime", "setup"], ["namespaces", "views"], ["cgroups", "resources"], ["process", "PID 1"]]
          },
          check: {
            question: "Which container ingredient controls the process's view of network interfaces and routes?",
            choices: ["A network namespace", "A CPU cgroup", "The image manifest", "A huge page"],
            answer: 0,
            explanation: "A network namespace owns a separate network stack view, including interfaces, routes, and firewall rules."
          },
          sources: [
            ["OCI Linux runtime configuration", "https://github.com/opencontainers/runtime-spec/blob/main/config-linux.md"],
            ["namespaces(7)", "https://man7.org/linux/man-pages/man7/namespaces.7.html"],
            ["Kubernetes containers", "https://kubernetes.io/docs/concepts/containers/"]
          ]
        },
        {
          id: "pod-node-cluster",
          number: "03",
          title: "Pod, node, and cluster",
          duration: 18,
          summary: "Kubernetes groups processes into a logical host, places that host on a machine, and reconciles the desired fleet state.",
          prediction: "Two containers share one Pod. Which resource is shared by default: the network namespace, the root filesystem, or every cgroup?",
          core: [
            "A Pod is Kubernetes' smallest schedulable unit. Its containers are co-located on one node and normally share one network namespace. Init containers, sidecars, application containers, and restart policies can give them different start, stop, and restart behavior. They can share declared volumes, but they do not merge image filesystems or become one process.",
            "A node is a physical or virtual machine that runs a kubelet, a container runtime, and node services. The control plane stores desired and observed state. The scheduler selects a node for an unscheduled Pod, then the kubelet on that node asks the runtime to make the Pod real.",
            "The runtime's Pod sandbox gives tightly coupled containers a shared context. On Linux, that usually includes a shared network namespace and a Pod-level cgroup with child container cgroups. PID namespace sharing is optional."
          ],
          mechanics: [
            { title: "Control plane", text: "The API server records objects. Controllers reconcile desired state. The scheduler binds pending Pods to nodes." },
            { title: "Kubelet", text: "The node agent watches assigned Pods and calls the Container Runtime Interface to create or remove sandboxes and containers." },
            { title: "Pod sandbox", text: "The runtime prepares shared Pod resources before it starts application containers." },
            { title: "Node kernel", text: "All ordinary containers on the node ultimately use this kernel for CPU, memory, filesystems, and networking." }
          ],
          kernel: [
            "The pause or sandbox process commonly keeps shared namespaces alive while application containers come and go. Exact process shapes depend on the runtime, but namespace file descriptors and cgroup paths remain inspectable host state.",
            "The scheduler decides placement from declared requests and policies. It does not perform per-thread CPU scheduling after placement. The Linux scheduler does that."
          ],
          bridge: { title: "The abstraction chain", text: "Pod is a control-plane and lifecycle abstraction. Namespace and cgroup objects are the node-level enforcement machinery that gives it concrete behavior." },
          failure: { title: "Common model error", text: "Containers in one Pod do not share every namespace or one flat cgroup. Network sharing is normal, PID sharing is configurable, and runtimes commonly create child cgroups." },
          codebase: {
            title: "CSI enters at the kubelet boundary",
            text: "The CSI Node service receives node-local publish and unpublish calls after scheduling. The specification defines that contract independently of one driver implementation.",
            url: "https://github.com/container-storage-interface/spec/blob/master/spec.md",
            label: "CSI specification"
          },
          visual: {
            type: "flow",
            title: "From YAML to process",
            nodes: [["API server", "desired state"], ["scheduler", "node choice"], ["kubelet", "node agent"], ["CRI runtime", "sandbox"], ["processes", "kernel tasks"]]
          },
          check: {
            question: "Who makes the final per-thread CPU choice after a Pod is running?",
            choices: ["kube-scheduler", "kubelet", "Linux CPU scheduler", "container image"],
            answer: 2,
            explanation: "Kubernetes places the Pod. The node kernel chooses which runnable thread executes on each CPU."
          },
          sources: [
            ["Kubernetes Pods", "https://kubernetes.io/docs/concepts/workloads/pods/"],
            ["Kubernetes nodes", "https://kubernetes.io/docs/concepts/architecture/nodes/"],
            ["Container Runtime Interface", "https://kubernetes.io/docs/concepts/containers/cri/"]
          ]
        },
        {
          id: "cgroups",
          number: "04",
          title: "cgroups v1 and v2",
          duration: 19,
          summary: "Cgroups organize processes into resource domains that the kernel can account for, protect, weight, and limit.",
          prediction: "A Pod requests 500m CPU and has a 1 CPU limit. Which value influences placement, and which value can throttle runtime execution?",
          core: [
            "A cgroup is a kernel-managed hierarchy of processes. Controllers attach resource behavior to that hierarchy. CPU controls distribute time, memory controls account and protect pages, cpusets constrain CPU and NUMA placement, and I/O controls shape block access.",
            "Kubernetes sends resource settings through the kubelet and container runtime. The runtime writes the matching cgroup files. CPU limits can become bandwidth quotas. Memory limits can trigger cgroup-local reclaim and OOM handling. CPU requests often influence relative weight, while the scheduler uses requests for node placement.",
            "Cgroup v1 allowed separate controller hierarchies, which made process membership and delegation hard to reason about. Cgroup v2 uses one unified hierarchy, consistent controller rules, better delegation, and newer interfaces such as memory.low, memory.high, and pressure metrics."
          ],
          mechanics: [
            { title: "Accounting", text: "Files such as cpu.stat and memory.current report consumption charged to one part of the hierarchy." },
            { title: "Distribution", text: "cpu.weight and io.weight divide contested capacity without promising exclusive hardware." },
            { title: "Protection", text: "memory.low and memory.min express best-effort or hard protection against reclaim under pressure." },
            { title: "Limits", text: "cpu.max and memory.max impose hard ceilings with different runtime behavior when the ceiling is reached." }
          ],
          kernel: [
            "In v2, a process belongs to exactly one cgroup in the unified hierarchy. Controllers enabled in cgroup.subtree_control distribute resources among children. Parent constraints remain effective below the parent.",
            "CPU quota throttling happens over periods, so a workload can use a burst and then wait even when another CPU appears idle. Memory is not throttled in the same way. Reclaim, memory.high pressure, OOM selection, and eviction policies produce different failure shapes."
          ],
          bridge: { title: "Requests are not limits", text: "The scheduler adds requests when it checks node capacity. Runtime limits become kernel controls after placement. A low request and high real usage can still create contention." },
          failure: { title: "Version boundary", text: "Do not map a v1 filename directly onto v2. The hierarchy and several controller semantics changed, even when the resource goal sounds similar." },
          codebase: {
            title: "Firecracker inside a cgroup",
            text: "E2B creates a v2 cgroup, enables controllers, and starts Firecracker inside that resource domain with CLONE_INTO_CGROUP. The linked manager does not itself write CPU or memory limits.",
            url: "https://github.com/e2b-dev/infra/tree/main/packages/orchestrator/pkg/sandbox/cgroup",
            label: "E2B cgroup manager"
          },
          visual: {
            type: "flow",
            title: "Policy becomes a kernel file",
            nodes: [["Pod spec", "requests + limits"], ["scheduler", "requests"], ["kubelet", "desired controls"], ["runtime", "cgroup writes"], ["kernel", "enforcement"]]
          },
          check: {
            question: "What is the defining hierarchy change in cgroup v2?",
            choices: ["No controllers", "One unified hierarchy", "One cgroup per CPU", "Limits move into namespaces"],
            answer: 1,
            explanation: "V2 organizes supported controllers under one unified hierarchy with consistent delegation rules."
          },
          sources: [
            ["Linux cgroup v2", "https://docs.kernel.org/admin-guide/cgroup-v2.html"],
            ["Linux cgroup v1", "https://docs.kernel.org/admin-guide/cgroup-v1/index.html"],
            ["Kubernetes cgroup v2", "https://kubernetes.io/docs/concepts/architecture/cgroups/"],
            ["Kubernetes resource management", "https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/"]
          ]
        }
      ],
      lab: {
        id: "container-builder",
        title: "Build the boundary",
        kind: "container-builder",
        badge: "Browser model + Linux",
        intro: "Turn isolation controls on one at a time. The model reports what the process can still see, consume, and change.",
        codeChallenge: {
          id: "cpu-max",
          title: "Parse cpu.max",
          prompt: "Implement parseCpuMax(value). Return Infinity for max, or quota / period as a CPU count.",
          starter: "function parseCpuMax(value) {\n  const [quota, period] = value.trim().split(/\\s+/);\n  // Return the allowed CPU count.\n}\n",
          functionName: "parseCpuMax",
          tests: [
            { args: ["max 100000"], expected: "Infinity", label: "unlimited quota" },
            { args: ["100000 100000"], expected: 1, label: "one CPU" },
            { args: ["250000 100000"], expected: 2.5, label: "fractional quota" },
            { args: ["50000 100000\n"], expected: 0.5, label: "trailing newline" }
          ]
        },
        notebook: [
          {
            title: "Inspect a disposable container",
            text: "This reads namespace identities and cgroup state without changing the host.",
            command: "docker run --rm alpine:3.20 sh -c '\n  for ns in mnt pid net uts ipc cgroup; do\n    printf \"%-8s \" \"$ns\"\n    readlink \"/proc/self/ns/$ns\"\n  done\n  cat /proc/self/cgroup\n  stat -fc \"cgroup filesystem: %T\" /sys/fs/cgroup\n'"
          },
          {
            title: "Identify the cgroup version",
            text: "cgroup2fs identifies the unified v2 hierarchy. A tmpfs root with controller mounts usually indicates v1.",
            command: "stat -fc %T /sys/fs/cgroup/\ntest ! -r /sys/fs/cgroup/cgroup.controllers || cat /sys/fs/cgroup/cgroup.controllers"
          }
        ]
      }
    },
    {
      id: "compute",
      number: "03",
      title: "CPU time, caches, and concurrency",
      shortTitle: "CPU + concurrency",
      duration: 60,
      color: "#e9a83c",
      soft: "#fff2d6",
      description: "Connect runnable tasks, cache lines, NUMA distance, and atomic progress to the latency seen by a Pod.",
      outcomes: [
        "Explain a scheduling decision without confusing it with Kubernetes placement.",
        "Predict cache and NUMA costs from where code and data run.",
        "Recognize lock-free guarantees, CAS loops, and the ABA problem."
      ],
      trace: ["runnable task", "run queue", "CPU", "cache line", "memory node"],
      lessons: [
        {
          id: "cpu-scheduling",
          number: "05",
          title: "CPU scheduling",
          duration: 16,
          summary: "The kernel chooses a runnable task for each logical CPU, then revisits that choice as tasks wake, block, and consume time.",
          prediction: "A container has a one-CPU quota but may run on eight CPUs. Can it use two CPUs at the same instant?",
          core: [
            "A task is runnable when it could execute but is waiting for a CPU. Each CPU has scheduling state and runnable work. The scheduler selects a task, runs it until a scheduling event, then accounts for the time used.",
            "Linux has multiple scheduling classes. Normal tasks use the fair-scheduling path, which is moving from the older CFS model toward EEVDF. Real-time and deadline classes follow different rules. Affinity and cpusets restrict where a task may run.",
            "A cgroup CPU quota limits time over a period. CPU weight affects how contested time is divided. Neither setting promises a dedicated physical core unless CPU Manager, cpusets, and topology policy arrange one."
          ],
          mechanics: [
            { title: "Run queue", text: "Runnable tasks wait in per-CPU scheduling structures. Wake-up and balancing logic decide which queue receives them." },
            { title: "Preemption", text: "The kernel can stop the current task so another eligible task runs, subject to scheduling-class rules." },
            { title: "Affinity", text: "A CPU mask limits eligible CPUs. It can protect locality or create a hotspot when the mask is too narrow." },
            { title: "Quota", text: "A cgroup consumes a time budget and can be throttled until the next period after that budget is exhausted." }
          ],
          kernel: [
            "EEVDF tracks whether a task is owed service through lag, then selects an eligible task with the earliest virtual deadline. This improves latency control while keeping a fair-share goal for equal-priority tasks.",
            "Migration has a cost. The task's warm cache state may not exist on the destination CPU, and a cross-NUMA move can separate execution from its memory pages. Load balancing trades fairness and utilization against locality."
          ],
          bridge: { title: "Two schedulers, two timescales", text: "kube-scheduler picks a node once per placement attempt. The Linux scheduler picks a runnable task many times per second on that node." },
          failure: { title: "Quota surprise", text: "A workload can be throttled after a burst while other machine capacity looks idle. Inspect cpu.stat and the allowed CPU mask before blaming node-wide saturation." },
          visual: { type: "flow", title: "Runnable to running", nodes: [["wake", "runnable"], ["run queue", "eligible"], ["pick", "policy"], ["CPU", "running"], ["block/preempt", "account"]] },
          check: {
            question: "Which control restricts the set of CPUs a task may run on?",
            choices: ["cpu.max", "cpuset.cpus", "memory.high", "io.weight"],
            answer: 1,
            explanation: "The cpuset controller constrains CPU placement. cpu.max limits time rather than selecting CPU IDs."
          },
          sources: [
            ["Linux scheduler docs", "https://docs.kernel.org/scheduler/index.html"],
            ["EEVDF scheduler", "https://docs.kernel.org/scheduler/sched-eevdf.html"],
            ["Kubernetes CPU Manager", "https://kubernetes.io/docs/tasks/administer-cluster/cpu-management-policies/"]
          ]
        },
        {
          id: "cpu-caches",
          number: "06",
          title: "CPU caches",
          duration: 14,
          summary: "Caches keep recently used memory close to execution, but coherence and sharing can turn one cache line into a bottleneck.",
          prediction: "Two cores update different counters that occupy one cache line. Do they avoid interference because the variables differ?",
          core: [
            "CPU cores run far faster than main memory can respond. Cache hierarchies retain copies of recently accessed cache lines. L1 is small and close to one core. Larger levels are slower and may be shared by several cores.",
            "A load checks the hierarchy before reaching memory. Hardware coherence keeps writable copies consistent across cores. When two cores repeatedly write one line, ownership moves between caches even if they touch different fields. That is false sharing.",
            "A cache hit is not a promise about application-level caches or the Linux page cache. These systems reuse the same word for different layers, sizes, replacement rules, and consistency boundaries."
          ],
          mechanics: [
            { title: "Cache line", text: "The transfer and coherence unit is larger than one variable, commonly tens of bytes on server CPUs." },
            { title: "Local hit", text: "The requested line is already in a nearby cache at a usable coherence state." },
            { title: "Coherence traffic", text: "Cores exchange ownership or invalidation messages when writable copies move between them." },
            { title: "False sharing", text: "Independent variables share one line, so unrelated writes still force ownership transfers." }
          ],
          kernel: [
            "Scheduling and affinity influence whether a task keeps warm private-cache state. Shared last-level caches can make sibling placement helpful for shared reads or harmful for capacity contention.",
            "Counters, queue heads, and locks on hot lines can serialize a multicore design through coherence even when source code contains no global mutex. Hardware performance counters can help confirm the pattern."
          ],
          bridge: { title: "Noisy neighbors below CPU usage", text: "Two Pods can each stay within quota while contending for shared cache capacity or memory bandwidth. CPU percentage alone misses this boundary." },
          failure: { title: "Measurement rule", text: "Padding and pinning can help or waste memory. Measure the workload on the target CPU topology before treating either as a default fix." },
          visual: { type: "flow", title: "One load through the hierarchy", nodes: [["load", "address"], ["L1", "closest"], ["L2", "private/shared"], ["LLC", "shared"], ["DRAM", "remote"]] },
          check: {
            question: "What makes false sharing possible?",
            choices: ["Two variables share a cache line", "Two threads share a PID", "A page is file-backed", "A Pod has two containers"],
            answer: 0,
            explanation: "Coherence tracks cache lines, so writes to separate variables can still contend when they occupy one line."
          },
          sources: [
            ["Linux sysfs cache ABI", "https://docs.kernel.org/admin-guide/abi-testing.html"],
            ["Linux memory barriers", "https://docs.kernel.org/core-api/wrappers/memory-barriers.html"],
            ["perf stat", "https://man7.org/linux/man-pages/man1/perf-stat.1.html"]
          ]
        },
        {
          id: "memory-locality",
          number: "07",
          title: "Memory locality and NUMA",
          duration: 14,
          summary: "Where a thread runs and where its pages live can matter as much as how many CPUs and bytes it receives.",
          prediction: "A thread is pinned to NUMA node 0 while most of its pages were faulted on node 1. Does CPU pinning alone restore locality?",
          core: [
            "A NUMA machine has memory attached more closely to some CPU sockets than others. Every CPU can address the machine's memory, but access latency and bandwidth depend on distance and contention.",
            "Linux usually allocates anonymous memory near the CPU that first faults each page. This first-touch behavior means initialization placement can determine later performance. Thread migration can then separate execution from those pages.",
            "Locality has several scales: data layout inside a cache line, access order across pages, CPU affinity, shared-cache topology, and NUMA placement. A change that helps one scale can hurt another."
          ],
          mechanics: [
            { title: "First touch", text: "A virtual allocation gains physical pages when accessed, often from the NUMA node local to the faulting CPU." },
            { title: "CPU affinity", text: "Pinning narrows execution placement but does not automatically move existing memory pages." },
            { title: "Memory policy", text: "bind, preferred, local, and interleave policies guide which NUMA nodes satisfy future allocations." },
            { title: "Topology manager", text: "Kubernetes can coordinate CPU, memory, huge page, and device hints for topology-sensitive Pods." }
          ],
          kernel: [
            "mbind and set_mempolicy change policies for address ranges or tasks. Page migration can move existing pages, but migration itself consumes bandwidth and may race with ongoing access.",
            "A device also has locality through its PCIe and IOMMU attachment. A Pod with a local CPU set but a remote GPU or NIC can still cross an inter-socket link on the hot path."
          ],
          bridge: { title: "Kubernetes topology", text: "CPU Manager, Memory Manager, Device Manager, and Topology Manager cooperate after node placement. Requests alone do not express every locality requirement." },
          failure: { title: "Common model error", text: "More free memory on a remote NUMA node does not make remote access free. Capacity and locality are separate scheduling dimensions." },
          visual: { type: "flow", title: "First touch decides placement", nodes: [["mmap", "virtual range"], ["thread on node 0", "first write"], ["page fault", "allocate"], ["node 0 RAM", "local"], ["later migration", "possible remote"]] },
          check: {
            question: "What often determines the initial NUMA home of an anonymous page?",
            choices: ["The container image layer", "The CPU that first faults it", "The kube-scheduler score", "The file descriptor number"],
            answer: 1,
            explanation: "Default local allocation commonly places the page near the CPU that handles its first fault."
          },
          sources: [
            ["NUMA memory policy", "https://docs.kernel.org/admin-guide/mm/numa_memory_policy.html"],
            ["Kubernetes resource managers", "https://kubernetes.io/docs/concepts/workloads/resource-managers/"],
            ["Topology Manager", "https://kubernetes.io/docs/tasks/administer-cluster/topology-manager/"]
          ]
        },
        {
          id: "lock-free",
          number: "08",
          title: "Lock-free data structures",
          duration: 16,
          summary: "Lock-free describes a system-wide progress guarantee, not an absence of coordination or a promise of lower latency.",
          prediction: "A CAS loop retries forever while other threads keep succeeding. Is the algorithm still lock-free?",
          core: [
            "A blocking algorithm may stop all progress when the thread holding a required lock stops. A lock-free algorithm guarantees that some operation completes in a finite number of system steps. One unlucky thread may still starve. Wait-free strengthens the guarantee so every operation completes within a bounded number of its own steps.",
            "Compare-and-swap reads a memory location, compares it with an expected value, and conditionally writes a replacement as one atomic operation. Algorithms build retry loops around that primitive. The loop still creates contention and cache-line traffic.",
            "Correctness needs more than atomic fields. The design must define a linearization point, obey the language memory model, reclaim removed memory safely, and handle patterns such as ABA where a value changes away and back."
          ],
          mechanics: [
            { title: "CAS", text: "Update only when the observed value still matches the expected value, otherwise retry with fresh state." },
            { title: "Linearization", text: "Each concurrent operation must appear to take effect at one point between its call and return." },
            { title: "ABA", text: "A location returns to the same visible value, hiding an intervening change from a value-only comparison." },
            { title: "Reclamation", text: "Removed nodes cannot be freed while another thread may still hold a pointer to them." }
          ],
          kernel: [
            "Atomic read-modify-write instructions coordinate through the memory hierarchy. They can force exclusive cache-line ownership and become slower under contention. Memory-order rules constrain which surrounding reads and writes may move across the atomic operation.",
            "Go's sync/atomic operations are sequentially consistent. That simplifies reasoning compared with weaker orderings, but the data structure still needs a complete correctness argument."
          ],
          bridge: { title: "Read the code before naming the technique", text: "The sandbox-blockstore atomic bitset is thread-safe but not lock-free. It uses sync.RWMutex around short bitmap operations, which is a valid and simpler choice for its workload." },
          failure: { title: "Performance claim", text: "Lock-free code can lose to a mutex through retries, cache-line bouncing, or reclamation overhead. Progress class and throughput are different properties." },
          codebase: {
            title: "A deliberately locked bitset",
            text: "The dirty-block tracker uses an RWMutex. The course uses it as a code-reading check against naming by filename or intuition.",
            url: "https://github.com/e2b-dev/infra/blob/481aa06094c7327c6e20bc56cb06ed4adbf4f749/packages/shared/pkg/atomicbitset/bitset.go",
            label: "E2B atomicbitset"
          },
          visual: { type: "flow", title: "One CAS attempt", nodes: [["load head", "expected A"], ["build next", "local work"], ["CAS", "A to B"], ["success", "linearize"], ["failure", "retry"]] },
          check: {
            question: "Which guarantee permits one thread to starve while the system keeps completing operations?",
            choices: ["Wait-free", "Lock-free", "Sequential code", "A stopped mutex holder"],
            answer: 1,
            explanation: "Lock-free guarantees system-wide progress. It does not guarantee progress for each individual operation."
          },
          sources: [
            ["Go memory model", "https://go.dev/ref/mem"],
            ["Go sync/atomic", "https://pkg.go.dev/sync/atomic"],
            ["Linux circular buffers", "https://docs.kernel.org/core-api/circular-buffers.html"]
          ]
        }
      ],
      lab: {
        id: "scheduler-workbench",
        title: "Run queues and cache warmth",
        kind: "scheduler",
        badge: "Browser model",
        intro: "Change task weights, quotas, affinity, and working sets. Run the timeline and watch throughput, throttling, and cache warmth move separately.",
        notebook: [
          {
            title: "Read scheduling state",
            text: "Run on Linux. The exact fields vary by kernel, so treat the output as evidence rather than a stable API.",
            command: "cat /proc/self/sched | sed -n '1,24p'\nprintf 'allowed CPUs: '\ngrep Cpus_allowed_list /proc/self/status"
          },
          {
            title: "Check NUMA placement",
            text: "numa_maps groups virtual areas by policy and page location when the machine exposes NUMA nodes.",
            command: "sed -n '1,16p' /proc/self/numa_maps 2>/dev/null || echo 'NUMA details unavailable'"
          }
        ]
      }
    }
  ],
  capstone: {
    id: "sandbox-incident",
    title: "Trace one sandbox incident",
    duration: 45,
    summary: "Storage latency rose after a placement change. Use scheduler, cgroup, memory, NBD, cache, and S3 evidence to locate the contested boundary.",
    metrics: [
      ["p99 read latency", "184 ms"],
      ["CPU throttled", "31%"],
      ["I/O PSI some", "22%"],
      ["S3 range reads", "+4.8x"]
    ],
    evidence: [
      { id: "scheduler", title: "Scheduler score", detail: "MostAllocated favored node-3. Its requested CPU reached 88%, while three other nodes stayed below 45%." },
      { id: "cgroup", title: "cgroup CPU", detail: "The blockstore daemon shares a node cgroup with a 2 CPU quota. cpu.stat shows burst-aligned throttling." },
      { id: "cache", title: "Read cache", detail: "Six new sandboxes use distinct build headers. Cache misses and S3 fetches rise together, while the disk watermark begins evicting idle entries." },
      { id: "nbd", title: "NBD latency", detail: "Request parsing remains fast. Completion time rises inside overlay reads waiting on shared chunk fetches." },
      { id: "memory", title: "Memory pressure", detail: "memory.events shows no OOM. PSI full stays near zero, while I/O some rises during cache fills." },
      { id: "network", title: "S3 path", detail: "Packet loss is flat. Throughput reaches the node's expected egress range during parallel cache fills." }
    ],
    hypotheses: [
      { id: "pod-network", title: "Pod network packet loss", correct: false, reason: "The network evidence shows stable loss and a saturated but expected S3 transfer path." },
      { id: "daemon-capacity", title: "Packed cold-cache work exceeds shared daemon and I/O capacity", correct: true, reason: "Placement concentrated cold builds, cache fills, daemon CPU throttling, disk pressure, and S3 reads on one node." },
      { id: "guest-oom", title: "A guest memory OOM", correct: false, reason: "The affected path is host NBD read completion, and memory evidence shows no cgroup OOM." },
      { id: "nft-rule", title: "An nftables rule rejects storage traffic", correct: false, reason: "Rejected traffic would not explain successful S3 reads, cache fills, and quota-correlated completion latency." }
    ],
    trace: [
      "scheduler placement",
      "kubelet and CSI publish",
      "ext4 on /dev/nbdN",
      "userspace NBD dispatch",
      "mmap read cache",
      "S3 range fetch",
      "cgroup and node pressure"
    ],
    mitigation: "Spread cold-build starts or score for cached-build affinity with disk headroom, then size or isolate the blockstore daemon and verify the change against NBD completion latency, CPU throttling, I/O PSI, and S3 fetch volume."
  }
};
